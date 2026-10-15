# pi-web mock ui

standalone clickable 1:1 shell for fast ui iteration. it copies the real pi-web html/css chrome and uses fake browser-only state. it does not call pi-web, caddy, tailscale, webauthn, or any backend api.

## run locally

```bash
cd mock-ui
bun run start
```

open:

```text
http://127.0.0.1:8787
```

## open it on your phone with a quick cloudflare tunnel

in one terminal:

```bash
cd mock-ui
bun run start
```

in another terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

open the generated `https://*.trycloudflare.com` url on your phone.

if `cloudflared` is missing on macos:

```bash
brew install cloudflared
```

## what is clickable

- host switching in the sidebar
- session switching
- mobile drawer open/close
- new mock session
- model and thinking sheets
- viewer/controller toggle
- takeover/release/abort buttons
- quick prompt chips
- composer send
- `/compact` command with compacting spinner, esc cancellation, and expandable compaction summary
- expandable tool cards

state is local only and stored in `localStorage` so refreshes keep your last mock selection. keep `index.html` and `styles.css` visually aligned with `../public/` when changing the real app chrome.

## reset state

open devtools and run:

```js
localStorage.clear()
location.reload()
```

## canvas prototype

`http://127.0.0.1:8787/canvas.html` runs the real canvas engine (`../public/app/canvas/`, served under `/public/`) with fake panes that stream like working sessions. it's where the feel and the perf of the laptop canvas view get tuned. run it through the relay sandbox when working unattended (`~/.pi-relay/infinite/bin/sandbox bun mock-ui/server.ts`).

knobs (query string):

- `tiles=N`: number of tiles (default 12)
- `streaming=K`: how many of them stream (default a third)
- `rate=R`: deltas per second per streaming tile (default 30)
- `offscreen=stream`: keep streaming tiles that are offscreen (by default they pause, like the real view drops their streams)
- `fps=0`: hide the frame meter (fps, p95 frame time, long tasks)
- `seed=S`: different fake content; `reset=1`: forget the stored camera

gestures: pinch or ctrl+wheel zooms at the cursor (20-200%), wheel on empty canvas and cmd+wheel anywhere pan, drag empty canvas or cmd+drag anywhere pans, drag a title bar to move a tile, its right/bottom edge or corner to resize, double-click empty canvas for a new tile, esc aborts the focused tile. `window.__canvasMock` exposes the canvas for the e2e and perf harness.
