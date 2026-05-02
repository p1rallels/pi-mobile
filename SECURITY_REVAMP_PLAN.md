# pi-web security and startup revamp plan

## goal

make pi-web reproducible, easy to start from anywhere, and secure enough to treat as a remote terminal/control surface.

primary target:

```text
tailscale = private network reachability
caddy mtls = enrolled device trust
pi-web cert allowlist = per-device authorization/revocation
face id / webauthn = human-presence freshness for sensitive actions
token auth = removed
```

## threat model

pi-web can grant practical workstation/server access through an ai coding agent. security decisions should assume compromise has high impact.

protect against:

- public internet scanning and bot traffic
- leaked urls
- leaked bearer tokens
- accidental exposure on `0.0.0.0`
- unauthorized tailnet devices
- stolen/reused shared credentials
- lost phones/tablets/laptops
- stale browser sessions performing sensitive actions
- app-layer auth bugs becoming the only security boundary

not fully protected against:

- a fully compromised trusted device
- malware that can use the browser/keychain while unlocked
- an attacker with local user access to the host running pi-web
- malicious code already executing inside an allowed repo/session

## desired architecture

```text
trusted device browser
  -> tailscale private network
  -> caddy on host, requiring mtls client cert
  -> pi-web bound to 127.0.0.1 only
  -> pi coding agent runtime
```

pi-web should not be directly reachable from the lan, tailnet, or public internet. only the local reverse proxy should reach it.

## layers

### tailscale

purpose: network perimeter.

buys:

- only tailnet devices can reach the service address
- wireguard encryption between devices
- device-level revocation through tailscale admin
- acl-based service restrictions
- stable private dns/magicdns names

limits:

- does not prove the browser/user is trusted
- does not stop a compromised tailnet device from connecting
- should not be the only gate for a remote-control app

### mtls

purpose: enrolled device identity for https.

normal tls proves the server to the browser. mtls also proves the browser/device to the server/proxy.

with mtls:

- each device gets a unique client certificate and private key
- caddy requires a client cert signed by the pi-web client ca
- unauthenticated requests are rejected before pi-web sees them
- lost devices can be revoked individually
- no url bearer token is needed

### pi-web device allowlist

purpose: app-level authorization after caddy verifies the cert.

caddy should forward trusted client certificate metadata to pi-web, such as fingerprint or serial. pi-web should check that fingerprint against a local allowlist.

this enables:

- per-device names
- device list
- device revocation
- audit/debug output
- rejection of old certs even if signed by the ca

### face id / webauthn

purpose: human-presence freshness.

keep webauthn for sensitive actions:

- start session
- send command
- takeover
- release
- add repo
- device enrollment approval

but do not treat it as the primary security boundary. mtls + allowlist should decide whether the device may connect at all.

### token auth

token auth has been removed.

rules:

- `PI_WEB_TOKEN`, `--token`, and `?token=` are rejected
- localhost development requires no token
- normal phone/tablet/laptop usage relies on mTLS device certificates plus WebAuthn freshness

## cli plan

ship a real cli that replaces large startup commands.

commands:

```bash
pi-web start
pi-web doctor
pi-web secure init
pi-web device issue <name>
pi-web device list
pi-web device revoke <name>
```

optional later:

```bash
pi-web config show
pi-web config set <key> <value>
pi-web logs
pi-web stop
pi-web upgrade-config
```

## config layout

use a stable config dir outside the repo:

```text
~/.pi-web/
  config.json
  devices.json
  mtls/
    ca/
      client-ca.key
      client-ca.crt
    devices/
      iphone.crt
      iphone.key
      iphone.p12
      android.crt
      android.key
      android.p12
  caddy/
    Caddyfile
```

security expectations:

- directories mode `0700`
- private keys mode `0600`
- generated p12 files password-protected
- never write keys into the repo
- never commit generated certs

## config shape

rough shape:

```json
{
  "host": "127.0.0.1",
  "port": 4317,
  "publicOrigins": ["https://pi.example.ts.net"],
  "secureMode": true,
  "caddy": {
    "enabled": true,
    "listenHost": "100.x.y.z",
    "listenPort": 443,
    "domain": "pi.example.ts.net",
    "clientCaCert": "~/.pi-web/mtls/ca/client-ca.crt"
  },
  "tailscale": {
    "required": true
  }
}
```

## device registry shape

rough shape:

```json
{
  "version": 1,
  "devices": [
    {
      "name": "iphone",
      "platform": "ios",
      "fingerprintSha256": "...",
      "serial": "...",
      "issuedAt": "2026-05-02T00:00:00.000Z",
      "expiresAt": "2027-05-02T00:00:00.000Z",
      "revokedAt": null
    }
  ]
}
```

## startup behavior

`pi-web start` should:

1. load `~/.pi-web/config.json`
2. run safety checks
3. start pi-web bound to `127.0.0.1`
4. ensure caddy is running/reloaded with mtls config
5. print the usable url
6. print status for tailscale, caddy, mtls, and webauthn
7. fail closed on unsafe remote config

example output:

```text
pi-web secure mode
local app: http://127.0.0.1:4317
public url: https://pi.example.ts.net
network: tailscale ok
proxy: caddy ok, mtls required
devices: 3 allowed, 0 expired, 1 expiring soon
face id/webAuthn: enabled for control actions
```

