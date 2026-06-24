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
- **OIDC-gated.** Every request that touches state goes through SSO.
  Unauthenticated visitors are auto-redirected — no "sign in" button to
  click. Access is restricted to a single group (e.g. `NVVSK CSM Admins`);
  members outside the group land on a friendly "no access" page, and the
  `/wake` API rejects anything without a valid session cookie *and* a
  same-origin Origin/Referer header.
- **Configured entirely via env vars.** Drop-in for any single WoL target.
- **No persistent state.** In-memory only (sessions included); restarts
  cleanly. Restart logs out everyone — by design.

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

| Variable             | Default                          | Description                                                                  |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| `PORT`               | `9494`                           | HTTP port the interceptor listens on                                         |
| `TARGET_HOST`        | _(required)_                     | IP / hostname of the WoL target                                              |
| `TARGET_PORT`        | `443`                            | TCP port used to detect "is it up?"                                          |
| `TARGET_MAC`         | _(required)_                     | MAC address of the target NIC                                                |
| `TARGET_LABEL`       | `device`                         | Friendly name used in the wake page UI                                       |
| `WOL_BROADCAST`      | `255.255.255.255`                | Broadcast address for the magic packet                                       |
| `OIDC_ISSUER_URL`    | _(required)_                     | OIDC issuer URL (e.g. `https://login.microsoftonline.com/<tenant>/v2.0`)     |
| `OIDC_CLIENT_ID`     | _(required)_                     | OIDC application / client ID                                                 |
| `OIDC_CLIENT_SECRET` | _(required)_                     | OIDC application client secret                                               |
| `OIDC_REDIRECT_URI`  | _(required)_                     | Exact callback URL registered with the IdP, e.g. `https://wake.nvvsk.com/auth/callback` |
| `OIDC_ALLOWED_GROUP` | _(required)_                     | Group required for access (e.g. `NVVSK CSM Admins`). Must match a value in the configured group claim — either the display name or the group object ID, depending on what your IdP emits. |
| `OIDC_GROUP_CLAIM`   | `groups`                         | Name of the claim to read group membership from. Use `roles` for Entra app-role assignments. |
| `OIDC_SCOPES`        | `openid profile email`           | OAuth scopes requested at sign-in                                            |
| `SESSION_SECRET`     | _(required)_                     | Long random string used to sign the session cookie. Rotate to log everyone out. |
| `COOKIE_SECURE`      | `true`                           | Set to `false` only for HTTP localhost testing                               |
| `SESSION_TTL_MS`     | `28800000` (8h)                  | Session lifetime in ms                                                       |

### Notes on the group claim

Microsoft Entra ID emits group **object IDs** in the `groups` claim by
default — not display names. Either:

1. Configure the app registration to emit group **names** via optional
   claims (and ensure the directory has the names synced), then set
   `OIDC_ALLOWED_GROUP` to `"NVVSK CSM Admins"`. Or
2. Look up the group's object ID in Entra and set `OIDC_ALLOWED_GROUP` to
   that GUID.

Option 2 is more reliable. Use whichever your app config actually returns.

A sample `ecosystem.config.js` for [pm2](https://pm2.keymetrics.io/) is
included. Copy it, fill in your values, and:

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup     # follow the printed command to enable on boot
```

Or run directly:

```bash
TARGET_HOST=10.0.0.20 \
TARGET_MAC=AA:BB:CC:DD:EE:FF \
OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant>/v2.0 \
OIDC_CLIENT_ID=<app-id> \
OIDC_CLIENT_SECRET=<secret> \
OIDC_REDIRECT_URI=https://wake.nvvsk.com/auth/callback \
OIDC_ALLOWED_GROUP="NVVSK CSM Admins" \
SESSION_SECRET=$(openssl rand -hex 32) \
node index.js
```

### Registering the app with Entra ID

1. **App registration → Redirect URIs** → add
   `https://wake.nvvsk.com/auth/callback` (Web platform).
2. **Certificates & secrets** → create a client secret. Set
   `OIDC_CLIENT_SECRET`.
3. **Token configuration → Add groups claim** → pick "Security groups" (or
   your preferred groupMembershipClaims setting). This makes `groups`
   appear in the ID token.
4. **API permissions** → `openid`, `profile`, `email`. Grant admin consent.
5. Pick a group: ensure `OIDC_ALLOWED_GROUP` matches what the IdP actually
   sends (object ID by default; see "Notes on the group claim" below).

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

| Method | Path              | Auth        | Purpose                                                             |
| ------ | ----------------- | ----------- | ------------------------------------------------------------------- |
| `GET`  | `/`               | required    | Wake page (HTML). Unauthenticated → 302 to `/auth/login`            |
| `GET`  | `/status`         | required    | JSON: `{ up, phase, sinceWakeMs, arp, ... }`                        |
| `POST` | `/wake`           | required *  | Sends WoL magic packet. Also requires same-origin `Origin`/`Referer`|
| `GET`  | `/auth/login`     | public      | Starts OIDC code flow. Failure → friendly "sign-in unavailable" page|
| `GET`  | `/auth/callback`  | public      | OIDC redirect URI. Validates group membership.                      |
| `POST` | `/auth/logout`    | public      | Destroys the session                                                |
| `GET`  | `/auth/me`        | required    | JSON: `{ user: { sub, name, email } }`                              |
| `GET`  | `/healthz`        | public      | `ok` — for monitoring                                               |

\* `/wake` is the only state-changing endpoint and gets two layers of
defense: a valid session cookie (which requires having completed the SSO
flow and being in the allowed group) **and** a same-origin `Origin` or
`Referer` header. A scripted caller hitting the URL directly without first
loading the page in a browser gets `403 forbidden_origin` even if it
somehow stole a cookie.

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
