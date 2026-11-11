# Chess

Browser chess: free play (both sides) or vs Stockfish, with optional accounts that save your games. No build step, no npm, no Composer.

- Rules/SAN/FEN/PGN: [chess.js](https://github.com/jhlywa/chess.js) 1.4.0 (ESM from jsDelivr)
- UI: jQuery 4.0.0 (jsDelivr, SRI-pinned) + hand-written board (`js/board.js`)
- Bot: [Stockfish.js](https://github.com/nmrugg/stockfish.js) 19.0.1 lite single-threaded WASM, vendored in `vendor/stockfish/` (Web Workers can't load cross-origin from a CDN)
- Backend: plain PHP 8.5 + SQLite (`api/`), only needed for accounts

## Features
- Free play or vs bot (play white/black/random, level 0–20), resign
- Legal-move hints, drag or click to move, promotion picker, check/last-move highlight, sounds, move animation
- Move list (click to jump), undo/redo (`←`/`→`), `Home`/`End`, flip (`F`), coordinates off/edges/every tile (`C`)
- **Settings** (`S`): board themes + custom colours, highlight colour, 7 piece sets, board size, light/dark UI, animation speed, sounds/volume, toggles for hints/highlights/auto-queen/confirmations
- **Accounts**: username + password registration/login; settings and games sync to the account
- **My games** (`G`): every game autosaves (to the account, or this browser for guests — guests can upload them after logging in); replay with autoplay, continue/resume from any move, delete
- **Export/import**: per-game PGN, all games as multi-game PGN or JSON backup; import multi-game PGN or JSON (bad games are reported and skipped). FEN/PGN of the current game via the FEN/PGN buttons.

## Run with Docker
```bash
docker compose up -d --build
```
Open http://localhost:8080. `.env` options:
- `CHESS_PORT` – host port (default 8080)
- `CHESS_REGISTRATION_OPEN` – `false` to disable new sign-ups

The SQLite DB lives in the `chess-data` volume (`/data/chess.sqlite`).

## Host on Apache / nginx
Copy `index.html`, `.htaccess`, `api/`, `css/`, `js/`, `img/`, `vendor/` into the docroot (subdirectories work; all paths are relative).

- Needs **PHP 8.5** with `pdo_sqlite` for `api/*.php`. Set `DATA_DIR` to a writable directory **outside** the docroot (default: `data/` next to `api/`, protected by `.htaccess`).
- **Apache 2.4**: `.htaccess` sets the WASM MIME type, compression, caching and blocks `data/` (needs `AllowOverride FileInfo Indexes AuthConfig Limit`; `mod_headers`/`mod_deflate` optional).
- **nginx**: see `nginx.conf` (php-fpm `fastcgi_pass`, `/data` denied). Stock `mime.types` already maps `.wasm`.
- Without PHP the app still works as before in guest mode: games and settings stay in `localStorage`, login is hidden.

Serve over HTTPS in production (the session cookie is marked `Secure` automatically when it is). Must be served over HTTP(S) — `file://` blocks ES modules and workers.

## API
JSON, session cookie, `X-Requested-With: chess` header required on writes.
- `api/auth.php` – `GET ?a=me`, `POST ?a=register|login|logout` (`{username, password}`; 10 failed logins / 15 min per IP+user)
- `api/settings.php` – `GET`, `PUT`
- `api/games.php` – `GET` (list, `offset`/`limit`), `GET ?id=`, `POST`, `PUT ?id=`, `DELETE ?id=`, `POST ?a=import` (`{games: [...]}`, ≤500)

## Licenses
GPLv3 (`LICENSE`), required by Stockfish. Piece sets via lichess:
- cburnett (Colin M.L. Burnett) – GPLv2+
- merida (Armando Hernandez Marroquin) – GPLv2+
- chessnut (Alexis Luengas) – Apache 2.0
- fantasy, celtic, spatial (Maurizio Monge) – MIT
- mpchess (Maxime Chupin) – GPLv3+
