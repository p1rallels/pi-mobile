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
- expandable tool cards

state is local only and stored in `localStorage` so refreshes keep your last mock selection. keep `index.html` and `styles.css` visually aligned with `../public/` when changing the real app chrome.

## reset state

open devtools and run:

```js
localStorage.clear()
location.reload()
```
