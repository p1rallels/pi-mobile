# Runbook

## Local only

```bash
bun install
bun run dev -- --port 4317
```

Open `http://localhost:4317`.

Token auth has been removed. `PI_WEB_TOKEN`, `--token`, and `?token=` are intentionally rejected.

---

## Recommended remote access: Tailscale + Caddy mTLS

Secure-mode target:

```text
browser -> Tailscale -> Caddy requiring client cert -> pi-web on 127.0.0.1
```

Initialize config and issue the first device certificate:

```bash
bun run cli -- secure init --domain your-machine.ts.net --listen-host 100.X.X.X --device iphone --platform ios
```

If you already have a trusted server certificate/key, such as a Tailscale certificate, provide it so phones/tablets do not need to trust Caddy's internal CA. Keep it in `~/.pi-web/tls`, outside any checkout, so `git clean -x` or a deleted worktree can't take the front door down:

```bash
mkdir -m 700 -p ~/.pi-web/tls
tailscale cert --cert-file ~/.pi-web/tls/your-machine.ts.net.crt --key-file ~/.pi-web/tls/your-machine.ts.net.key your-machine.ts.net
bun run cli -- secure init --domain your-machine.ts.net --listen-host 100.X.X.X --server-cert ~/.pi-web/tls/your-machine.ts.net.crt --server-key ~/.pi-web/tls/your-machine.ts.net.key --device iphone --platform ios
```

Tailscale certificates last 90 days. Renew by re-running the same `tailscale cert` command, then restart Caddy (`launchctl kickstart -k gui/$(id -u)/dev.pi-web.caddy` under launchd).

Issue more certificates as needed, one per device:

```bash
bun run cli -- device issue pixel --platform android
bun run cli -- device issue laptop --platform macos
```

Install the generated `.p12` on the target device, then remove temporary transfer copies. The CLI writes the `.p12` password to a private `.p12.pass` file next to the bundle; keep it somewhere safe and do not commit it.

Start secure mode:

```bash
bun run cli -- doctor
bun run cli -- start
```

`pi-web start` runs doctor checks, starts pi-web on `127.0.0.1`, validates/reloads Caddy, and prints the usable URL.

### Keep it running (macOS)

On an always-on host, let launchd own pi-web and Caddy so a crash or reboot brings them back:

```bash
bun run cli -- service print     # review the generated LaunchAgents first
bun run cli -- service install   # refuses while another pi-web answers on the port
bun run cli -- service restart   # restart the server agent, e.g. after a deploy
bun run cli -- service status    # launchd state plus /health
bun run cli -- service uninstall
```

The agents live in `~/Library/LaunchAgents/dev.pi-web.server.plist` and `dev.pi-web.caddy.plist`, with logs in `~/.pi-web/logs/`. The server agent runs pi-web from the checkout that ran `install` and captures that shell's `PATH` (minus the `node_modules/.bin` entries `bun run` adds), because launchd starts agents with a bare `PATH` and the agent's bash tool needs your tools. Re-run `install` after moving the repo or changing `PATH`.

On SIGTERM (launchd stop, `kill`, Ctrl+C) pi-web aborts running turns, records every live session in `~/.pi/agent/pi-web/detached-sessions.json` and exits. After the restart, open tabs re-attach those sessions on their own unless the session file changed in the meantime.

`GET /health` reports the pi SDK version, uptime, memory, running/busy/viewer counts, and the tripwire and project trust modes.

### Working on pi-web from pi-web

The server serves `public/` straight from its checkout, so run the live server from a separate git worktree and edit the main checkout. Half-finished UI work then never reaches your phone, and testing never restarts the server you are talking through.

```bash
git worktree add --detach ../pi-web-live main              # once
(cd ../pi-web-live && bun install)                          # once, and when dependencies change
(cd ../pi-web-live && bun run cli -- service install)       # once: launchd runs the worktree
```

Deploy a new build: commit on `main`, then `git -C ../pi-web-live checkout --detach main`, run `bun install` there if `bun.lock` changed, and `bun run cli -- service restart`. A restart aborts running turns, including the one that asked for it, so make it the last step. Run `service install` only from the worktree; from the main checkout it would point launchd at your work in progress.

Without launchd, run the worktree in tmux instead (`tmux new-session -d -s piweb -c ../pi-web-live 'bun run cli -- start; exec zsh'`) and restart with Ctrl+C in that pane.

### Toggles

`pi-web config` prints and `pi-web config set <name> <value>` saves these in `~/.pi-web/config.json`; restart to apply. An env var of the same meaning wins over the file.

| Setting | Values | Env |
|---|---|---|
| `tripwire` | `on` (default) blocks critical tool calls and logs the rest, `off` inspects nothing | `PI_WEB_TRIPWIRE` |
| `project-trust` | `always` (default), `ask`, `never` for folders without a `trust.json` decision | `PI_WEB_PROJECT_TRUST` |

---

## Multi-host federation

For a small set of Tailscale machines, keep each host independently secured and add host links locally:

```bash
pi-web host add local https://local.tailnet.example.ts.net:8443
pi-web host discover
pi-web host discover --add
pi-web host list
```

The sidebar shows configured hosts. Clicking another host switches the active host inside the same page: API calls, session creation, and live SSE streams point at the selected host. There is no central gateway with command-routing access to every box.

Each host should still run its own secure setup and device allowlist. For true in-page switching, each host must allow the UI origin in its trusted origins. The `pi-web start` path includes configured host origins from `~/.pi-web/hosts.json`.

For a guided second-machine walkthrough, see `SECOND_HOST_SETUP.md`.

---