## doctor behavior

`pi-web doctor` should check:

- pi-web is not bound to `0.0.0.0`
- caddy exists and config validates
- caddy requires mtls client auth
- caddy reverse proxies only to localhost
- tailscale is installed and connected when required
- public origin/domain matches config
- allowed origins are configured
- key/cert file permissions are restrictive
- `.key`, `.p12`, `.pfx`, `.crt`, `.tls` are not tracked by git
- device allowlist exists
- no revoked/expired cert is still allowed
- face id/webAuthn is enabled for sensitive actions

## secure init behavior

`pi-web secure init` should:

1. create config directory
2. generate client ca if missing
3. generate caddy config
4. detect tailscale domain/ip if available
5. set pi-web host to `127.0.0.1`
6. create empty device registry
7. offer to issue first device cert
8. run doctor

## device issue behavior

`pi-web device issue <name>` should:

1. validate device name
2. generate device private key
3. generate client cert signed by pi-web client ca
4. export password-protected `.p12`
5. compute fingerprint
6. store fingerprint in device allowlist
7. print install instructions by platform
8. remind user to delete temporary transfer copies

platform hints:

```bash
pi-web device issue iphone --platform ios
pi-web device issue pixel --platform android
pi-web device issue laptop --platform macos
pi-web device issue windows-box --platform windows
pi-web device issue linux-box --platform linux
```

## mobile support

mtls is platform-neutral.

### ios / ipados

- export `.p12`
- transfer via airdrop, 1password, or other secure channel
- tap/install profile
- usable identity lives in ios profile/keychain storage
- files app is temporary transfer only
- delete temporary `.p12` copies after install

### android

- export `.p12`
- transfer securely
- install through settings/security credentials flow
- choose user/app/vpn certificate, not ca certificate
- chrome should use android credential store for client cert selection
- delete temporary `.p12` copies after install

### macos

- import `.p12` into keychain
- safari/chrome can use keychain identity

### windows

- import `.p12` into user certificate store
- edge/chrome can use windows cert store

### linux

- import into browser/nss store as needed
- behavior varies by browser/distribution

avoid relying on embedded in-app browsers.

## caddy model

caddy should be the secure front door:

```text
browser -> caddy with mtls -> 127.0.0.1:4317
```

caddy responsibilities:

- terminate https
- require client certificate
- verify client certificate against pi-web client ca
- forward only verified requests
- include trusted cert fingerprint header for pi-web allowlist checks

pi-web responsibilities:

- bind localhost only
- verify trusted proxy headers only from localhost/caddy
- check client cert fingerprint allowlist
- enforce webauthn freshness for sensitive actions
- enforce origin/host checks

## example caddyfile shape

```caddyfile
pi.example.ts.net {
  tls /path/to/server.crt /path/to/server.key {
    client_auth {
      mode require_and_verify
      trusted_ca_cert_file /Users/you/.pi-web/mtls/ca/client-ca.crt
    }
  }

  reverse_proxy 127.0.0.1:4317 {
    header_up X-Forwarded-Proto https
    header_up X-PI-Web-Client-Cert-Fingerprint {http.request.tls.client.fingerprint}
    header_up X-PI-Web-Client-Cert-Subject {http.request.tls.client.subject}
  }
}
```

exact placeholder names must be verified against caddy docs/version before implementation.

## open-source setup tiers

### local dev

- localhost only
- no caddy required
- no token
- fastest path for contributors

### recommended personal secure mode

- tailscale
- caddy
- mtls
- device allowlist
- webauthn freshness

### advanced public domain mode

- caddy/nginx/cloudflare allowed
- must require mtls or equivalent device auth
- origin bypass protection required
- explicit warning docs

## implementation order

### phase 1: cli and config foundation

- add `pi-web` cli entrypoint
- load/write config file
- add `doctor`
- add safe process startup wrapper
- preserve current dev scripts

### phase 2: device registry and mtls headers

- add device registry store
- parse trusted client cert fingerprint header
- require fingerprint allowlist in secure mode
- reject spoofed headers unless request comes from localhost/trusted proxy
- add tests for allow/reject/revoked devices

### phase 3: cert issuance

- generate client ca
- generate per-device cert/key
- export password-protected p12
- list/revoke devices
- add expiry warnings

### phase 4: caddy integration

- generate caddyfile
- validate caddy installed
- reload/start caddy
- wire allowed origins/public url
- add doctor checks

### phase 5: token removal

- remove `PI_WEB_TOKEN`, `--token`, and browser `?token=` bootstrap
- reject token env/flag use explicitly
- remove token auth docs and frontend bootstrap

### phase 6: docs and guided onboarding

- write setup walkthroughs for ios/android/macos/windows/linux
- add threat model docs
- add recovery docs
- add troubleshooting docs

## non-goals for this revamp

- visual redesign
- heavy frontend framework migration
- public multi-user hosted service
- replacing tailscale with public internet exposure
- making face id the root auth mechanism

## guiding principle

make the safe path the easy path. if a user can start pi-web insecurely by accident, the revamp failed.
