<p align="center"><img src="img/banner.svg" alt="Chess" width="100%"></p>

# Chess

Browser chess against a friend (invite link), Stockfish or your own bot, all refereed by one server-side game API, plus a local analysis board. Optional accounts save your games. No build step, no npm, no Composer.

- Rules/SAN/FEN/PGN: [chess.js](https://github.com/jhlywa/chess.js) 1.4.0, vendored in `vendor/chess.js/` (shared by the browser and the bot API server)
- UI: jQuery 4.0.0 (jsDelivr, SRI-pinned) + hand-written board (`js/board.js`)
- Bot: [Stockfish.js](https://github.com/nmrugg/stockfish.js) 19.0.1 lite single-threaded WASM, vendored in `vendor/stockfish/` (Web Workers can't load cross-origin from a CDN)
- Backend: plain PHP 8.5 + SQLite (`api/`), only needed for accounts
- Bot API: Node 26 with built-ins only (`node:http`, `node:sqlite`), `bot/server.mjs`. It is the referee for games between external bots and/or humans.

## Features
- **New game** (`N`): pick your side (white/black/random), the time control and the opponent. Time control is a chess clock (presets from 1+0 bullet to 30+20 classical, or custom minutes + increment; clocks start once both sides have made a first move) or a fixed time per move:
  - **Human**: you get an invite link that opens the game as the other side
  - **Stockfish** (level 0–20): runs in your browser and plays its moves through the API like any bot
  - **External bot**: you get the bot's token and a ready-made command
  - **Analysis board**: local free play for both sides, with undo/redo and FEN/PGN load (no server, no clock)
- Online games: the board follows your side, shows whose turn it is, the time left for the move (or both chess clocks), a live connected dot per player, and resign. Illegal or out-of-turn moves are rejected by the server and the piece snaps back. Tokens stay in this browser, so a reload or reconnect resumes the game. A spectator link without a token is read-only and live. Engine analysis is disabled while you play.
- Legal-move hints, drag or click to move, promotion picker, check/last-move highlight, sounds, move animation
- Move list (click to jump), undo/redo (`←`/`→`), `Home`/`End`, flip (`F`), analysis (`A`), coordinates off/edges/every tile (`C`)
- **Stockfish analysis** (`A`, or Settings): live best-move arrow, eval bar and depth for the shown position, on a separate full-strength worker; live games played with it on are marked *assisted* (badge in My games, `Annotator` header in PGN)
- **Settings** (`S`): board themes + custom colours, highlight colour, 7 piece sets, board size, light/dark UI, animation speed, sounds/volume, toggles for hints/highlights/auto-queen/confirmations
- **Premoves**: in online games, queue one or more moves during the opponent's turn; each is played the moment it's your turn if it's legal (otherwise the queue is dropped). Right-click the board or press `Esc` to clear. The host turns premoves on or off for the game in the New game dialog.
- **Confirm moves** (Settings, off by default): in online games a move is shown on the board and only sent after *Confirm move* (`Enter`); *Cancel* (`Esc`) takes it back
- **Accounts**: username + password registration/login; settings and games sync to the account
- **My games** (`G`): finished online games are saved when they end. Analysis-board games autosave (to the account, or this browser for guests — guests can upload them after logging in); replay with autoplay, continue/resume from any move, delete
- **Export/import**: per-game PGN, all games as multi-game PGN or JSON backup; import multi-game PGN or JSON (bad games are reported and skipped). FEN/PGN of the current game via the FEN/PGN buttons.
- **Bot API**: external bots (AI agents) play each other or a human over HTTP. The server validates every move. Watch any game live at `/?game=<id>`, or play a side at `/?game=<id>#token=<token>` (see [Bot API](#bot-api)).

## Run with Docker
```bash
docker compose up -d --build
```
Open http://localhost:8080. `.env` options:
- `CHESS_PORT` – host port (default 8080)
- `CHESS_REGISTRATION_OPEN` – `false` to disable new sign-ups
- `CHESS_BOT_MOVE_TIME_MS` – default per-move time limit for bot API games (default 30000)
- `CHESS_BOT_CREATE_PER_HOUR` – games one IP may create per hour (default 30)
- `CHESS_BOT_PROXY_HOPS` – how many reverse proxies append to `X-Forwarded-For` in front of the bot service. Default 1 (the bundled Apache). Set it to 2 if another proxy sits in front of this stack, otherwise every client shares one rate limit.
- `CHESS_BOT_ENGINE_MAX_PROCS` / `CHESS_BOT_ENGINE_MAX_DEPTH` / `CHESS_BOT_ENGINE_MAX_MS` – caps for server-side Stockfish in headless games: parallel engine processes (default 2, each single-threaded with a 16 MB hash), search depth (12) and time per move (2000 ms)
- `CHESS_MCP_TOKEN` – bearer token for MCP over HTTP at `/mcp` (see [MCP](#mcp)). Empty (default) disables `/mcp` (404). Generate one with `openssl rand -base64 32`.
- `CHESS_MCP_ALLOWED_ORIGINS` – comma-separated browser origins allowed to call `/mcp`. Requests with any other `Origin` header get 403 (DNS-rebinding guard); MCP clients normally send none.

The SQLite DB lives in the `chess-data` volume (`/data/chess.sqlite`). Bot API games live in the `bot-data` volume (`/data/bot.sqlite`). Apache proxies `/api/games`, `/api/games/*` and `/mcp` to the `bot` container. Behind another reverse proxy (e.g. NPMplus) just forward the whole site; `https://<host>/mcp` then works, and set `CHESS_BOT_PROXY_HOPS=2`.

## Host on Apache / nginx
Copy `index.html`, `.htaccess`, `api/`, `css/`, `js/`, `img/`, `vendor/` into the docroot (subdirectories work; all paths are relative).

- Needs **PHP 8.5** with `pdo_sqlite` for `api/*.php`. Set `DATA_DIR` to a writable directory **outside** the docroot (default: `data/` next to `api/`, protected by `.htaccess`).
- **Apache 2.4**: `.htaccess` sets the WASM MIME type, compression, caching and blocks `data/` (needs `AllowOverride FileInfo Indexes AuthConfig Limit`; `mod_headers`/`mod_deflate` optional).
- **nginx**: see `nginx.conf` (php-fpm `fastcgi_pass`, `/data` denied, `/api/games` proxied to the bot service). Stock `mime.types` already maps `.wasm`.
- **Bot API** (optional): run `node bot/server.mjs` with Node ≥ 26 and `vendor/` next to `bot/`. Env: `PORT` (3000), `DATA_DIR`, `BOT_MOVE_TIME_MS`, `BOT_CREATE_PER_HOUR`, `BOT_PROXY_HOPS`, `BOT_WAIT_MS` (long-poll, 30000), `MCP_TOKEN`, `MCP_ALLOWED_ORIGINS`. Proxy `^/api/games(/|$)` and `/mcp` to it with a read timeout above 30 s. On Apache use `bot/apache.conf`, which needs `mod_proxy_http`.
- Without PHP the app still works as before in guest mode: games and settings stay in `localStorage`, login is hidden.

Serve over HTTPS in production (the session cookie is marked `Secure` automatically when it is). Must be served over HTTP(S) — `file://` blocks ES modules and workers.

## API
JSON, session cookie, `X-Requested-With: chess` header required on writes.
- `api/auth.php` – `GET ?a=me`, `POST ?a=register|login|logout` (`{username, password}`; 10 failed logins / 15 min per IP+user)
- `api/settings.php` – `GET`, `PUT`
- `api/games.php` – `GET` (list, `offset`/`limit`), `GET ?id=`, `POST`, `PUT ?id=`, `DELETE ?id=`, `POST ?a=import` (`{games: [...]}`, ≤500)

## Bot API
Refereed games for external bots, or a bot against a human. The server holds the game and validates every move with chess.js; clients never decide what is legal. All requests and responses are JSON. Games always start from the standard position.

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /api/games` | `{move_time_ms? \| clock?, white?, black?, engine?}` | Create a game. Returns `201` with the game state plus `white_token` and `black_token` |
| `GET /api/games/{id}` | – | Game state |
| `GET /api/games/{id}/wait?since=<ply>` | – | Long-poll: answers as soon as `ply > since`, the game ends or a player connects/disconnects. Otherwise it answers after 30 s with the unchanged state |
| `POST /api/games/{id}/move` | `{token, move}` | Play a move in UCI form: `e2e4`, `e1g1` (castling), `e7e8q` (promotion) |
| `POST /api/games/{id}/resign` | `{token}` | Resign the token's side |

**Tokens** are returned only once, on create. Give each player its own token: it is the only credential for that side. On the two `GET` endpoints, an optional `Authorization: Bearer <token>` header adds `"you": "white"|"black"` to the response and marks that side as connected.

**Create options** (all optional):
- `move_time_ms`: per-move time limit (see *Time control*)
- `clock`: `{"initial_ms": 15000-10800000, "increment_ms": 0-180000}`, a chess clock instead of a per-move limit. Not together with `move_time_ms`
- `premoves`: `true` (default) or `false`. Whether the web board lets players queue moves during the opponent's turn. A game rule chosen by the host; the server can't tell a premove from a fast move, so it is enforced by the web client only
- `white` / `black`: `{"name": "…"}`, a display name of up to 40 characters
- `engine`: `{"side": "white"|"black", "level": 0-20}`. The server plays that side with Stockfish, and its token is not returned. This is meant for headless games such as bot vs Stockfish. Engine resources are capped: see `CHESS_BOT_ENGINE_*`. When a human plays Stockfish on the board, Stockfish runs in the browser instead and holds a normal token.

```bash
curl -s -X POST http://localhost:8080/api/games -H 'Content-Type: application/json' \
  -d '{"move_time_ms": 10000, "white": {"name": "MyBot"}, "engine": {"side": "black", "level": 5}}'
```

**Presence:** `players.<side>.connected` is true while that side has an open `/wait` with its token, or has made a request in the last 40 s. A server engine side is always connected. A `/wait` also returns early, with the same ply, when either side connects or disconnects.

**Game state:**
```jsonc
{
  "game_id": "R5NvvpsGKA",
  "status": "ongoing",          // ongoing | checkmate | stalemate | draw | resigned | timeout | aborted
  "result": "*",                // * | 1-0 | 0-1 | 1/2-1/2
  "winner": null,               // white | black | null
  "reason": null,               // threefold | fifty_move | insufficient_material | white_resigned | black_timeout | white_no_first_move | …
  "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "turn": "black",
  "ply": 1,
  "moves": [{ "san": "e4", "uci": "e2e4" }],
  "in_check": false,
  "players": {                  // name: null if none was given; engine: {level} when the server plays that side
    "white": { "name": "MyBot", "engine": null, "connected": true },
    "black": { "name": "Stockfish (level 5)", "engine": { "level": 5 }, "connected": true }
  },
  "move_time_ms": 30000,        // clock games: the limit for each side's first move
  "clock": null,                // clock games: { "initial_ms": 300000, "increment_ms": 3000 }
  "clocks": null,               // clock games: time left now, { "white": 297512, "black": 300000 }
  "premoves": true,             // the host allows premoves in the web client
  "server_now": 1794420812000,  // server time of this response, to correct for client clock skew
  "created_at": 1794420808543,  // all times: Unix epoch milliseconds
  "last_move_at": 1794420810000,// null before the first move
  "deadline_at": 1794420840000  // when the side to move loses on time; null once the game is over
}
```

**Time control:**
- *Per move* (default): every move must arrive within `move_time_ms`, which is 1 s to 24 h (default `BOT_MOVE_TIME_MS`). If it doesn't, the side to move loses with `status: "timeout"`. White's clock starts when the game is created, so start both bots promptly or pick a generous limit.
- *Chess clock* (`clock`): each side has `initial_ms` in total and gets `increment_ms` back after each of its moves. The clocks start once both sides have made their first move. Each first move must arrive within `move_time_ms` (the initial time, clamped to 30 s–10 min), or the game ends with `status: "aborted"`, result `*`. After that, the side whose clock runs out loses with `status: "timeout"`. `deadline_at` is when the clock of the side to move runs out.
- If the server restarts and a deadline passed while it was down, that side gets its time back (a fresh per-move limit, or the clock time it had at its last move) instead of losing.

**Errors** come back as `{"error": "<code>", "message": "<text>"}`:

| HTTP | `error` | When |
|---|---|---|
| 400 | `invalid_json`, `invalid_move_format`, `missing_token`, `invalid_move_time`, `invalid_clock`, `invalid_premoves`, `invalid_since` | Malformed request |
| 401 | `invalid_token` | Token matches neither side |
| 404 | `not_found` | Unknown game or endpoint |
| 405 | `method_not_allowed` | Wrong HTTP method |
| 409 | `not_your_turn`, `game_over` | Valid token, wrong moment |
| 413 | `body_too_large` | Body over 4 KB |
| 422 | `illegal_move` | Not legal in this position. Includes `legal_moves` (UCI) |
| 429 | `rate_limited` | Too many games created from this IP. Includes `retry_after_s` |

**Bot loop:** `GET` the state with your token to learn your side. Then repeat: if it's your turn, `POST move`; otherwise `GET wait?since=<ply>`. Stop when `status` is no longer `ongoing`.

```bash
# create a game; prints both tokens, a spectate link and a play-as-white link
node bot/random_bot.mjs http://localhost:8080 --new
# random-move bots, one per side (in two terminals)
node bot/random_bot.mjs http://localhost:8080 <game_id> <white_token>
node bot/random_bot.mjs http://localhost:8080 <game_id> <black_token>
```

**Board UI:** the board is a client of this API, using the same flow as a bot.
- `/?game=<id>` spectates live.
- `/?game=<id>#token=<token>` (or `&token=`) joins as that side. The token goes in the URL fragment, so it never reaches server logs. The page then moves it into `localStorage` (`chess.net.<id>`) and drops it from the address bar, so reloading `/?game=<id>` resumes as that player.
- Opening an invite link in a browser that already holds the other side's token switches that browser to the invited side.
- Finished games are saved to My games (mode `net`).

### MCP
The same game API as [MCP](https://modelcontextprotocol.io) tools, so AI agents can play without writing HTTP code:

| Tool | Arguments | Does |
|---|---|---|
| `create_game` | `move_time_ms?` or `clock_initial_ms?` + `clock_increment_ms?`, `premoves?`, `white_name?`, `black_name?`, `engine_side?` (`white`/`black`), `engine_level?` (0–20) | Create a game; returns `game_id` and the token(s) for every side the server engine doesn't play |
| `make_move` | `game_id`, `token`, `move` (UCI) | Play a move; an illegal move returns an error listing the legal moves |
| `get_board` | `game_id`, `token?`, `wait_since_ply?` | ASCII board, FEN, moves, legal moves, status, time left. With `wait_since_ply` it long-polls (up to ~25 s) for the opponent's move |

Results are text for the model plus the raw game state as `structuredContent`. API errors (wrong token, not your turn, …) come back as tool errors (`isError: true`) the agent can read and recover from. Both protocol eras are supported: `2026-07-28` (`server/discover`, per-request `_meta`) and the `initialize` handshake (`2025-11-25`, `2025-06-18`, `2025-03-26`).

**HTTP** (Streamable HTTP, built into the bot service, no extra container): set `CHESS_MCP_TOKEN`, then point the client at `/mcp` with that bearer token:
```json
{ "mcpServers": { "chess": { "type": "http", "url": "https://chess.example.com/mcp",
  "headers": { "Authorization": "Bearer <CHESS_MCP_TOKEN>" } } } }
```
`POST /mcp` only (one JSON-RPC message per request, JSON responses, no SSE; `GET` → 405). Missing or wrong bearer → 401, `/mcp` without `MCP_TOKEN` configured → 404. The `MCP_TOKEN` only gates access to `/mcp`; each game side still needs its own game token in the tool arguments. Game creation shares the per-IP rate limit.

**stdio** (local; needs Node ≥ 26 and this repo checked out). `bot/mcp.mjs` calls the REST API at `BOT_API_URL` (the site root, default `http://localhost:3000`, i.e. `node bot/server.mjs` running locally; use `http://localhost:8080` for the Docker stack):
```json
{ "mcpServers": { "chess": { "command": "node", "args": ["/path/to/chess/bot/mcp.mjs"],
  "env": { "BOT_API_URL": "https://chess.example.com" } } } }
```
Claude Code: `claude mcp add --transport http chess https://chess.example.com/mcp --header "Authorization: Bearer <token>"` or `claude mcp add chess -e BOT_API_URL=http://localhost:8080 -- node bot/mcp.mjs`.

## Licenses
GPLv3 (`LICENSE`), required by Stockfish. chess.js: BSD-2-Clause (`vendor/chess.js/LICENSE`). Piece sets via lichess:
- cburnett (Colin M.L. Burnett) – GPLv2+ (knight also used in `img/logo.svg` / `img/banner.svg`)
- merida (Armando Hernandez Marroquin) – GPLv2+
- chessnut (Alexis Luengas) – Apache 2.0
- fantasy, celtic, spatial (Maurizio Monge) – MIT
- mpchess (Maxime Chupin) – GPLv3+
