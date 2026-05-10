# adding a second pi-web host

this guide adds another tailscale machine to the federated pi-web sidebar without introducing a central gateway.

## mental model

```text
browser -> selected host over tailscale magicdns + caddy mtls
```

each host is independently secured:

- tailscale device approval
- caddy mtls
- pi-web device allowlist
- webauthn freshness
- local repos/sessions/tripwires

switching hosts in the sidebar changes the active api/sse target in the browser. commands still go directly to the selected host.

## prerequisites

on the second host:

- tailscale installed and logged in
- caddy installed
- bun installed
- this repo checked out
- host appears in `tailscale status`
- magicdns resolves, e.g. `box-a.tailnet.example.ts.net`

on your client device:

- tailscale connected
- client certificate installed for that host, or a shared client ca/cert strategy chosen intentionally

## step 1: copy or create the secure setup on the second host

ssh into the second host and go to the pi-web repo.

```bash
cd /path/to/pi-web
bun install
```

find the tailscale identity:

```bash
tailscale ip -4
tailscale status --self --json
```

initialize secure mode on that host:

```bash
bun src/cli.ts secure init \
  --domain box-a.tailnet.example.ts.net \
  --listen-host 100.X.X.X \
  --listen-port 8443 \
  --device phone \
  --platform ios
```

if you have a trusted server cert/key for that magicdns name, pass them:

```bash
bun src/cli.ts secure init \
  --domain box-a.tailnet.example.ts.net \
  --listen-host 100.X.X.X \
  --listen-port 8443 \
  --server-cert /path/to/box-a.tailnet.example.ts.net.crt \
  --server-key /path/to/box-a.tailnet.example.ts.net.key \
  --device phone \
  --platform ios
```

run doctor:

```bash
bun src/cli.ts doctor
```

## step 2: install the second host's device certificate

if the second host has its own client ca, install the generated device bundle on your phone/laptop:

```text
~/.pi-web/mtls/devices/phone.p12
~/.pi-web/mtls/devices/phone.p12.pass
```

install the `.p12` on the device and use the password from `.p12.pass`.

for iphone/ipad specifically:

1. accept the transferred `.p12`
2. open Settings
3. tap **Profile Downloaded** near the top
4. if it is not visible, go to Settings → General → VPN & Device Management
5. tap the pi-web certificate/profile
6. tap Install
7. enter the iphone/ipad passcode
8. enter the password from `.p12.pass`
9. finish installation
10. close/reopen Safari and visit the pi-web URL

if Safari says the website requires a certificate, the identity was not fully installed yet. complete the Settings profile install flow above.

after transfer, delete temporary copies from files/downloads/airdrop/etc.

## step 3: start pi-web on the second host

on the second host:

```bash
bun src/cli.ts start
```

or create/use the local launcher if installed:

```bash
pi-web start
```

verify from a browser or curl-capable client that the host is reachable:

```text
https://box-a.tailnet.example.ts.net:8443
```

without a valid client cert, caddy should reject the connection before pi-web responds.

## step 4: add both hosts to the host list

on your main/local host, add the second host:

```bash
pi-web host add box-a https://box-a.tailnet.example.ts.net:8443 \
  --label box-a \
  --tailscale-name box-a \
  --tailscale-ip 100.X.X.X
```

or inspect tailscale suggestions:

```bash
pi-web host discover
```

and optionally add discovered nodes:

```bash
pi-web host discover --add
```

list configured hosts:

```bash
pi-web host list
```

## step 5: allow federation origins on each host

for in-page switching, the browser origin serving the ui must be allowed by the selected host.

if your main ui is:

```text
https://local.tailnet.example.ts.net:8443
```

and your second host is:

```text
https://box-a.tailnet.example.ts.net:8443
```

then each host should include the other host origin in its allowed origins.

current practical path:

1. add the host to `~/.pi-web/hosts.json` on each machine, or set `PI_WEB_ALLOWED_ORIGINS` explicitly
2. restart `pi-web start`
3. run `pi-web doctor`

example explicit env for testing:

```bash
PI_WEB_ALLOWED_ORIGINS=https://local.tailnet.example.ts.net:8443 bun src/cli.ts start
```

recommended steady state is to keep host registries synced across your small set of boxes.

## step 6: use the sidebar

open your primary pi-web url:

```text
https://local.tailnet.example.ts.net:8443
```

open the sidebar. configured hosts appear above active sessions.

clicking a host:

- switches the active api base url
- establishes a browser client session for that host
- refreshes sessions from that host
- connects sse to that host when you open a session
- leaves the browser on the same page

## troubleshooting

### host does not appear

run:

```bash
pi-web host list
```

if missing, add it manually or use:

```bash
pi-web host discover
```

### host appears but clicking fails

check:

- tailscale is connected on both devices
- magicdns resolves
- caddy is running on the selected host
- selected host's device cert is installed in the browser/device
- selected host allows the current ui origin
- selected host passes `pi-web doctor`

### cors / origin error

add the ui origin to the selected host's allowed origins.

example:

```bash
PI_WEB_ALLOWED_ORIGINS=https://local.tailnet.example.ts.net:8443 pi-web start
```

### certificate prompt does not appear

browser support varies. use safari/chrome/firefox proper, not an embedded in-app browser.

on ios/ipados, verify the `.p12` identity profile is installed.

### webauthn asks again

expected. webauthn credentials are per rp id / origin, so each host may require its own enrollment/unlock.

## choosing per-host ca vs shared ca

### per-host ca

most isolated:

- each host has its own ca
- each device gets a cert per host
- revocation is local

more setup work.

### shared ca

more convenient:

- one client cert can work on all hosts
- host setup is faster

larger blast radius if the ca leaks.

for 2-3 boxes, start with per-host ca unless the friction gets annoying.
