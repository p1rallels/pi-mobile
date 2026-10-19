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
- Tripwire that blocks secret access, persistence, destructive commands, repo-external writes and suspicious network patterns before the tool runs, and logs repo-external reads

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

Tests never see the caller's `PI_*` env, `~/.pi/agent` or `~/.pi-web`: `bun test` preloads tests/support/preload.ts, and every server a test starts (the Playwright web server on port 4318, `PI_WEB_E2E_PORT` to change it) gets a scrubbed env and a throwaway state dir from tests/support/sandbox_env.js. Running them from inside a pi-web session is safe.

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
- A disposed session also comes back by itself, with no viewer, when msg mail lands in its inbox, so msg in it takes the mail and wakes it: an orchestrator that went idle still hears from its children. Never one that was released or `/quit`, changed elsewhere since, or that another live process runs. At the session cap it only takes the slot of an idle session nobody watches and that has no mail of its own; otherwise the mail waits.
- New sessions can only start from the current working directory or repos you explicitly save in the UI.
- On the canvas, a new tile's folder step lists the saved repos, then folders pi has sessions in that aren't saved yet (*not added*; temp folders are left out, pfs forks show as `repo · fork n-name`). Typing a `/path` or `~/path` browses the host's folders as you type: **Tab** goes into the highlighted folder, **Enter** adds it and opens it, and a name that doesn't exist yet offers **+ create folder** (exactly one new folder, only inside the home folder, no `git init`). Adding or creating a folder needs the same recent Face ID check as other repo changes.
- On the phone, **New** in the sidebar opens the same picker full screen: a folder, then a session in it, **+ new session** or **+ new terminal**. A typed path's folders get a **›** that looks inside them, like Tab.
- **/quit** as the first word of a message stops the session the way quitting pi does (its file stays, so the picker still lists it) and goes back to picking a folder: a canvas tile turns into a launcher in place, the phone opens its menu. While pi works it's refused; **Esc** stops the turn first.
- A tab that loses its event stream (network drop, phone asleep, server restart) reconnects from the last entry it rendered and only receives what it missed, including a message still streaming and tools still running.
- Extension prompts (`ctx.ui.select/confirm/input/editor`) show as dialogs on every connected device; the first answer wins. Extension statuses, text widgets and titles show in the page too.
- **Traffic between sessions** (the msg and relay pi extensions) shows in the stream as it lands, including what pi appends at turn boundaries:
  - a msg message reads as a message from another session: the sender (tap it to open that session, wherever it lives: the phone switches to it, the canvas gives it a tile), `re <id>` for a reply, *finished* or *died* for a child's last word, *you, via <session>* for one you sent with `/msg` or the msg CLI;
  - relay's notices are one line (`relay · 41% · …`, tap for the full text), and a relay reset is a context reset card (`relay #2 · context reset at 45%` and the note it left, tap for what the fresh context starts from);
  - `msg_send` shows as `→ worker: message` with what came of it (sent, the reply, no reply), `msg_wait`, `msg_list` and `relay` compactly; other extensions' messages stay a `[type] text` note.
- Project `.pi` resources follow `~/.pi/agent/trust.json` like the CLI. Folders without a saved decision follow `pi-web config set project-trust always|ask|never` (`PI_WEB_PROJECT_TRUST`): `always` (default, no prompts), `ask` (CLI-style prompt when a session opens) or `never`.
- The tripwire can be switched off with `pi-web config set tripwire off` (`PI_WEB_TRIPWIRE=off`).
- **Running elsewhere:** sessions another `pi` process is in the middle of (a terminal `pi`, a `pi -p` from a script or `pfs run --bg`) show as *running elsewhere* in the session lists, the active list included.
  - How pi-web tells: pi writes a whole entry when each message ends, so a last message that is a prompt, a tool call or a tool result means mid-turn. Its writer is a `pi` process (as `ps` lists it) working in the session's folder that started before the last write.
  - Opening one follows its file read-only as entries arrive. pi-web won't load a second copy while it runs.
  - **Esc** stops that `pi` (with its process group when it leads one, as pfs runs do); then typing or **Take over** continues the session here. The view also unlocks on its own when the turn closes, when the writer is gone (a killed `pi` writes no closing message, so its turn reads open forever), or after 30 minutes without a write.
  - Sessions that ran in a pfs fork (`<repo>/.forks/<n>`) are named `repo · fork n-name`.

Do not open the same session in `pi-web` and the native `pi` CLI simultaneously. Use Release in the web UI before resuming in the CLI. pi-web only notices the CLI mid-turn: a `pi` idle at its prompt can't be told apart from a closed one.

## Terminal tiles

