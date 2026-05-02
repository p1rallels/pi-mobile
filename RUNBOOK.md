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

If you already have a trusted server certificate/key, such as a Tailscale certificate, provide it so phones/tablets do not need to trust Caddy's internal CA:

```bash
bun run cli -- secure init --domain your-machine.ts.net --listen-host 100.X.X.X --server-cert .tls/your-machine.ts.net.crt --server-key .tls/your-machine.ts.net.key --device iphone --platform ios
```

Issue more certificates as needed, one per device:

```bash
bun run cli -- device issue pixel --platform android
bun run cli -- device issue laptop --platform macos
```

Install the generated `.p12` on the target device, then remove temporary transfer copies. Keep the `.p12` password somewhere safe.

Start secure mode:

```bash
bun run cli -- doctor
bun run cli -- start
```

`pi-web start` runs doctor checks, starts pi-web on `127.0.0.1`, validates/reloads Caddy, and prints the usable URL.

---

## Device certificate install notes

### iOS / iPadOS

- transfer the generated `.p12` via AirDrop, 1Password, or another secure channel
- tap/install it as a profile/identity certificate
- Safari uses the installed iOS identity when Caddy requests a client certificate
- delete temporary `.p12` copies after install

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

List devices:

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

Remote unlock has two windows:

- a broader unlock session for read access
- a short freshness window for control actions like starting sessions, sending prompts, takeovers, releases, and repo edits

If a control action says fresh Face ID / Touch ID is required, the browser should prompt again.

First remote WebAuthn enrollment requires either:

- secure mode with an enrolled mTLS device certificate, or
- enrollment from a trusted local browser

Credentials are stored in `~/.pi/agent/pi-web/faceid-credentials.json`.

---

## Direct Tailscale binding

Direct binding to a Tailscale IP still works for local/private testing:

```bash
bun run dev -- --host 100.X.X.X --port 4317
```

This is not the recommended secure-mode architecture because pi-web is directly reachable on the tailnet. Prefer Caddy mTLS in front of localhost-bound pi-web.

If you use a hostname that differs from the bind host, configure the trusted public origin:

```bash
PI_WEB_PUBLIC_ORIGIN=https://your-machine.ts.net:4317 bun run dev -- --host 100.X.X.X --port 4317
```

Raw IPs may fail WebAuthn. Prefer a real hostname such as a Tailscale MagicDNS name.

---

## Cloudflare / public domains

Do not expose pi-web directly to the public internet.

If you need Cloudflare or a public domain, put a hardened front door in front of localhost-bound pi-web and require mTLS or equivalent device authentication before traffic reaches pi-web. Also ensure the origin cannot be bypassed.

For this project, the preferred path is still Tailscale + Caddy mTLS.

---

## Tripwire alerts

Tripwires run in the server-side session runtime, not in the browser attachment. Long-running sessions keep executing while the phone disconnects, and tripwire alerts continue accumulating in `~/.pi/agent/pi-web/tripwire-state.json`.

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

Doctor checks config presence, Caddy, mTLS files, Tailscale, key permissions, tracked secret-looking files, and active device registrations.
