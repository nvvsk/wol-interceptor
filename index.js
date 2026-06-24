const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const { Issuer, generators } = require('openid-client');
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

const OIDC_ISSUER_URL = required('OIDC_ISSUER_URL');
const OIDC_CLIENT_ID = required('OIDC_CLIENT_ID');
const OIDC_CLIENT_SECRET = required('OIDC_CLIENT_SECRET');
const OIDC_REDIRECT_URI = required('OIDC_REDIRECT_URI');
const OIDC_ALLOWED_GROUP = required('OIDC_ALLOWED_GROUP');
const OIDC_GROUP_CLAIM = process.env.OIDC_GROUP_CLAIM || 'groups';
const OIDC_SCOPES = process.env.OIDC_SCOPES || 'openid profile email';
const SESSION_SECRET = required('SESSION_SECRET');
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || `${8 * 60 * 60 * 1000}`, 10);
const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'true') === 'true';

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

// OIDC client lifecycle. Discovery is async and the IdP can be unreachable at
// startup or fail mid-session — keep state so handlers can degrade gracefully
// instead of leaking stack traces to users.
const oidcState = {
  client: null,
  ready: false,
  lastError: null,
};

let oidcRetryTimer = null;

async function initOidc() {
  try {
    const issuer = await Issuer.discover(OIDC_ISSUER_URL);
    oidcState.client = new issuer.Client({
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
      redirect_uris: [OIDC_REDIRECT_URI],
      response_types: ['code'],
    });
    oidcState.ready = true;
    oidcState.lastError = null;
    console.log(`[oidc] discovery ok: ${issuer.issuer}`);
  } catch (err) {
    oidcState.ready = false;
    oidcState.lastError = err.message;
    console.error(`[oidc] discovery failed: ${err.message} — retrying in 30s`);
    if (oidcRetryTimer) clearTimeout(oidcRetryTimer);
    oidcRetryTimer = setTimeout(initOidc, 30_000);
  }
}

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

function extractGroups(source) {
  if (!source) return [];
  const raw = source[OIDC_GROUP_CLAIM];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return raw.split(/[,\s]+/).filter(Boolean);
  return [];
}

function isAllowed(groups) {
  return Array.isArray(groups) && groups.includes(OIDC_ALLOWED_GROUP);
}

// Treat the request as same-origin if Origin (or Referer for older clients)
// matches the canonical host we serve from. This is belt-and-braces on top of
// the SameSite=Lax cookie — without it a stolen cookie from a phishing redirect
// can't be replayed against /wake.
function isSameOrigin(req) {
  const host = req.get('Host');
  if (!host) return false;
  const proto = req.get('X-Forwarded-Proto') || req.protocol || 'https';
  const expectedOrigin = `${proto}://${host}`;
  const origin = req.get('Origin');
  if (origin) return origin === expectedOrigin;
  // Some browsers omit Origin on same-origin same-method requests — fall back
  // to Referer if it's present.
  const referer = req.get('Referer');
  if (referer) {
    try {
      const url = new URL(referer);
      return `${url.protocol}//${url.host}` === expectedOrigin;
    } catch {
      return false;
    }
  }
  return false;
}

function requireAuthHtml(req, res, next) {
  if (req.session && req.session.user) return next();
  // Stash where the user was trying to go and bounce them through SSO.
  if (req.originalUrl && req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('/auth/')) {
    req.session.returnTo = req.originalUrl;
  }
  return res.redirect('/auth/login');
}

function requireAuthJson(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ ok: false, error: 'auth_required' });
}

function requireSameOrigin(req, res, next) {
  if (isSameOrigin(req)) return next();
  return res.status(403).json({ ok: false, error: 'forbidden_origin' });
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // nginx is in front of us

app.use(
  session({
    name: 'wol.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new MemoryStore({ checkPeriod: 60 * 60 * 1000 }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIE_SECURE,
      maxAge: SESSION_TTL_MS,
    },
  })
);

// Liveness probe — must remain public so external monitors can hit it.
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// --- OIDC routes -----------------------------------------------------------

function sendSsoError(res, status, reason) {
  console.warn(`[oidc] sso-error (${reason})`);
  res.status(status).sendFile(path.join(__dirname, 'public', 'sso-error.html'));
}

app.get('/auth/login', async (req, res) => {
  if (!oidcState.ready) return sendSsoError(res, 503, 'not_ready');
  try {
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const state = generators.state();
    const nonce = generators.nonce();
    req.session.oidc = { codeVerifier, state, nonce };
    const url = oidcState.client.authorizationUrl({
      scope: OIDC_SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    res.redirect(url);
  } catch (err) {
    sendSsoError(res, 502, `login_error: ${err.message}`);
  }
});

app.get('/auth/callback', async (req, res) => {
  if (!oidcState.ready) return sendSsoError(res, 503, 'not_ready');
  const pending = req.session.oidc;
  if (!pending) return sendSsoError(res, 400, 'missing_state');
  try {
    const params = oidcState.client.callbackParams(req);
    const tokenSet = await oidcState.client.callback(OIDC_REDIRECT_URI, params, {
      code_verifier: pending.codeVerifier,
      state: pending.state,
      nonce: pending.nonce,
    });
    const claims = tokenSet.claims();

    let groups = extractGroups(claims);
    if (!isAllowed(groups) && tokenSet.access_token) {
      // Some IdPs (Entra in particular) omit groups from the id_token when
      // the user is in too many groups — fall back to userinfo before giving
      // up.
      try {
        const userinfo = await oidcState.client.userinfo(tokenSet.access_token);
        groups = extractGroups(userinfo);
      } catch (e) {
        console.warn(`[oidc] userinfo failed: ${e.message}`);
      }
    }

    if (!isAllowed(groups)) {
      console.warn(`[oidc] forbidden user sub=${claims.sub} groups=${JSON.stringify(groups)}`);
      req.session.destroy(() => {});
      return res.status(403).sendFile(path.join(__dirname, 'public', 'not-authorized.html'));
    }

    const returnTo =
      req.session.returnTo && req.session.returnTo.startsWith('/')
        ? req.session.returnTo
        : '/';

    // Drop OIDC scratch state; keep only what we need for the session.
    req.session.regenerate((err) => {
      if (err) return sendSsoError(res, 500, `regen: ${err.message}`);
      req.session.user = {
        sub: claims.sub,
        name: claims.name || claims.preferred_username || claims.email || claims.sub,
        email: claims.email || null,
      };
      res.redirect(returnTo);
    });
  } catch (err) {
    sendSsoError(res, 502, `callback_error: ${err.message}`);
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('wol.sid');
    res.json({ ok: true });
  });
});

app.get('/auth/me', requireAuthJson, (req, res) => {
  res.json({ user: req.session.user });
});

// --- Protected app routes --------------------------------------------------

app.get('/status', requireAuthJson, async (_req, res) => {
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

app.post('/wake', requireAuthJson, requireSameOrigin, async (_req, res) => {
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

// Everything else (including the wake page) requires auth — falling through
// without it triggers the SSO redirect from requireAuthHtml, which is the
// "auto-redirect to SSO" behavior the user expects. The error HTML pages
// (sso-error / not-authorized) are sent directly from the auth handlers via
// res.sendFile, so there's no public static route to leak through.
app.get('*', requireAuthHtml, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initOidc();

app.listen(PORT, () => {
  console.log(
    `wol-interceptor on :${PORT} -> ${TARGET_HOST}:${TARGET_PORT} (${TARGET_MAC}) broadcast=${BROADCAST}`
  );
});