On the canvas, a new tile's session step also offers **+ new terminal**: your login shell on the host serving the page, in that folder, drawn by xterm.js. Move, resize and zoom it like any tile.

- `pbcopy` in a terminal tile copies to your browser's clipboard (OSC 52), so `pbcopy < file` in one tile and **Cmd+V** in another works like it does across terminal windows. Nothing in the shell can read the clipboard back; `pbpaste` says so. (zsh only: other shells keep the host's `pbcopy`.)
- **Option+drag** selects text over programs that take the mouse, like vim with `mouse=a`.
- **Terminals lock on their own, apart from the page's 15 minute window.**
  - Opening one asks for Face ID / Touch ID right then: **+ new terminal**, **new shell** in a closed tile, and every terminal the phone opens.
  - They lock again whenever the page goes away: another tab, app or window, the phone's app switcher, a locked screen, a reload, or closing the phone's terminal. The browser can't tell the address bar or devtools from another app, so those count too.
  - A locked terminal drops its screen and its connection, and the host refuses that browser its shells until it passes a newer check. Listing and closing shells still work.
  - Click a locked tile (or Enter on it) to unlock: one check unlocks every terminal on the page, and the page too. A phone asks by itself when it comes back to an open terminal.
- A shell is killed 15 minutes after the last Face ID check on the host (`PI_WEB_FACEID_FRESH_MINUTES`), even while you're typing in it. Any check pushes that back, unlocking a terminal included, and the tile counts down its last 5 minutes with a **keep open** button (one check). A tile whose shell timed out or was closed elsewhere while it was locked says so once it's unlocked, instead of opening a new shell in its place.
- The red dot closes the shell, asking first when something other than the shell runs in it (vim, ssh). `exit` closes the tile.
- Shells live only in the server's memory and pi-web keeps no record of what goes in or out (the shell still writes its own history file, as in any terminal); a restart or deploy ends them. A reloaded page gets each screen back exactly; after a restart a tile opens a new shell in the same folder.
- **On the phone** a terminal opens full screen: **+ new terminal** in the menu, or the sidebar's **Terminals**, which also lists the host's running shells (the canvas's included) to pick back up. A key bar adds what the iOS keyboard lacks: esc, a sticky ctrl, tab, arrows and paste. **select** shows the screen and scrollback as text to select or copy, ‹ goes back and leaves the shell running, × closes it.
  - iOS lets a page copy only during a tap or a key press, so `pbcopy` copies when you hit return on a line that runs it. When it can't (`pbcopy` inside a script, a copy that took over 15 seconds) a **tap to copy** bar shows up instead.
- In secure mode a terminal never gets the loopback pass other routes have, so processes on the host (an agent's bash, say) can't reach a shell through `127.0.0.1`. The tripwire also treats `~/.pi-web` (cookie key, device registry) as a secret.
- Turn terminal tiles off with `pi-web config set terminals off` (`PI_WEB_TERMINALS=off`).

## Security notes

- Secure mode requires pi-web to bind to localhost behind a trusted local mTLS proxy.
- Direct non-loopback binding is disabled by default. A Tailscale-only testing escape hatch requires `PI_WEB_ALLOW_DIRECT_TAILSCALE=1`.
- First remote WebAuthn enrollment requires secure mode with an enrolled mTLS device certificate, or enrollment from a trusted local browser.
- Non-loopback control actions require recent WebAuthn verification: within 60 minutes for prompts, aborts and take over (`PI_WEB_FACEID_COMMAND_MINUTES`), within 15 minutes for new sessions, repo changes and release (`PI_WEB_FACEID_FRESH_MINUTES`), inside a 4 hour Face ID session (`PI_WEB_FACEID_SESSION_MINUTES`). The page locks again when you come back to it after the shortest of those windows, not on every tab or app switch; on a laptop it waits for Unlock instead of popping the passkey sheet, which would block every Chrome tab. Terminals lock on every switch (see [Terminal tiles](#terminal-tiles)).
- Browser and Face ID sessions are HMAC-signed cookies keyed by `~/.pi-web/cookie-key` and, in secure mode, bound to the device certificate that received them. Restarts keep devices signed in; deleting the key signs every device out.
- Browser responses ship with a strict CSP and related security headers.
- The server enforces request-size, rate, and live-session caps. Tune with `PI_WEB_MAX_RUNNING_SESSIONS`, `PI_WEB_MAX_CLIENTS_PER_SESSION` and `PI_WEB_CLIENT_SESSIONS_PER_MINUTE` (browser session handshakes per client IP, default 20) if needed.

## Credits

Built on top of [pi](https://github.com/badlogic/pi-mono) by [badlogic](https://github.com/badlogic).
