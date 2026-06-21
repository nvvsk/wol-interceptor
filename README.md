# wol-interceptor

A small nginx fallback that wakes a Wake-on-LAN device on demand.

When your origin (NAS, lab server, anything WoL-capable) is asleep or
powered off, nginx normally returns a 502/504. This service intercepts that
failure, shows the user a friendly "Wake up" page, sends a WoL magic packet
on click, and reloads back to the real origin once it answers — at which
point nginx proxies straight through and the gateway sits idle.

```
        ┌──────────┐    awake     ┌─────────┐
client ─▶│  nginx   │ ───────────▶│ origin  │
        └──────────┘              └─────────┘
              │  asleep / unreachable
              ▼
        ┌──────────────────┐    POST /wake (WoL)    ┌─────────┐
        │  wake-gateway    │ ────────────────────── ▶│ origin  │
        │  (this service)  │                         └─────────┘
        └──────────────────┘
```

## Features

- **Transparent when origin is up.** nginx proxies directly; the gateway
  isn't on the request path. Zero overhead.
- **Friendly wake page.** Dark, single-file HTML. Auto-polls and reloads
  when the origin comes back.
- **Distinguishes "asleep" from "actually offline."** Tracks wake attempts
  server-side and probes the OS ARP/neighbor cache after the normal wake
  window. If the device's NIC never shows up on the wire, the UI escalates
  to a "device unreachable" state instead of spinning forever.
- **Configured entirely via env vars.** Drop-in for any single WoL target.
- **No persistent state.** In-memory only; restarts cleanly.

## Requirements

- Node.js 18+
- nginx in front of the origin
- The gateway host must be on the same L2 broadcast domain as the WoL
  target (otherwise broadcast packets won't reach it)
- WoL must be enabled on the target device's NIC and OS

## Install

```bash
git clone <repo> wol-interceptor
cd wol-interceptor
npm install --omit=dev
```

## Configuration

All settings are environment variables:

| Variable        | Default            | Description                                       |
| --------------- | ------------------ | ------------------------------------------------- |
| `PORT`          | `9494`             | HTTP port the interceptor listens on              |
| `TARGET_HOST`   | _(required)_       | IP / hostname of the WoL target                   |
| `TARGET_PORT`   | `443`              | TCP port used to detect "is it up?"               |
| `TARGET_MAC`    | _(required)_       | MAC address of the target NIC                     |
| `TARGET_LABEL`  | `device`           | Friendly name used in the wake page UI            |
| `WOL_BROADCAST` | `255.255.255.255`  | Broadcast address for the magic packet            |

A sample `ecosystem.config.js` for [pm2](https://pm2.keymetrics.io/) is
included. Copy it, fill in your values, and:

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup     # follow the printed command to enable on boot
```

Or run directly:

```bash
TARGET_HOST=10.0.0.20 TARGET_MAC=AA:BB:CC:DD:EE:FF node index.js
```

## nginx integration

Replace the `location /` block in your existing site with the pattern in
`nginx-example.conf`. The core idea:

```nginx
upstream origin           { server 10.0.0.20:443 max_fails=1 fail_timeout=2s; }
upstream wol_interceptor  { server 127.0.0.1:9494; }

server {
    listen 443 ssl http2;
    server_name example.com;

    proxy_connect_timeout 3s;

    location / {
        proxy_pass https://origin;
        proxy_intercept_errors on;
        error_page 502 503 504 = @wake;
    }

    location @wake {
        add_header Cache-Control "no-store" always;
        proxy_pass http://wol_interceptor;
    }
}
```

`proxy_connect_timeout 3s` controls how fast the fallback kicks in on a
cold hit.

## Endpoints

| Method | Path        | Purpose                                       |
| ------ | ----------- | --------------------------------------------- |
| `GET`  | `/`         | Wake page (HTML)                              |
| `GET`  | `/status`   | JSON: `{ up, phase, sinceWakeMs, arp, ... }`  |
| `POST` | `/wake`     | Sends WoL magic packet to the configured MAC  |
| `GET`  | `/healthz`  | `ok` — for monitoring                         |

### Phases returned by `/status`

| Phase             | When                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `up`              | TCP probe to `TARGET_HOST:TARGET_PORT` succeeds                                             |
| `idle`            | No recent wake attempt; origin not responding                                               |
| `waking`          | Within 90s of a wake — normal wake window                                                   |
| `waking_slow`     | 90s–180s after wake, NIC is on the wire (ARP positive) — still booting                      |
| `likely_offline`  | >180s after wake with no ARP response — device appears powered off                          |

## Notes

- The ARP probe uses Linux `ip neigh`. On macOS the field is omitted and
  the gateway falls back to pure-timing detection — useful only when
  running on Linux in front of the actual deployment.
- `255.255.255.255` is the limited broadcast and works on a flat network.
  If your gateway host has multiple interfaces, prefer the subnet's
  directed broadcast (e.g. `10.0.0.255`) so the OS picks the right NIC.
- WoL must be enabled on the target's NIC firmware *and* OS power
  settings — many devices ship with one or the other turned off.
- The service holds no persistent state. Restarting it just resets the
  wake-attempt timer; it doesn't lose anything.

## License

MIT
