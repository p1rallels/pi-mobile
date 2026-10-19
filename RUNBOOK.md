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
bun run cli -- service restart   # restart the server agent (inside pi-web: scripts/deploy-live)
bun run cli -- service status    # launchd state plus /health
bun run cli -- service uninstall
```

The agents live in `~/Library/LaunchAgents/dev.pi-web.server.plist` and `dev.pi-web.caddy.plist`, with logs in `~/.pi-web/logs/`. The server agent runs pi-web from the checkout that ran `install` and captures that shell's `PATH` (minus the `node_modules/.bin` entries `bun run` adds), because launchd starts agents with a bare `PATH` and the agent's bash tool needs your tools. Re-run `install` after moving the repo or changing `PATH`.

On SIGTERM (launchd stop, `kill`, Ctrl+C) pi-web aborts running turns, records every live session in `~/.pi/agent/pi-web/detached-sessions.json` and exits. After the restart, open tabs re-attach those sessions on their own unless the session file changed in the meantime. Records of sessions that open read-only now (subs, and sessions whose folder is gone) are dropped at the start and at every idle sweep: `[pi-web] forgot <id> for re-attach: its folder is gone` (or `it's a sub, which pi-web only shows`).

The idle sweep runs every minute (a quarter of `PI_WEB_IDLE_SESSION_MINUTES` when that's shorter, fractions allowed), the first one right at the start. It reads msg's presence records once (`sessions/` in msg's store: a readdir and the files that changed), then:

- disposes sessions idle that long that nobody watches and no sub counts on: `[pi-web] disposed idle session <id>`. A sub counts on its parent until it ends, or for 5 minutes past its last heartbeat when it crashed or hung, so the parent's msg gets to say it died.
- brings back, with no viewer, detached sessions a sub counts on (after a restart, so msg in them watches their subs again), at most 4 per sweep: `[pi-web] reopened <id> for its subs`. Once per reason it says why one stays down: `not reopening <id> for its subs: its file changed since pi-web disposed it`, `… pid N runs it`, `… it opens read-only`, `no room to reopen <id> for its subs: …` (it tries again next sweep), `could not reopen <id> for its subs: …` (not again this server run).

Sessions pi-web disposed (idle, at the cap, at a restart) also come back by themselves when msg mail lands for them. Every 3 seconds pi-web lists `inbox/<id>/new/` for each of them in msg's store (`$PI_MSG_DIR`, else `$PI_CODING_AGENT_DIR/msg`, else `~/.pi/agent/msg`; startup prints the path), starting with mail that came while it was down, and resumes at most 4 per look with no viewer; msg in the session then takes the mail. pi-web only reads the store. At the cap a reopen only takes the slot of an idle unwatched session without mail of its own, otherwise the mail waits. The log has `[pi-web] reopened <id> for msg mail`, `[pi-web] disposed idle session <id> to make room for msg mail`, and once per newest message why one wasn't reopened: `not reopening … its file changed`, `… pid N runs it`, `no room to reopen …`, `could not reopen …`. The same mail reopens a session once per server run. A sub or a session whose folder is gone never comes back for mail; its record is dropped: `[pi-web] not reopening <id> for msg mail: it's a sub, which pi-web only shows; forgot it for re-attach`.

`GET /health` reports the pi SDK version, uptime, memory, running/busy/viewer counts, `waitingSessions` (idle, kept loaded while a sub of theirs counts; they don't count as busy, so they never hold a deploy up), and the tripwire and project trust modes.

### Toggles

`pi-web config` prints and `pi-web config set <name> <value>` saves these in `~/.pi-web/config.json`; restart to apply. An env var of the same meaning wins over the file.

| Setting | Values | Env |
|---|---|---|
| `tripwire` | `on` (default) blocks critical tool calls and logs the rest, `off` inspects nothing | `PI_WEB_TRIPWIRE` |
| `project-trust` | `always` (default), `ask`, `never` for folders without a `trust.json` decision | `PI_WEB_PROJECT_TRUST` |
| `terminals` | `on` (default) offers terminal tiles on the canvas, `off` turns them off | `PI_WEB_TERMINALS` |

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

The page locks when it loads, and again when you come back to it (tab, window or app) once the last check is older than the shortest of those windows, 15 minutes by default. Inside that window, switching away and back or reloading doesn't lock it, and other tabs on the same browser count the same check. A locked page swallows keystrokes, so nothing underneath acts until it's unlocked.

- Laptops never start a check by themselves, because Chrome on macOS attaches the passkey sheet to the whole window and blocks every tab until it's answered. Press Unlock (or Enter) when you want in.
- Phones and tablets ask right away, and cover the page while it's in the background so the app switcher doesn't show the session.
- After a cancelled check the page waits for Try again.

If a control action says fresh Face ID / Touch ID is required, the browser prompts again, and a prompt that was refused goes back into the composer.

Terminal tiles have a lock of their own on top of those windows:

- Opening a terminal asks for a check right then.
- The terminals lock whenever the page goes away (another tab, app or window, a locked screen, a reload, closing the phone's terminal). The page tells the host (`POST /api/terminals/lock`), which closes that browser's terminal connections and refuses to open or attach to a shell until the browser passes a newer check. Listing and closing shells don't need one.
- One check unlocks every terminal on the page, and the page too. Laptops wait for a click on a locked tile; phones ask by themselves when they come back to an open terminal.
- A shell ends 15 minutes after the last check on the host (`PI_WEB_FACEID_FRESH_MINUTES`), whatever runs in it; any check, unlocking included, pushes that back. The tile's **keep open** button in the last 5 minutes is one more check.

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
PI_WEB_IDLE_SESSION_MINUTES=15     # fractions allowed: 0.05 sweeps a test server every 750ms
```

At the cap a new session takes the slot of the least recently active idle session nobody watches, never one a sub counts on; with none, it's refused (`too_many_active_sessions`).

---

## Working on pi-web from pi-web

The server serves `public/` straight from its checkout, so the live server runs from a separate git worktree and you edit the main checkout. Half-finished UI work then never reaches your phone, and testing never restarts the server you are talking through.

```bash
git worktree add --detach ../pi-web-live main              # once
(cd ../pi-web-live && bun install)                          # once; deploys reinstall when bun.lock changes
(cd ../pi-web-live && bun run cli -- service install)       # once: launchd runs the worktree
```

Run `service install` only from the worktree; from the main checkout it would point launchd at your work in progress. Without launchd, run the worktree in tmux instead (`tmux new-session -d -s piweb -c ../pi-web-live 'bun run cli -- start; exec zsh'`) and restart with Ctrl+C in that pane.

### Deploying

Run `scripts/deploy-live [commit]` from the main checkout. The commit defaults to `HEAD` and can come from any branch, since the worktree runs a detached commit. A restart aborts running turns, including the one that asked for it, so the script queues itself in tmux and returns right away. The queued run waits until no session is mid-turn, then:

1. checks the commit out in `../pi-web-live`
2. runs `bun install --frozen-lockfile` there if `package.json` or `bun.lock` changed
3. restarts the service and waits for a new server process to answer `/health`
4. if none does within 90 seconds, puts back the commit that was live and restarts that

- A session still mid-turn after 10 minutes gets cut off; `PI_WEB_DEPLOY_MAX_WAIT=0` waits as long as it takes.
- The log is `/tmp/pi-web-deploy.log`, and `--dry-run` shows what a deploy would do.
- Deploying the commit that is already live just restarts it, so this is also the safe way to restart.
- What's live: `git -C ../pi-web-live log -1 --oneline` and `curl -s 127.0.0.1:4317/health`.
- After a restart, the sessions that were running come back on their own. A session nobody ever sent a message to is gone, and its tile or page starts fresh in the same folder. Parents whose subs still count come back right away with nobody watching (`[pi-web] reopened <id> for its subs` in the log), so their msg reports a sub that dies meanwhile.
- A restart ends every terminal tile's shell (and whatever runs in it, ssh included); `terminals` in `/health` counts them. Their tiles open new shells in the same folders.
- Open pages keep the old frontend until you reload them. A reload doesn't touch running sessions, which run on the host, but it drops unsent composer text.
- Without launchd, check the commit out in the worktree yourself, or give the script a restart command in `PI_WEB_DEPLOY_RESTART`.

### Tests and dev servers

Shells inside a pi-web session inherit the live server's `PI_WEB_*` settings. Run anything that starts a server, a test suite, Playwright or the mock UI through `scripts/sandbox`. It starts the command with a scrubbed environment and throwaway `PI_CODING_AGENT_DIR` and `PI_WEB_HOME` directories, so nothing reads or writes `~/.pi/agent` or `~/.pi-web`.

```bash
scripts/sandbox bun run typecheck
scripts/sandbox bun test                  # one file: scripts/sandbox bun test tests/x.test.ts
scripts/sandbox bun run test:e2e          # one test: scripts/sandbox bunx playwright test tests/e2e/x.e2e.js --project=chromium -g "name"
scripts/sandbox bun run mock              # the fake-data UI shell on :8787
```

Dev ports are 4318 (e2e), 4321 (e2e's mock UI), 4319 (a manual sandbox server), 8787 (mock UI), and anything from 4320 up. 4317, 8443 and 2019 belong to the live server and Caddy.

Playwright reuses whatever server answers on its port, another checkout's too. So in a pfs fork, whose run gets its own block of 10 ports in `$PORT` (anything but 4317, 4318, 4321, 8443 and 2019), the same commands default to that block: the state dir is `$TMPDIR/pi-web-sandbox-$PORT`, e2e runs on `$PORT` and its mock UI on `$PORT`+1. Put a manual sandbox server on `$PORT`+2 or above. `PI_WEB_SANDBOX_DIR`, `PI_WEB_E2E_PORT` and `PI_WEB_E2E_MOCK_PORT` still win when set. The main checkout (no `$PORT`) keeps the ports above.

### Rules for agents working inside pi-web

You are most likely talking to the user through the live server, so a restart ends your own turn and every other session's.

- Deploy only when the user asks for it. Then, with the checks passing and everything committed, run `scripts/deploy-live` as the last tool call of your turn, and reply. The deploy goes out once your turn is over. Tell the user three things: whether another session is mid-turn (`busySessions` in `/health` counts yours too), that open tabs need a reload once it's live (copy unsent drafts first), and where the log is.
- The live worktree changes only through `scripts/deploy-live`. Never edit, build, `bun install` or run git in it by hand, and never run `launchctl` or `pi-web service|start|secure|config|device|host` yourself. Leave `~/.pi-web`, `~/Library/LaunchAgents` and the Caddyfile alone.
- Never kill processes by name (`pkill`, `killall`, `kill $(pgrep bun)`): the live server is a bun process. Only kill pids you started, or tmux sessions on your own socket.
- Run tests and servers only through `scripts/sandbox`, and never bind or kill anything on 4317, 8443 or 2019.
- Don't read or print `~/.pi/agent/auth.json`, and don't edit pi's own settings (`~/.pi/agent/settings.json`, `models.json`, `trust.json`, anything in `~/.pi/agent/pi-web/`).

---

## Troubleshooting

Run:

```bash
bun run cli -- doctor
```

Doctor checks config presence, Caddy, mTLS files, Tailscale, key permissions, tracked secret-looking files, active device registrations, and expired/soon-expiring device certificates.
