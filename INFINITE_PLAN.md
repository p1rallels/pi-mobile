# infinite: pi-web as a spatial canvas on the laptop

The user ran agent sessions in Infinite (the native macOS canvas of Ghostty terminals, sibling checkout `../infinite`) all day. Sessions now run on the Mac mini behind pi-web, so the same experience moves into Chrome on the laptop: zoom out to watch every session working, zoom in to one, type into it. It's another view of the same pi-web server and sessions. The phone UI stays as it is.

## decided with the user

- **Targets.** Laptop Chrome only for now. iPad is out of scope, and the phone keeps today's UI (a repo-wheel/session-carousel idea is parked for later).
- **No terminal emulator.** Tiles are pi-web's own SSE-driven, terminal-look session pane, not xterm.
- **No sidebar.** The whole viewport is canvas. A small HUD in the top-right (like Infinite's) holds zoom %, −, 1:1, +, new tile, and the host switcher.
- **Tile anatomy.**
  - Title bar: red dot, title, status pill, one combined model·thinking control, and a ⋯ menu with take over / release.
  - Transcript.
  - Composer.
  - One footer line.
  - The red dot removes the tile from the canvas only. The session lives on, and release stays explicit.
  - `/quit` as the first word of a message stops the session (like quitting pi; its file stays) and the tile goes back to the launcher's directory step in place, like an Infinite terminal back at the shell once pi exits. A dormant tile resumes first (click), then `/quit`; there is no ⋯ quit item.
- **Focus.** Click a tile to type into it. The tile keeps the keyboard while you pan. Clicking empty canvas must not blur its composer. Esc aborts the focused tile's run, as it does today.
- **New tile.** It opens as a launcher panel: pick a directory (saved repos + cwd), then a session from that repo (newest first) or "new session". The panel becomes the session tile in place. Picking a session that's already on the canvas flies the camera to that tile instead of duplicating it. One tile per session.
- **Motion.**
  - Drag a tile by its title bar. Resize from the right edge, bottom edge and corner (min 320×220).
  - ⌘+scroll pans from anywhere, ⌘+drag pans from anywhere, and dragging empty canvas pans.
  - Pinch zooms at the cursor. Chrome reports a trackpad pinch as wheel events with `ctrlKey`; Safari uses `gesture*` events.
  - Zoom range is 20–200%.
  - Double-clicking empty canvas opens a launcher there.
- **Data flowing at every zoom level.** The user wants to see the panes working, so there are no status-card LODs. Zoom stays a camera operation.
- **Glow.** Subtle, not flashy. Soft breathing while working, a steady glow when waiting on you. Implement it as an opacity animation on a pseudo-element; never animate `box-shadow`.
- **Layout.** Saved on the server per host, so the laptop (and later the iPad) see the same map. The camera position is per device, in localStorage.
- **Mode.** The canvas is opt-in via `?ui=canvas`, remembered in localStorage; `?ui=phone` goes back. Also ship a detection helper (`pointer: fine` and short side ≥ 700 css px) so auto-detection can be switched on later. Phones must never get the canvas.
- **No canvas library.**
  - tldraw needs a license key on an https non-loopback host, is a whiteboard, and brings React.
  - React Flow means React.
  - The camera is ~100 lines ported from `../infinite/Sources/Canvas/InfiniteCanvasView.swift`.
  - Raw pointer/wheel/gesture handling is fine. `@use-gesture/vanilla` (MIT) is acceptable if it's bundled once into `public/vendor` (its ESM uses bare imports and `process.env`).

## the core contract (from Infinite's README)

Zoom is a visual camera operation, never a resize. Panning and zooming change one CSS transform on a single world layer, and tile contents never reflow. Only resizing a tile changes its logical width.

Infinite's "known risks" (cell hit-testing, selection, links, IME under transforms) don't apply here: panes are plain DOM, so the browser maps input through transforms natively.

Camera, web form (world → screen = `p * s + t`, `transform-origin: 0 0`):
- Zoom at cursor `c` from `s` to `s'`: `t' = c - (c - t) * (s' / s)`, with `s'` clamped to [0.2, 2].
- Infinite's equivalent is `offsetForMagnifiedScale`, which uses a center-anchored `scaleEffect`.

Visibility is computed from the model geometry (Infinite's `presentedRect`) plus a 200px padding, never from DOM reads in the hot path.

Infinite's numbers, for reference: the default tile is 800×500, title bar 32, corner radius 10, edge grip 10, corner grip 14, auto-layout is 3 columns at 40px spacing, the background is ~#141414, and the focused tile gets a 2px accent stroke plus a glow shadow.

## performance plan (top priority)

### Browser

1. One `transform: translate3d() scale()` on the world layer, coalesced to one write per rAF. Never touch tile DOM during pan or zoom. Set `will-change: transform` only during a gesture and drop it afterwards so text re-rasterizes crisp.
2. Each tile uses `contain: strict` (layout/paint/size isolation), so a streaming tile can't trigger layout or paint elsewhere. Offscreen tiles get `content-visibility: hidden`, or are unmounted.
3. **Windowed transcripts.**
   - An unfocused tile renders the last ~20 messages.
   - A focused tile renders ~50, and scrolling to the top loads older pages as today.
   - Each tile has a toggle to load further back.
   - Heavy tool output is collapsed or truncated in unfocused tiles.
4. Stream deltas are batched per tile per animation frame. Only the streaming block re-renders, never the whole transcript (incremental, idempotent rendering keyed by entry id).
5. **Offscreen tiles.**
   - An offscreen tile closes its SSE stream and resumes from its cursor when it comes back. The reconnect protocol already supports `since`.
   - Tiles offscreen longer than a grace period get their DOM unmounted (keep an LRU of recently visible ones). What's left is a small record: title, status, cursor.
6. Glow and shadows are compositor-only: opacity and transform. No `backdrop-filter`, no blur filters on tiles, and no animated shadows.
7. Budgets to verify in the perf harness (headless Chromium; treat the numbers as regression signals):
   - 30 tiles with ~10 streaming at once: p95 frame time under ~20ms during a scripted pan/zoom.
   - No long tasks over 50ms while panning.
   - Heap, DOM node count and open EventSources return close to baseline after opening and closing 100 tiles.

### Server

The Mac mini is the real bottleneck. Viewing a session attaches an agent runtime (`attachIfNeeded` in src/server.ts), and a session with any connected client is never evictable (`isEvictable` in src/session-runtime.ts). The cap is 24 running sessions. So:

- Offscreen tiles must disconnect, which lets idle ones be evicted.
- Stretch: serve transcripts of non-running sessions read-only from JSONL without attaching, and push running/working/idle status for all canvas tiles over one stream. Then idle on-screen tiles don't need runtimes; only working or focused ones do.

## build order (marbles `infinite:` tasks)

1. Sandbox every test server (env scrub + throwaway `PI_CODING_AGENT_DIR` / `PI_WEB_HOME`) in playwright.config.js and bun tests (fixes m-a118).
2. Camera module: pure functions plus bun tests.
3. Canvas prototype in mock-ui, with fake streaming panes and a perf harness (`?tiles=N&rate=R`, dev fps meter).
4. Perf and leak e2e harness (Playwright Chromium + CDP metrics).
5. Extract an instantiable session pane from public/app/main.js. The phone shell runs on one pane, and its goldens and e2e stay green. This is m-30a5's core.
6. Windowed transcripts plus rAF batching and incremental rendering.
7. Canvas shell in public/ behind `?ui=canvas`.
8. Offscreen disconnect and unmount.
9. Launcher tile.
10. Layout persistence endpoint.
11. Glow.
12. Read-only transcripts and the canvas status stream (stretch).
13. MORNING summary.

## testing

- **Unit (bun).** Camera math (the cursor point stays fixed under zoom, clamping, visibility rects), layout store, windowing, and mode detection.
- **E2E (Playwright Chromium).**
  - Zoom via `keyboard.down('Control')` + `mouse.wheel`, which is exactly what Chrome receives from a trackpad pinch.
  - Pan via Meta + wheel and Meta + drag.
  - Tile drag and resize, the launcher flow, and focus retention.
  - Screenshots that are reviewed by eye.
- **Phone.** The existing webkit-iphone e2e and golden screenshots must stay green throughout.
- **Perf and leaks.** The CDP harness described in the perf plan, against mock-ui and the replay fixtures.
- **Isolation.** Every server under test runs through the sandbox wrapper, on ports other than 4317.
