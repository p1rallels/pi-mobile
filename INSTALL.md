# Install

pi-web, the tools it works with, and remote access from a phone and a laptop, on a Mac that stays on. Written for an agent to walk you through: give your agent this file and ask it to take you through it.

## For the agent

- Run everything on the **host**: the Mac that stays on and runs pi-web (a Mac mini in a phone + laptop + Mac mini setup). The phone and the laptop only get a certificate and a passkey.
- Collect the values in [Before you start](#before-you-start) first and use them wherever a `<placeholder>` appears. Find what you can with the commands given, and confirm it with the human.
- Every step ends with a check. Run it and don't move on until it passes. Steps marked **(human)** need someone's hands on a device: say exactly what to tap, then wait until they say it's done.
- Skip what's already there. Each step says how to tell.
- Never print secrets: the `.p12.pass` password files, `~/.pi-web/cookie-key`, `~/.pi/agent/auth.json`. The human reads a `.p12` password in their own terminal and types it on the device.
- Ask before anything that stops, removes or replaces existing setup (another Caddy, an existing `~/.pi-web`).

## What you end up with

```text
phone, laptop -> Tailscale -> Caddy (mTLS, :8443) -> pi-web (127.0.0.1:4317) -> pi sessions
                              on the host
```

| Piece | What it is | Repo |
|---|---|---|
| pi-web | this repo: the web UI, and the server that runs pi sessions on the host | https://github.com/p1rallels/pi-mobile |
| msg | pi extension: `msg_send` and `msg_list`, mail between a session and the subs it starts | https://github.com/p1rallels/msg |
| relay | pi extension: context nudges and resets in place (`relay` tool, `/relay`) | https://github.com/p1rallels/relay-loop |
| pfs | CLI: instant forks of a repo for agents working in parallel, plus a pi skill | https://github.com/p1rallels/pfs |
| lookup | CLI: searches past pi sessions; relay builds its catch-up with it | https://github.com/p1rallels/lookup |

pi-web reads the same `~/.pi/agent` setup as the `pi` CLI (the packages in `settings.json`, skills), so msg and relay work the same in pi-web sessions, a terminal `pi` and `pi -p` subs. Optional, skip what's installed: `cm` ([codemapper](https://github.com/p1rallels/codemapper)), `mb` ([marbles](https://github.com/p1rallels/marbles)), [pi-op](https://github.com/p1rallels/pi-op).

## Before you start

| Value | What | How to find it |
|---|---|---|
| `<workspace>` | the folder the repos go in, like `~/code` | ask |
| `<host>` | the host's MagicDNS name, like `mini.your-tailnet.ts.net` | `tailscale status --json`: `Self.DNSName`, without the trailing dot |
| `<tailscale-ip>` | the host's Tailscale IPv4, `100.x.y.z` | `tailscale ip -4` |
| `<phone>`, `<laptop>` | a name for each device's certificate, like `phone` and `macbook` | ask |
| `<platform>` | the phone's: `ios` or `android` | ask |

## 1. Preflight

| Need | Check | If it's missing |
|---|---|---|
| macOS | `sw_vers` | pfs clones with APFS, and pi-web's service is launchd: the host has to be a Mac |
| git | `git --version` | `xcode-select --install` |
| Homebrew | `brew --version` | https://brew.sh |
| bun | `bun --version` | https://bun.sh |
| Rust | `cargo --version` | https://rustup.rs |
| pi | `pi --version`, the same minor version as `@earendil-works/pi-coding-agent` in this repo's `package.json` | https://github.com/earendil-works/pi |
| Caddy | `caddy version` | `brew install caddy` |
| Tailscale | `tailscale status` lists the host, the phone and the laptop | the Tailscale app on all three, in one tailnet; on the host, make the `tailscale` CLI available in the shell (Tailscale's macOS docs) |

- **(human)** In the Tailscale admin console's DNS page, turn on MagicDNS and HTTPS certificates. Step 5.2 checks it.
- If Caddy already runs on the host for something else (`brew services list`, `lsof -nP -iTCP:2019 -sTCP:LISTEN`), stop and ask the human. pi-web's Caddy needs ports 2019 (Caddy's admin API) and 8443, and step 5.4 runs `caddy stop`, which stops whatever Caddy answers on 2019.
- The host shouldn't sleep: System Settings → Energy (Energy Saver on older macOS), prevent automatic sleeping.

## 2. Clone

```sh
cd <workspace>
git clone https://github.com/p1rallels/pi-mobile pi-web
git clone https://github.com/p1rallels/msg
git clone https://github.com/p1rallels/relay-loop
git clone https://github.com/p1rallels/pfs
git clone https://github.com/p1rallels/lookup
```

A repo that's already cloned just gets a `git pull`.

Check: the five folders are in `<workspace>`.

## 3. pfs and lookup

```sh
(cd <workspace>/pfs && cargo install --path . --force)
(cd <workspace>/lookup && cargo install --path . --force)
mkdir -p ~/.pi/agent/skills/pfs && cp <workspace>/pfs/skills/pfs/SKILL.md ~/.pi/agent/skills/pfs/
```

Check: `pfs --version` and `lookup --version` answer, from a new terminal too, and `command -v pfs` is in `~/.cargo/bin`. Forks live in `~/.pfs/forks/<repo>/<n>`; pfs's README has the rest.

## 4. msg and relay

```sh
pi install <workspace>/msg
pi install <workspace>/relay-loop
```

Check: both are under `packages` in `~/.pi/agent/settings.json`, and a new `pi` session has the `msg_list`, `msg_send` and `relay` tools (ask it to call `msg_list`: it lists itself). Sessions that were open before get them once they restart.

Neither needs setup. msg keeps its store in `~/.pi/agent/msg`; relay's defaults are fine, and its README's Config section covers changing them.

## 5. pi-web on the host

Do this after steps 3 and 4. The launchd agent keeps the `PATH` of the shell that installs it, and agents' bash in pi-web sessions needs `pfs`, `lookup`, `pi` and `bun` on it.

### 5.1 Two checkouts

The server runs from a second, detached checkout, so editing and testing in the main one never touches the server you're working through ([RUNBOOK.md](RUNBOOK.md#working-on-pi-web-from-pi-web)):

```sh
cd <workspace>/pi-web
bun install
git worktree add --detach ../pi-web-live main
(cd ../pi-web-live && bun install --frozen-lockfile)
```

Check: `git worktree list` shows both.

### 5.2 A certificate for the host

```sh
mkdir -m 700 -p ~/.pi-web/tls
tailscale cert --cert-file ~/.pi-web/tls/<host>.crt --key-file ~/.pi-web/tls/<host>.key <host>
```

Check: both files exist. If `tailscale cert` fails, HTTPS certificates are off in the admin console, or `<host>` isn't this machine's MagicDNS name. Tailscale certificates last 90 days: [Later](#later) says how to renew.

### 5.3 Secure mode and device certificates

From `<workspace>/pi-web`:

```sh
bun run cli -- secure init --domain <host> --listen-host <tailscale-ip> --listen-port 8443 \
  --server-cert ~/.pi-web/tls/<host>.crt --server-key ~/.pi-web/tls/<host>.key \
  --device <phone> --platform <platform>
bun run cli -- device issue <laptop> --platform macos
bun run cli -- doctor
```

`secure init` prints the URL, `https://<host>:8443`, and where the phone's `.p12` and its password file went (`~/.pi-web/mtls/devices/`).

Check: `doctor` reports no errors. Its warning that pi-web isn't a launchd agent goes away in 5.4.

### 5.4 Keep it running

Only from the worktree, in a shell where `command -v pfs lookup pi bun` finds all four:

```sh
cd <workspace>/pi-web-live
bun run cli -- service print      # the two LaunchAgents it will write
bun run cli -- service install
bun run cli -- service status
```

Check: `service status` shows `dev.pi-web.server` and `dev.pi-web.caddy` running, and its health line has `"ok":true`. `service install` refuses while another pi-web answers on 4317: stop that one first. Logs are in `~/.pi-web/logs/`.

## 6. Devices (human)

Each device gets its own certificate, and the page asks for Face ID / Touch ID on top. The host itself needs neither: `http://localhost:4317` works there.

### Phone

1. Send `~/.pi-web/mtls/devices/<phone>.p12` to the phone: AirDrop on an iPhone (`open ~/.pi-web/mtls/devices` shows the folder in Finder), any private channel for Android.
2. Install it.
   - iPhone: Settings → **Profile Downloaded** → Install (or Settings → General → VPN & Device Management).
   - Android: Settings → Security → Encryption & credentials → Install a certificate → VPN & app user certificate, not a CA certificate.
3. It asks for the `.p12` password. The human runs `cat ~/.pi-web/mtls/devices/<phone>.p12.pass` in their own terminal on the host and types it in. (Agent: don't run that yourself.)
4. Open `https://<host>:8443` in Safari (Chrome on Android), allow the certificate, and set up Face ID when the page asks.
5. Delete the `.p12` copy from the phone's Downloads or Files.

Check: the page loads and unlocks with Face ID.

### Laptop

1. AirDrop `~/.pi-web/mtls/devices/<laptop>.p12` over, double-click it and add it to the login keychain, with the password from `<laptop>.p12.pass`, read the same way.
2. Open `https://<host>:8443` in Safari or Chrome, pick the pi-web certificate, and set up Touch ID when the page asks.
3. Delete the `.p12` copy.

Check: the page loads and unlocks with Touch ID.

RUNBOOK.md's [device certificate notes](RUNBOOK.md#device-certificate-install-notes) have more per platform.

## 7. Smoke test

On the phone:

1. Open the menu, **New**, type a folder's path (like `~/code/pi-web`) and press Enter to add it, then **+ new session**. Say hi: the answer streams in.
2. Ask it to run `pfs --version` and `lookup --version`. Both answer, so its bash finds them.
3. Ask it to call `msg_list`: it lists itself.
4. Send `/relay`: the session resets in place and shows a context reset card.

## Later

- **Updating pi-web:** `git pull` in `<workspace>/pi-web`, then `scripts/deploy-live`. It waits until no session is mid-turn, checks the commit out in the worktree, reinstalls dependencies when they changed and restarts the service ([RUNBOOK.md](RUNBOOK.md#deploying)). Reload open tabs afterwards.
- **Updating the tools:** msg and relay: `git pull`, and sessions started after it load the new code. pfs and lookup: `git pull`, then `cargo install --path . --force` again.
- **Renewing the host certificate** (every 90 days): run 5.2's `tailscale cert` again, then `launchctl kickstart -k gui/$(id -u)/dev.pi-web.caddy`.
- **Devices:** `bun run cli -- device issue <name> --platform <platform>` for another one, `bun run cli -- device list`, and `bun run cli -- device revoke <name>` for a lost one.
- **Settings:** `bun run cli -- config` shows the tripwire, project trust and terminal tiles toggles ([RUNBOOK.md](RUNBOOK.md#toggles)).
- **Working on pi-web from a pi-web session:** read RUNBOOK.md's [Working on pi-web from pi-web](RUNBOOK.md#working-on-pi-web-from-pi-web) first. Tests and dev servers run through `scripts/sandbox`, and nothing but the service touches 4317, 8443 or 2019.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `tailscale cert` fails | HTTPS certificates are off in the admin console's DNS page, or `<host>` isn't this machine's MagicDNS name |
| the browser never asks for a certificate, or can't connect | the certificate isn't installed yet (iPhone: Settings → General → VPN & Device Management), or the device isn't on Tailscale |
| `service install` refuses | another pi-web answers on 4317 |
| Caddy won't start | another Caddy holds port 2019 or 8443: `lsof -nP -iTCP:2019 -sTCP:LISTEN` |
| agents in pi-web can't find `pfs` or `lookup` | launchd kept a `PATH` from before step 3: run `bun run cli -- service install --force` in the worktree, from a shell where they're found (it restarts the server) |
| anything else | `bun run cli -- doctor` |
