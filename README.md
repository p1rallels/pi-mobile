# pi-web

Web UI for the `pi` coding agent, built on the `@mariozechner/pi-coding-agent` SDK.

`pi-web` runs the agent on whatever machine hosts the server. You connect from a trusted browser on a laptop, phone, or tablet to control and view sessions.

- Create, resume, and stream sessions live
- Stream assistant output, reasoning, and tool execution
- Switch model and thinking level mid-session
- Mobile-friendly keybar for Esc / Release / Take over / Enter
- Secure-mode CLI for reproducible startup
- Tailscale + Caddy mTLS for private-network and enrolled-device access
- Face ID / Touch ID / WebAuthn freshness checks for remote control actions
- Tripwire alerts for repo escape, secret access, persistence, destructive commands, and suspicious network patterns

SDK upstream: https://github.com/badlogic/pi-mono

## Quick start: local dev

```bash
bun install
bun run dev -- --port 4317
```

Open `http://localhost:4317`.

## Secure remote setup

Recommended remote architecture:

```text
trusted browser -> Tailscale -> Caddy with mTLS -> pi-web on 127.0.0.1
```

Initialize secure mode and issue one device certificate:

```bash
bun run cli -- secure init --domain pi.example.ts.net --listen-host 100.X.X.X
bun run cli -- device issue phone --platform ios
bun run cli -- doctor
bun run cli -- start
```

Install the generated `.p12` on the target device. Each device should get its own certificate so it can be revoked independently.

Token auth has been removed. `PI_WEB_TOKEN`, `--token`, and `?token=` are intentionally rejected.

## Data locations

| What | Path |
|------|------|
| Secure-mode config | `~/.pi-web/config.json` |
| Device registry | `~/.pi-web/devices.json` |
| mTLS material | `~/.pi-web/mtls/` |
| Sessions (JSONL) | `~/.pi/agent/sessions/` |
| Saved repos | `~/.pi/agent/pi-web/repos.json` |
| WebAuthn credentials | `~/.pi/agent/pi-web/faceid-credentials.json` |
| Tripwire alerts/read state | `~/.pi/agent/pi-web/tripwire-state.json` |

## Session semantics

- **Abort** stops the current run but keeps the session runtime alive. Never deletes JSONL.
- **Release** aborts and disposes the web runtime so you can safely resume the same JSONL in the native CLI.
- New sessions can only start from the current working directory or repos you explicitly save in the UI.

Do not open the same session in `pi-web` and the native `pi` CLI simultaneously. Use Release in the web UI before resuming in the CLI.

## Security notes

- Secure mode requires pi-web to bind to localhost behind a trusted local mTLS proxy.
- Direct non-loopback binding is only allowed for Tailscale addresses and is not the preferred secure-mode path.
- First remote WebAuthn enrollment requires secure mode with an enrolled mTLS device certificate, or enrollment from a trusted local browser.
- Non-loopback control actions require recent WebAuthn verification.
- Browser responses ship with a strict CSP and related security headers.
- The server enforces request-size, rate, and live-session caps. Tune with `PI_WEB_MAX_RUNNING_SESSIONS` and `PI_WEB_MAX_CLIENTS_PER_SESSION` if needed.

## Credits

Built on top of [pi](https://github.com/badlogic/pi-mono) by [badlogic](https://github.com/badlogic).
