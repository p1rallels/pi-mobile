# pi-web multi-host federation plan

## goal

support a small number of trusted machines, usually 2-3 hosts, without introducing a central command-routing gateway.

primary target:

```text
browser -> selected host's pi-web over tailscale magicdns + caddy mtls
```

not this:

```text
browser -> central gateway -> every worker host
```

for this use case, direct federation is safer and simpler than a gateway.

## assumptions

- tailscale is always used
- every client device and host is manually approved in tailscale
- every host has a magicdns name
- each host runs its own pi-web secure setup
- each host keeps its own repos, sessions, webauthn credentials, and tripwire state
- device certificates are installed manually on clients
- 3-ish hosts, not a fleet

## architecture options

### option 3: plain per-host urls

manual/bookmark model:

```text
https://local.tailnet.ts.net:8443
https://box-a.tailnet.ts.net:8443
https://box-b.tailnet.ts.net:8443
```

pros:

- almost no new code
- strongest isolation
- easiest to reason about
- if one host breaks, others still work
- no central service can route commands everywhere

cons:

- manual browser/bookmark switching
- no unified host picker
- no session counts/health in one ui
- setup and cert/webAuthn enrollment repeated per host

### option 1: federated host switcher

same security model as plain per-host urls, with a small ui layer:

```text
pi-web ui
  hosts:
    local
    prod-a
    prod-b
```

browser talks directly to whichever host is selected:

```text
browser -> local pi-web
browser -> prod-a pi-web
browser -> prod-b pi-web
```

pros:

- still no command-routing gateway
- better ux than bookmarks
- can show host health/session counts
- can switch host context in-app
- low blast radius compared to gateway

cons:

- browser still talks to multiple origins
- cors/origin handling needed
- client cert/webAuthn may prompt/enroll per host
- state remains per-host
- revoking a device may need to be applied on every host unless a shared client ca/registry process is used

### rejected for now: central gateway

```text
browser -> gateway -> workers
```

pros:

- one url
- one browser mtls setup
- one webauthn rp id
- easiest global session list
- seamless one-origin frontend

cons:

- gateway can route commands to every host
- gateway compromise has broad blast radius
- needs gateway-to-worker mtls, routing, streaming proxy, audit, and failure handling
- overkill for 3 hosts

## security model

federation keeps authorization local to each host.

```text
client device cert + tailscale identity -> selected host
```

each host remains independently secured:

- tailscale network reachability
- caddy mtls front door
- pi-web device fingerprint allowlist
- webauthn freshness for sensitive actions
- local repos/sessions/tripwires

there is no central service with authority over every box.

## tailscale usage

use tailscale as the private inventory layer:

- magicdns hostname for each machine
- `tailscale status --json` for discovery
- `tailscale ip -4` for bind/listen host
- tailscale acl/device approval for network-level control

host entries can be derived from magicdns:

```json
{
  "name": "prod-a",
  "url": "https://prod-a.tailnet.example.ts.net:8443",
  "tailscaleName": "prod-a",
  "tailscaleIp": "100.x.y.z"
}
```

## host registry

store host list locally in:

```text
~/.pi-web/hosts.json
```

shape:

```json
{
  "version": 1,
  "hosts": [
    {
      "id": "local",
      "label": "local",
      "url": "https://local.tailnet.example.ts.net:8443",
      "tailscaleName": "local",
      "tailscaleIp": "100.X.X.X",
      "enabled": true,
      "createdAt": "2026-05-02T00:00:00.000Z"
    }
  ]
}
```

## cli commands

add:

```bash
pi-web host add <id> <url>
pi-web host list
pi-web host remove <id>
pi-web host discover
pi-web host doctor
```

examples:

```bash
pi-web host add local https://local.tailnet.example.ts.net:8443
pi-web host add prod-a https://prod-a.tailnet.example.ts.net:8443
pi-web host discover
```

### `host discover`

reads `tailscale status --json` and suggests tailnet machines.

initial version should be non-magical:

- list candidate machines
- print suggested `pi-web host add ...` commands
- do not mutate config unless explicit flags are passed

possible later:

```bash
pi-web host discover --add
```

## frontend behavior

add a host switcher above sessions.

minimum viable ux:

- host dropdown/list
- selected host label
- health indicator
- session list for selected host
- switching host closes current sse connection and opens one to selected host
- active host stored in local storage

api client becomes host-aware:

```js
api.getJson(host.url, "/api/sessions")
api.postJson(host.url, "/api/client", {})
new EventSource(`${host.url}/api/sessions/${id}/events`)
```

## cors/origin requirements

currently pi-web is mostly same-origin. federated direct calls require controlled cors support.

server should allow configured federated browser origins, not wildcard.

safe model:

- each host has `PI_WEB_ALLOWED_ORIGINS` including the origins of other trusted pi-web hosts, or a generated list from `hosts.json`
- credentials remain same-origin per host where possible
- cors only allows exact origins
- methods/headers are narrowly allowed
- sse endpoint supports cors for exact trusted origins

because mtls happens at the host's caddy layer, random internet browsers cannot reach these APIs anyway, but origin checks should still be strict.

## client sessions per host

`/api/client` cookie is host-specific.

frontend should establish a browser client session on each selected host before loading sessions or connecting sse.

host client state:

```js
{
  hostId: "prod-a",
  clientId: "..."
}
```

store only non-secret client ids in memory/local storage. cookies remain host-owned and HttpOnly.

## webauthn implications

webauthn credentials are per rp id / origin.

that means:

- each host may require first-time enrollment
- each host may prompt independently
- this is okay for 3 hosts
- avoid centralizing webauthn unless moving to gateway later

future improvement:

- host setup wizard can open each host and walk through enrollment

## mtls implications

choices:

### per-host client ca

most isolated:

- each host has its own pi-web client ca
- each device gets a cert per host
- revocation is local

more setup friction.

### shared client ca across hosts

more convenient:

- one client cert can work across all hosts
- one phone cert, one laptop cert
- each host trusts the same client ca

larger blast radius if ca leaks. still acceptable for a tiny personal tailnet if stored carefully, but per-host ca is cleaner.

recommended default for now:

- keep current per-host ca behavior
- optionally document how to copy/import the client ca if user wants shared certs later

## implementation phases

### phase 1: host registry cli

- add `HostRegistry` store
- add `pi-web host add/list/remove`
- add `pi-web host discover` using tailscale status
- add tests

### phase 2: server cors support

- exact-origin cors helper
- preflight handling for api routes
- sse cors headers
- config/env for federated allowed origins
- tests for allowed/denied origin

### phase 3: host-aware frontend api

- represent selected host
- update api client to support host base urls
- establish `/api/client` per host
- session/sidebar loads selected host sessions
- sse connects to selected host

### phase 4: host switcher ui

- host list/dropdown above sessions
- health checks
- error display when host is unavailable or mtls/webAuthn blocks access
- remember last selected host

### phase 5: polish

- show per-host active session counts
- show host cwd/session metadata
- optional polling all enabled hosts for summaries
- setup docs for adding a new tailnet host

## non-goals

- central gateway/proxy
- cross-host session migration
- shared filesystem assumptions
- shared repo registry
- public internet exposure
- automatic ssh-based deployment

## guiding principle

make each box independently secure and usable. federation should improve navigation, not create a new root-of-everything service.
