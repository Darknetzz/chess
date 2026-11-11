# Chess

Static browser chess: free play (both sides) or vs Stockfish. No build step, no npm.

- Rules/SAN/FEN/PGN: [chess.js](https://github.com/jhlywa/chess.js) 1.4.0 (ESM from jsDelivr)
- UI: jQuery 4.0.0 (jsDelivr, SRI-pinned) + hand-written board (`js/board.js`)
- Bot: [Stockfish.js](https://github.com/nmrugg/stockfish.js) 19.0.1 lite single-threaded WASM, vendored in `vendor/stockfish/` (Web Workers can't load cross-origin from a CDN)

## Features
- Free play or vs bot (play white/black/random, level 0–20)
- Coordinates: off / board edges / **every tile** (`C`)
- Flip board 180° (`F`)
- Legal-move hints, drag or click to move, promotion picker, check/last-move highlight
- Move list (click to jump), undo/redo (`←`/`→`), `Home`/`End`
- FEN and PGN import/export (copy, download `.pgn`)
- Game + settings persist in `localStorage`

## Run with Docker
```bash
docker compose up -d --build
```
Open http://localhost:8080 (override the host port with `CHESS_PORT` in `.env`).

## Host on nginx / Apache
Copy `index.html`, `css/`, `js/`, `img/`, `vendor/` (and `.htaccess` for Apache) into the docroot; subdirectories work since all paths are relative.

- **nginx**: stock `mime.types` already maps `.wasm` → `application/wasm`. See `nginx.conf` for a full server block.
- **Apache 2.4**: `.htaccess` sets the WASM MIME type, compression and caching (needs `AllowOverride FileInfo Indexes`; `mod_headers`/`mod_deflate` optional).

Must be served over HTTP(S) — `file://` blocks ES modules and workers.

## Licenses
GPLv3 (`LICENSE`), required by Stockfish. Piece set: cburnett (Colin M.L. Burnett), GPLv2+, via lichess.
