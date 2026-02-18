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

Token auth is automatically disabled on tailnet addresses — you rely on tailnet ACLs instead.

### TLS with Tailscale certs

Place your Tailscale-issued cert and key in `.tls/` at the project root:

```
.tls/
  your-machine.ts.net.crt
  your-machine.ts.net.key
```

The server picks them up automatically when the host is a tailnet IP. You can then open `https://your-machine.ts.net:4317`.

---

## Remote access via Cloudflare Tunnel

Run a Cloudflare tunnel pointing to the local server:

```bash
bun run dev -- --port 4317
cloudflared tunnel --url http://127.0.0.1:4317
```

Cloudflare handles TLS termination. The server stays on loopback, so no token is required on the Bun side. Use Cloudflare Access policies to lock down who can reach the tunnel.

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

Pass it via query string (`?token=MY_SECRET`) or `Authorization: Bearer MY_SECRET` header.

You can also set it via environment variable:

```bash
PI_WEB_TOKEN=MY_SECRET bun run dev -- --host 192.168.1.50 --port 4317
```

---

## Face ID (WebAuthn)

When accessing from a device that supports biometrics, the server can require Face ID / Touch ID enrollment. This is automatic — on first visit from a non-loopback host, the UI prompts enrollment. Credentials are stored in `~/.pi/agent/pi-web/faceid-credentials.json`.

Note: WebAuthn generally requires a hostname like `localhost` or a real domain; raw IPs (including Tailscale `100.x` addresses) may fail. Prefer MagicDNS hostnames like `https://your-machine.ts.net:4317`.

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
