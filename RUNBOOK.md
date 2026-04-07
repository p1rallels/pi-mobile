# Runbook

## Local only

```bash
bun install
bun run dev -- --port 4317
```

Open `http://localhost:4317`. No token needed on loopback.

---

## Remote access via Tailscale

Bind to your Tailscale IP (the `100.x.x.x` address from `tailscale ip -4`):

```bash
bun run dev -- --host 100.X.X.X --port 4317
```

Token auth is optional on tailnet addresses. If you set `PI_WEB_TOKEN`, the app still enforces it in addition to tailnet ACLs.

For the very first remote Face ID enrollment on a tailnet host, either enroll from a trusted local browser or temporarily set `PI_WEB_TOKEN` and bootstrap once with `?token=...`. Anonymous first enrollment is blocked.

### TLS with Tailscale certs

Place your Tailscale-issued cert and key in `.tls/` at the project root:

```
.tls/
  your-machine.ts.net.crt
  your-machine.ts.net.key
```

The server picks them up automatically when the host is a tailnet IP. You can then open `https://your-machine.ts.net:4317`.

When you open a hostname that differs from the bind host, set the trusted public origin too:

```bash
PI_WEB_PUBLIC_ORIGIN=https://your-machine.ts.net:4317 bun run dev -- --host 100.X.X.X --port 4317
```

If TLS is terminated by another trusted hop in front of `pi-web`, also set `PI_WEB_TRUST_PROXY=1`.

---

## Remote access via Cloudflare Tunnel

Run a Cloudflare tunnel pointing to the local server:

```bash
bun run dev -- --port 4317
cloudflared tunnel --url http://127.0.0.1:4317
```

Cloudflare handles TLS termination. You can rely on Cloudflare Access alone, or also set `PI_WEB_TOKEN` for app-layer defense in depth.

Set the public origin so the server only trusts your Cloudflare hostname:

```bash
PI_WEB_PUBLIC_ORIGIN=https://pi.example.com PI_WEB_TRUST_PROXY=1 bun run dev -- --port 4317
cloudflared tunnel --url http://127.0.0.1:4317
```

---

## Remote access via Tailscale + Cloudflare

If you want Cloudflare in front but the server only reachable over your tailnet:

```bash
bun run dev -- --host 100.X.X.X --port 4317
cloudflared tunnel --url http://100.X.X.X:4317
```

`cloudflared` must be running on a machine inside the same tailnet. Combine Cloudflare Access policies with tailnet ACLs for defense in depth.

---

## Token auth

When binding to a non-loopback, non-tailnet address, a token is required:

```bash
bun run dev -- --host 192.168.1.50 --port 4317 --token MY_SECRET
```

For browser access, open the app once with `?token=MY_SECRET` so the server can exchange it for an HttpOnly session cookie. `Authorization: Bearer MY_SECRET` is still accepted for token-gated routes, but remote control actions also require Face ID.

You can also set it via environment variable:

```bash
PI_WEB_TOKEN=MY_SECRET bun run dev -- --host 192.168.1.50 --port 4317
```

---

## Face ID (WebAuthn)

When accessing from a non-loopback host, the server requires a successful Face ID / Touch ID authentication before most API routes unlock. First remote enrollment now requires a trusted bootstrap: either enroll from a trusted local browser, or temporarily enable `PI_WEB_TOKEN` and open the app once with `?token=...`. Credentials are stored in `~/.pi/agent/pi-web/faceid-credentials.json`.

Remote unlock is now split into two windows:

- a broader unlock session for read access
- a short freshness window for control actions like starting sessions, sending prompts, takeovers, releases, and repo edits

If a control action says fresh Face ID is required, the browser should immediately prompt again.

Note: WebAuthn generally requires a hostname like `localhost` or a real domain; raw IPs (including Tailscale `100.x` addresses) may fail. Prefer MagicDNS hostnames like `https://your-machine.ts.net:4317`.

## Tripwire alerts

Tripwires run in the server-side session runtime, not in the browser attachment. Long-running sessions keep executing while the phone disconnects, and tripwire alerts continue accumulating in `~/.pi/agent/pi-web/tripwire-state.json`.

Current behavior:

- repo-external reads/searches and runaway patterns log persistent alerts
- repo-external writes/edits, host secret access, persistence attempts, destructive bash patterns, and suspicious upload or download-and-exec commands trigger a persistent critical alert and request an abort
- reconnecting browsers fetch unread alerts immediately after reattaching to a session

## Runtime caps

Tune live-session limits with environment variables:

```bash
PI_WEB_MAX_RUNNING_SESSIONS=24
PI_WEB_MAX_CLIENTS_PER_SESSION=8
```

These cap concurrent runtime sessions and simultaneous live viewers per session. The server also applies request-size and route-level rate limits to auth and control endpoints.

---

## SDK extensions

Project/global SDK extensions (`.pi/extensions`, `~/.pi/agent/extensions`) are disabled in `pi-web` because they are arbitrary local code. The web wrapper does not load them.

---

## Tests

### Unit / golden (Bun snapshots)

```bash
bun test
```

Update snapshots:

```bash
bun test -u
```

### E2E (Playwright screenshots)

```bash
bun run test:e2e
```

Update screenshots:

```bash
bun run test:e2e -- --update-snapshots
```

### Replay fixtures (dev only)

E2E tests use deterministic replay from `public/fixtures/*.json`. Enable fixture serving:

```bash
PI_WEB_REPLAY=1 bun run dev
```

Then open e.g. `http://localhost:4317/?replay=basic`.
