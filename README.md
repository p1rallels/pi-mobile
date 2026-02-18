# pi-mobile

<video src="piwebdemo.mp4" autoplay loop muted playsinline width="400"></video>

Web UI for the `pi` coding agent, built on the `@mariozechner/pi-coding-agent` SDK.

`pi-mobile` runs the agent on whatever machine hosts the server. You connect from any device (laptop, phone, tablet) to control and view sessions through a browser.

- Create, resume, and stream sessions live (reasoning, tool calls, output)
- Stream assistant output, reasoning, and tool execution live
- Switch model and thinking level mid-session
- Mobile-friendly: keybar for Esc / Release / Take over / Enter, slide-out sidebar
- **Tailscale** — bind to your tailnet IP, auto-TLS with MagicDNS, no token needed
- **Cloudflare Tunnels** — expose securely with `cloudflared`, Cloudflare Access for auth
- **Face ID / Touch ID** — WebAuthn enrollment for biometric access control on remote

SDK upstream: https://github.com/badlogic/pi-mono


https://github.com/user-attachments/assets/f21f9abf-23e5-43a1-9ef4-40ec70940e78


Sessions are JSONL on disk, same location as the native `pi` CLI.
 
## Quick start

```bash
bun install
bun run dev -- --port 4317
```

Open `http://localhost:4317`.

Note: Face ID (WebAuthn) generally requires a hostname like `localhost` or a real domain; raw IPs like `127.0.0.1` may fail.

See the Runbook (RUNBOOK.md) for Tailscale, Cloudflare, and token auth setup.

## Data locations

| What | Path |
|------|------|
| Sessions (JSONL) | `~/.pi/agent/sessions/` |
| Saved repos | `~/.pi/agent/pi-web/repos.json` |
| Face ID credentials | `~/.pi/agent/pi-web/faceid-credentials.json` |

## Session semantics

- **Abort** stops the current run but keeps the session runtime alive. Never deletes JSONL.
- **Release** aborts and disposes the web runtime so you can safely resume the same JSONL in the native CLI (no concurrent writers).

Do not open the same session in `pi-web` and the native `pi` CLI simultaneously. Use Release in the web UI before resuming in the CLI.

## Credits

Built on top of [pi](https://github.com/badlogic/pi-mono) by [badlogic](https://github.com/badlogic).
