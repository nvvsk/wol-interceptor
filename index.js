const express = require('express');
const dgram = require('dgram');
const net = require('net');
const path = require('path');
const { exec } = require('child_process');

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[fatal] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const PORT = parseInt(process.env.PORT || '9494', 10);
const TARGET_HOST = required('TARGET_HOST');
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '443', 10);
const TARGET_MAC = required('TARGET_MAC').toLowerCase();
const TARGET_LABEL = process.env.TARGET_LABEL || 'device';
const BROADCAST = process.env.WOL_BROADCAST || '255.255.255.255';

const TCP_PROBE_TIMEOUT_MS = 1500;
const WAKE_GRACE_MS = 90_000;         // 0–90s after WoL: normal wake window
const OFFLINE_THRESHOLD_MS = 180_000; // >180s with no ARP/TCP: declare offline
const WAKE_ABANDON_MS = 10 * 60_000;  // >10min: forget the attempt; reset UI to idle

// In-memory wake state. Single-process, single-target — resets on restart,
// which is the right semantics.
const wakeState = {
  lastWakeAt: 0,          // ms epoch of most recent /wake
  lastWakeOutcome: null,  // 'pending' | 'success' | 'no_response'
};

function buildMagicPacket(mac) {
  const macBytes = mac.split(/[:-]/).map((b) => parseInt(b, 16));
  if (macBytes.length !== 6 || macBytes.some(Number.isNaN)) {
    throw new Error(`Invalid MAC: ${mac}`);
  }
  const packet = Buffer.alloc(102);
  packet.fill(0xff, 0, 6);
  for (let i = 1; i <= 16; i++) {
    for (let j = 0; j < 6; j++) {
      packet[i * 6 + j] = macBytes[j];
    }
  }
  return packet;
}

function sendWol(mac, broadcast) {
  return new Promise((resolve, reject) => {
    const packet = buildMagicPacket(mac);
    const sock = dgram.createSocket('udp4');
    sock.once('error', (err) => {
      sock.close();
      reject(err);
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      // Fire to both standard WoL ports — UDP/9 is canonical, UDP/7 is the
      // fallback some older NICs prefer.
      let pending = 2;
      const done = (err) => {
        if (err) {
          sock.close();
          return reject(err);
        }
        if (--pending === 0) {
          sock.close();
          resolve();
        }
      };
      sock.send(packet, 0, packet.length, 9, broadcast, done);
      sock.send(packet, 0, packet.length, 7, broadcast, done);
    });
  });
}

function tcpProbe(host, port, timeoutMs = TCP_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
    sock.connect(port, host);
  });
}

// Probe the kernel ARP / neighbor cache. A populated MAC means the target NIC
// is alive on the wire (even if its web service isn't ready yet) — that's the
// "is it booting?" signal. Linux-only; degrades to {present: null} on macOS or
// anywhere `ip neigh` isn't available.
function arpProbe(host) {
  return new Promise((resolve) => {
    // Trigger an ARP request via a single ICMP. We don't care about the ping
    // result, only that the kernel updates its neighbor cache.
    exec(`ping -c 1 -W 1 ${host}`, { timeout: 2000 }, () => {
      exec(`ip neigh show ${host}`, { timeout: 1000 }, (err, stdout) => {
        if (err) return resolve({ present: null, state: 'unknown' });
        const line = (stdout || '').trim();
        if (!line) return resolve({ present: false, state: 'absent' });
        const hasMac = /lladdr\s+[0-9a-f:]+/i.test(line);
        const state = line.split(/\s+/).pop();
        resolve({ present: hasMac, state, raw: line });
      });
    });
  });
}

function computePhase({ up, arpPresent, sinceWakeMs }) {
  if (up) return 'up';
  if (sinceWakeMs == null) return 'idle';
  if (sinceWakeMs < WAKE_GRACE_MS) return 'waking';
  // After the grace window, ARP becomes the discriminator.
  if (arpPresent === true) return 'waking_slow'; // booting but web not ready
  if (sinceWakeMs >= OFFLINE_THRESHOLD_MS) return 'likely_offline';
  return 'waking_slow';
}

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.get('/status', async (_req, res) => {
  const up = await tcpProbe(TARGET_HOST, TARGET_PORT);
  let sinceWakeMs = wakeState.lastWakeAt
    ? Date.now() - wakeState.lastWakeAt
    : null;

  // Forget stale wake attempts so the UI stops showing red forever. After
  // the abandon window, /status returns phase: 'idle' until the user
  // explicitly triggers another /wake.
  if (!up && sinceWakeMs != null && sinceWakeMs > WAKE_ABANDON_MS) {
    wakeState.lastWakeAt = 0;
    wakeState.lastWakeOutcome = null;
    sinceWakeMs = null;
  }

  // Only run the ARP probe when needed to disambiguate state — avoids spawning
  // `ping`/`ip` every 3 seconds when the target is up or idle.
  let arp = { present: null, state: 'skipped' };
  if (!up && sinceWakeMs != null && sinceWakeMs >= WAKE_GRACE_MS) {
    arp = await arpProbe(TARGET_HOST);
  }

  const phase = computePhase({ up, arpPresent: arp.present, sinceWakeMs });

  if (up && wakeState.lastWakeOutcome === 'pending') {
    wakeState.lastWakeOutcome = 'success';
  }
  if (
    !up &&
    wakeState.lastWakeOutcome === 'pending' &&
    sinceWakeMs >= OFFLINE_THRESHOLD_MS
  ) {
    wakeState.lastWakeOutcome = 'no_response';
  }

  res.json({
    up,
    phase,
    sinceWakeMs,
    label: TARGET_LABEL,
    host: TARGET_HOST,
    port: TARGET_PORT,
    arp,
    wake: {
      lastAt: wakeState.lastWakeAt || null,
      outcome: wakeState.lastWakeOutcome,
    },
  });
});

app.post('/wake', async (_req, res) => {
  try {
    await sendWol(TARGET_MAC, BROADCAST);
    wakeState.lastWakeAt = Date.now();
    wakeState.lastWakeOutcome = 'pending';
    console.log(`[wake] magic packet -> ${TARGET_MAC} via ${BROADCAST}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[wake] failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Anything else (since nginx routes the original URL through @wake) lands on
// the wake page.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(
    `wol-interceptor on :${PORT} -> ${TARGET_HOST}:${TARGET_PORT} (${TARGET_MAC}) broadcast=${BROADCAST}`
  );
});
