# pi-web

Web UI for the `pi` coding agent, built on the `@earendil-works/pi-coding-agent` SDK.

`pi-web` runs the agent on whatever machine hosts the server. You connect from a trusted browser on a laptop, phone, or tablet to control and view sessions.

- Create, resume, and stream sessions live
- Stream assistant output, reasoning, and tool execution
- Switch model and thinking level mid-session
- Mobile-friendly keybar for Esc / Release / Take over / Enter
- Secure-mode CLI for reproducible startup
- Tailscale + Caddy mTLS for private-network and enrolled-device access
- Federated host list for switching across a few independently secured boxes
- Face ID / Touch ID / WebAuthn freshness checks for remote control actions
- Tripwire alerts for repo escape, secret access, persistence, destructive commands, and suspicious network patterns

SDK upstream: https://github.com/earendil-works/pi

## Quick start: local dev

```bash
bun install
bun run dev -- --port 4317
```

Open `http://localhost:4317`.

Checks:

```bash
bun run typecheck
bun test
bun run test:e2e
```

## Pi updates

The Pi SDK is pinned to an exact version so upstream breaking changes only land through deliberate upgrades. Refresh dynamic provider model catalogs independently of the SDK version:

```bash
bun run cli -- update --models
```

Installed copies can use `pi-web update --models`. This updates the shared Pi catalog cache in ~/.pi/agent/models-store.json, matching `pi update --models`. If a provider needs longer than Pi's 15-second default, pass `--timeout <seconds>` (maximum 300).

## Secure remote setup

Recommended remote architecture:

```text
trusted browser -> Tailscale -> Caddy with mTLS -> pi-web on 127.0.0.1
```

Initialize secure mode and issue the first device certificate:

```bash
bun run cli -- secure init --domain pi.example.ts.net --listen-host 100.X.X.X --device phone --platform ios
bun run cli -- doctor
bun run cli -- start
```

On an always-on Mac, `bun run cli -- service install` runs pi-web and Caddy as launchd agents instead. See [RUNBOOK.md](RUNBOOK.md).

If you have a trusted server certificate/key, pass `--server-cert` and `--server-key` during init. Otherwise generated Caddy config uses `tls internal`, which requires client devices to trust Caddy's local CA.

Install the generated `.p12` on the target device. Each device should get its own certificate so it can be revoked independently. On iPhone/iPad, accepting the `.p12` transfer is not enough; finish installation in Settings → Profile Downloaded or Settings → General → VPN & Device Management.

For multiple Tailscale hosts, add host links with `pi-web host add <id> <url>` or inspect suggestions with `pi-web host discover`. The sidebar can switch the active host in-page; each host still enforces its own mTLS and WebAuthn policy. See [SECOND_HOST_SETUP.md](SECOND_HOST_SETUP.md) for the guided flow.

Token auth has been removed. `PI_WEB_TOKEN`, `--token`, and `?token=` are intentionally rejected.

## Data locations

| What | Path |
|------|------|
| Secure-mode config | `~/.pi-web/config.json` |
| Device registry | `~/.pi-web/devices.json` |
| Cookie signing key | `~/.pi-web/cookie-key` |
| mTLS material | `~/.pi-web/mtls/` |
| Sessions (JSONL) | `~/.pi/agent/sessions/` |
| Saved repos | `~/.pi/agent/pi-web/repos.json` |
| WebAuthn credentials | `~/.pi/agent/pi-web/faceid-credentials.json` |
| Tripwire alerts/read state | `~/.pi/agent/pi-web/tripwire-state.json` |
| Sessions to re-attach after restart | `~/.pi/agent/pi-web/detached-sessions.json` |

## Session semantics

- **Abort** stops the current run but keeps the session runtime alive. Never deletes JSONL. Any connected device can abort.
- One device controls a session (prompts, settings, release); the others watch. **Take over** works at any time, even mid-run, and if the controlling device disconnects for 10 seconds, control moves to another connected device.
- **Release** aborts and disposes the web runtime so you can safely resume the same JSONL in the native CLI.
- Idle sessions nobody is viewing are disposed after 15 minutes (`PI_WEB_IDLE_SESSION_MINUTES`). Their JSONL is already saved, and an open tab re-attaches them on its own unless the session was released or its file changed elsewhere since.
- New sessions can only start from the current working directory or repos you explicitly save in the UI.

Do not open the same session in `pi-web` and the native `pi` CLI simultaneously. Use Release in the web UI before resuming in the CLI.

## Security notes

- Secure mode requires pi-web to bind to localhost behind a trusted local mTLS proxy.
- Direct non-loopback binding is disabled by default. A Tailscale-only testing escape hatch requires `PI_WEB_ALLOW_DIRECT_TAILSCALE=1`.
- First remote WebAuthn enrollment requires secure mode with an enrolled mTLS device certificate, or enrollment from a trusted local browser.
- Non-loopback control actions require recent WebAuthn verification: within 60 minutes for prompts, aborts and take over (`PI_WEB_FACEID_COMMAND_MINUTES`), within 10 minutes for new sessions, repo changes and release (`PI_WEB_FACEID_FRESH_MINUTES`), inside a 4 hour Face ID session (`PI_WEB_FACEID_SESSION_MINUTES`).
- Browser and Face ID sessions are HMAC-signed cookies keyed by `~/.pi-web/cookie-key` and, in secure mode, bound to the device certificate that received them. Restarts keep devices signed in; deleting the key signs every device out.
- Browser responses ship with a strict CSP and related security headers.
- The server enforces request-size, rate, and live-session caps. Tune with `PI_WEB_MAX_RUNNING_SESSIONS` and `PI_WEB_MAX_CLIENTS_PER_SESSION` if needed.

## Credits

Built on top of [pi](https://github.com/badlogic/pi-mono) by [badlogic](https://github.com/badlogic).