## Device certificate install notes

### iOS / iPadOS

Issue a separate certificate per device:

```bash
pi-web device issue iphone-2 --platform ios
```

Transfer the generated `.p12` via AirDrop, 1Password, or another secure channel. The `.p12.pass` file stays on the Mac unless you need to store it; read it once and type the password manually:

```bash
cat ~/.pi-web/mtls/devices/iphone-2.p12.pass
```

On the iPhone/iPad:

1. accept the AirDrop / transferred `.p12`
2. open Settings
3. tap **Profile Downloaded** near the top
4. if it is not visible, go to Settings → General → VPN & Device Management
5. tap the pi-web certificate/profile
6. tap Install
7. enter the iPhone/iPad passcode
8. enter the password from the `.p12.pass` file
9. finish installation
10. close/reopen Safari and visit the pi-web URL

When Safari says the website requires a certificate, choose/allow the installed pi-web identity if prompted. Safari then uses the installed iOS identity for mTLS.

Delete temporary `.p12` copies from Files/Downloads/AirDrop after install.

### Android

- transfer the generated `.p12` securely
- install it through Settings → Security/Privacy → Encryption & credentials
- choose a user/app/VPN certificate, not a CA certificate
- Chrome should use Android's credential store for client-certificate selection
- delete temporary `.p12` copies after install

### macOS

- import the `.p12` into Keychain Access
- Safari/Chrome can use the installed identity

### Windows

- import the `.p12` into the current user's certificate store
- Edge/Chrome can use the installed identity

### Linux

- import into the browser/NSS certificate store as needed
- browser behavior varies by distro

Avoid embedded in-app browsers for mTLS.

---

## Device management

List devices and expiry status:

```bash
bun run cli -- device list
```

Revoke a lost or retired device:

```bash
bun run cli -- device revoke iphone
```

Each device should have its own certificate. Do not share one `.p12` across phones/laptops.

---

## WebAuthn / Face ID / Touch ID

When accessing from a non-loopback host, the server requires successful WebAuthn authentication before most API routes unlock.

Remote unlock has three windows:

- an unlock session for read access (4 hours, `PI_WEB_FACEID_SESSION_MINUTES`)
- prompts, aborts, settings and take over need a check within the last 60 minutes (`PI_WEB_FACEID_COMMAND_MINUTES`)
- starting sessions, adding repos and releasing need a check within the last 15 minutes (`PI_WEB_FACEID_FRESH_MINUTES`)

The page asks when it loads, and again when you come back to it (tab, window or app) once the last check is older than the shortest of those windows, 15 minutes by default. Inside that window, switching away and back or reloading doesn't ask, and other tabs on the same browser count the same check. Phones and tablets cover the page while it's in the background so the app switcher doesn't show the session. After a cancelled check the page waits for Try again.

If a control action says fresh Face ID / Touch ID is required, the browser prompts again, and a prompt that was refused goes back into the composer.

Browser and Face ID sessions are HMAC-signed cookies keyed by `~/.pi-web/cookie-key`, so restarting pi-web keeps devices signed in. In secure mode each cookie only works with the device certificate it was issued to. Delete the key and restart to sign every device out.

First remote WebAuthn enrollment requires either:

- secure mode with an enrolled mTLS device certificate, or
- enrollment from a trusted local browser

Credentials are stored in `~/.pi/agent/pi-web/faceid-credentials.json`.

---

## Direct Tailscale binding

Direct binding to a Tailscale IP is an insecure escape hatch for private testing and requires explicit opt-in:

```bash
PI_WEB_ALLOW_DIRECT_TAILSCALE=1 bun run dev -- --host 100.X.X.X --port 4317
```

This is not the recommended secure-mode architecture because pi-web is directly reachable on the tailnet. Prefer Caddy mTLS in front of localhost-bound pi-web.

If you use a hostname that differs from the bind host, configure the trusted public origin:

```bash
PI_WEB_ALLOW_DIRECT_TAILSCALE=1 PI_WEB_PUBLIC_ORIGIN=https://your-machine.ts.net:4317 bun run dev -- --host 100.X.X.X --port 4317
```

Raw IPs may fail WebAuthn. Prefer a real hostname such as a Tailscale MagicDNS name.

---

## Cloudflare / public domains

Do not expose pi-web directly to the public internet.

If you need Cloudflare or a public domain, put a hardened front door in front of localhost-bound pi-web and require mTLS or equivalent device authentication before traffic reaches pi-web. Also ensure the origin cannot be bypassed.

For this project, the preferred path is still Tailscale + Caddy mTLS.

---

## Tripwire alerts

Tripwires run in the server-side session runtime, not in the browser attachment. Turn them off with `pi-web config set tripwire off`. Long-running sessions keep executing while the phone disconnects, and tripwire alerts continue accumulating in `~/.pi/agent/pi-web/tripwire-state.json`.

Current behavior:

- repo-external reads/searches and runaway patterns log persistent alerts
- repo-external writes/edits, host secret access, persistence attempts, destructive bash patterns, and suspicious upload or download-and-exec commands trigger a persistent critical alert and request an abort
- reconnecting browsers fetch unread alerts immediately after reattaching to a session

---

## Runtime caps

Tune live-session limits with environment variables:

```bash
PI_WEB_MAX_RUNNING_SESSIONS=24
PI_WEB_MAX_CLIENTS_PER_SESSION=8
```

---

## Troubleshooting

Run:

```bash
bun run cli -- doctor
```

Doctor checks config presence, Caddy, mTLS files, Tailscale, key permissions, tracked secret-looking files, active device registrations, and expired/soon-expiring device certificates.
