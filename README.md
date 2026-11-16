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
    - with **Free undo/redo** ticked it's a local game instead (no server, no clock): `←`/`→` take back and replay your moves freely, and playing a different move branches off
  - **External bot**: you get the bot's token and a ready-made command
  - **Analysis board**: local free play for both sides, with undo/redo and FEN/PGN load (no server, no clock)
- Online games: the board follows your side, shows whose turn it is, the time left for the move (or both chess clocks), a live connected dot per player, resign, abort (before both first moves), draw offers and takeback requests (with an Accept/Decline banner for the other side). When you play Stockfish, it grants takebacks and accepts a draw only if its eval is +0.5 or worse for it. Each player picks a display name (New game dialog, the join dialog of an invite link, or the pencil next to your name). Illegal or out-of-turn moves are rejected by the server and the piece snaps back. Tokens stay in this browser, so a reload or reconnect resumes the game. A spectator link without a token is read-only and live. Engine analysis is disabled while you play (the eval bar only if the host allowed it), except in games vs Stockfish created with "Allow Stockfish analysis" (toggle with `A`; marks the game assisted).
- Legal-move hints, drag or click to move, promotion picker, check/last-move highlight, sounds, move animation
- Move list (click to jump), undo/redo (`←`/`→`), `Home`/`End`, flip (`F`), analysis (`A`), eval bar (`E`), coordinates off/edges/every tile (`C`)
- **Stockfish analysis** (`A`, or Settings): live best-move arrow, eval bar and depth for the shown position, on a separate full-strength worker; live games played with it on are marked *assisted* (badge in My games, `Annotator` header in PGN)
- **Eval bar** (`E`, or the New game dialog): just the evaluation bar plus White/Black winning chances in %, no best move. Chosen per game; marks the game *assisted* like analysis. In online games it's a rule the host allows (off by default), shown to both players
- **Settings** (`S`): board themes + custom colours, highlight colour, 7 piece sets, board size, light/dark UI, animation speed, sounds/volume, toggles for hints/highlights/auto-queen/confirmations
- **Premoves**: in online games, queue one or more moves during the opponent's turn; each is played the moment it's your turn if it's legal (otherwise the queue is dropped). Right-click the board or press `Esc` to clear. The host turns premoves on or off for the game in the New game dialog.
- **Confirm moves** (Settings, off by default): in online games a move is shown on the board and only sent after *Confirm move* (`Enter`); *Cancel* (`Esc`) takes it back
- **Accounts**: username + password registration/login; settings and games sync to the account
- **My games** (`G`): finished online games are saved when they end. Analysis-board games autosave (to the account, or this browser for guests — guests can upload them after logging in); replay with autoplay, continue/resume from any move, delete
- **Export/import**: per-game PGN, all games as multi-game PGN or JSON backup; import multi-game PGN or JSON (bad games are reported and skipped). FEN/PGN of the current game via the Export menu (copy, download as `.pgn`/`.fen`, or load).
- **Bot API**: external bots (AI agents) play each other or a human over HTTP. The server validates every move. Watch any game live at `/?game=<id>`, or play a side at `/?game=<id>#token=<token>` (see [Bot API](#bot-api)).

## Run with Docker
```bash
docker compose up -d --build
```
Open http://localhost:8080. `.env` options (all listed with defaults in `.env.example`; copy it to `.env`):
- `CHESS_PORT` – host port (default 8080)
- `CHESS_REGISTRATION_OPEN` – `false` to disable new sign-ups
- `CHESS_BOT_MOVE_TIME_MS` – default per-move time limit for bot API games (default 30000)
- `CHESS_BOT_CREATE_PER_HOUR` – games one IP may create per hour (default 30)
- `CHESS_BOT_PROXY_HOPS` – how many reverse proxies append to `X-Forwarded-For` in front of the bot service. Default 1 (the bundled Apache). Set it to 2 if another proxy sits in front of this stack, otherwise every client shares one rate limit.
- `CHESS_BOT_ENGINE_MAX_PROCS` / `CHESS_BOT_ENGINE_MAX_DEPTH` / `CHESS_BOT_ENGINE_MAX_MS` – caps for server-side Stockfish in headless games: parallel engine processes (default 2, each single-threaded with a 16 MB hash), search depth (30) and time per move (2000 ms; the real limit at high levels)
- `CHESS_MCP_TOKEN` – bearer token for MCP over HTTP at `/mcp` (see [MCP](#mcp)). Empty (default) disables `/mcp` (404). Generate one with `openssl rand -base64 32`.
- `CHESS_MCP_ALLOWED_ORIGINS` – comma-separated browser origins allowed to call `/mcp`. Requests with any other `Origin` header get 403 (DNS-rebinding guard); MCP clients normally send none.
- `CHESS_MCP_LIBRARY_KEY` – optional default web-app API key for the MCP library tools (`list_library_games`, `create_game` `library_game_id`), so agents needn't be handed one. `/mcp` is already owner-only behind `CHESS_MCP_TOKEN`.
- `CHESS_LIBRARY_API_URL` – where the bot service reaches the web app for those tools (default `http://chess`, the `chess` service).

The Docker build writes `version.json` (commit hash + date), shown at the bottom of the side panel; other installs simply don't show it. It's read from `.git` in the build context; without it the build still works and the line is just hidden.

The SQLite DB lives in the `chess-data` volume (`/data/chess.sqlite`). Bot API games live in the `bot-data` volume (`/data/bot.sqlite`). Apache proxies `/api/games`, `/api/games/*` and `/mcp` to the `bot` container. Behind another reverse proxy (e.g. NPMplus) just forward the whole site; `https://<host>/mcp` then works, and set `CHESS_BOT_PROXY_HOPS=2`.

## Host on Apache / nginx
Copy `index.html`, `.htaccess`, `api/`, `css/`, `js/`, `img/`, `vendor/` into the docroot (subdirectories work; all paths are relative).

- Needs **PHP 8.5** with `pdo_sqlite` for `api/*.php`. Set `DATA_DIR` to a writable directory **outside** the docroot (default: `data/` next to `api/`, protected by `.htaccess`).
- **Apache 2.4**: `.htaccess` sets the WASM MIME type, compression, caching and blocks `data/` (needs `AllowOverride FileInfo Indexes AuthConfig Limit`; `mod_headers`/`mod_deflate` optional).
- **nginx**: see `nginx.conf` (php-fpm `fastcgi_pass`, `/data` denied, `/api/games` proxied to the bot service). Stock `mime.types` already maps `.wasm`.
- **Bot API** (optional): run `node bot/server.mjs` with Node ≥ 26 and `vendor/` next to `bot/`. Env: `PORT` (3000), `DATA_DIR`, `BOT_MOVE_TIME_MS`, `BOT_CREATE_PER_HOUR`, `BOT_PROXY_HOPS`, `BOT_WAIT_MS` (long-poll, 30000), `MCP_TOKEN`, `MCP_ALLOWED_ORIGINS`, `MCP_LIBRARY_KEY`, `LIBRARY_API_URL` (the web app's site root as the bot reaches it, e.g. `http://127.0.0.1`). Proxy `^/api/games(/|$)` and `/mcp` to it with a read timeout above 30 s. On Apache use `bot/apache.conf`, which needs `mod_proxy_http`.
- Without PHP the app still works as before in guest mode: games and settings stay in `localStorage`, login is hidden.

Serve over HTTPS in production (the session cookie is marked `Secure` automatically when it is). Must be served over HTTP(S) — `file://` blocks ES modules and workers.

## API
JSON, session cookie, `X-Requested-With: chess` header required on writes.
- `api/auth.php` – `GET ?a=me`, `POST ?a=register|login|logout` (`{username, password}`; 10 failed logins / 15 min per IP+user), `POST ?a=apikey` (new read-only API key, returned once as `{key}`; replaces the old one), `POST ?a=apikey_revoke`
- `api/settings.php` – `GET`, `PUT`
- `api/games.php` – `GET` (list, `offset`/`limit`), `GET ?id=`, `POST`, `PUT ?id=`, `DELETE ?id=`, `POST ?a=import` (`{games: [...]}`, ≤500). The `GET`s also accept the account's API key (`X-Api-Key: ck_…` or `Authorization: Bearer ck_…`) instead of the session; a key on any other method is `403`. Create the key in the web app under the key button next to your name.

## Bot API
Refereed games for external bots, or a bot against a human. The server holds the game and validates every move with chess.js; clients never decide what is legal. All requests and responses are JSON. Games start from the standard position unless created with a custom start (see *Custom start*).

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /api/games` | `{move_time_ms? \| clock?, white?, black?, engine?, premoves?, eval_bar?, analysis?, agent?, fen? \| pgn? \| from_game?, moves?, ply?, source?}` | Create a game. Returns `201` with the game state plus `white_token` and `black_token` |
| `GET /api/games/{id}` | – | Game state |
| `GET /api/games/{id}/wait?since=<ply>` | – | Long-poll: answers as soon as `ply != since` (a takeback lowers it), the game ends, an offer changes or a player connects/disconnects. Otherwise it answers after 30 s with the unchanged state |
| `GET /api/games/by-token` | – | Game state of the game the `Authorization: Bearer <token>` belongs to, plus `you` |
| `GET /api/games/{id}/pgn` | – | PGN (`application/x-chess-pgn`) of the game so far, finished or ongoing |
| `POST /api/games/{id}/move` | `{token, move}` | Play a move in UCI form: `e2e4`, `e1g1` (castling), `e7e8q` (promotion) |
| `POST /api/games/{id}/resign` | `{token}` | Resign the token's side |
| `POST /api/games/{id}/abort` | `{token}` | Abort (no result) while `ply < 2`, i.e. before both sides' first moves |
| `POST /api/games/{id}/draw` | `{token, action}` | `offer`, `accept` or `decline` a draw (see *Offers*) |
| `POST /api/games/{id}/takeback` | `{token, action}` | `request`, `accept` or `decline` a takeback (see *Offers*) |
| `POST /api/games/{id}/name` | `{token, name}` | Set the display name of the token's side (up to 40 chars, `""` clears it) while the game is ongoing |
| `POST /api/games/{id}/rules` | `{token, analysis}` | Allow (`true`) or forbid (`false`) Stockfish analysis mid-game. Only in games created with `agent: true` (`409 rules_locked` otherwise) |

**Tokens** are returned only once, on create. Give each player its own token: it is the only credential for that side. `POST` responses include `you`. On the `GET` endpoints, an optional `Authorization: Bearer <token>` header adds `"you": "white"|"black"` to the response and marks that side as connected.

**Create options** (all optional):
- `move_time_ms`: per-move time limit (see *Time control*)
- `clock`: `{"initial_ms": 15000-10800000, "increment_ms": 0-180000}`, a chess clock instead of a per-move limit. Not together with `move_time_ms`
- `premoves`: `true` (default) or `false`. Whether the web board lets players queue moves during the opponent's turn. A game rule chosen by the host; the server can't tell a premove from a fast move, so it is enforced by the web client only
- `eval_bar`: `true` or `false` (default). Whether players may show the Stockfish evaluation bar (winning chances) in the web client while the game is going on. A game rule chosen by the host, enforced by the web client only
- `analysis`: `true` or `false` (default). Whether players may use full Stockfish analysis (best move + line) in the web client while the game is going on. A game rule like `eval_bar`
- `agent`: `true` marks a game created by an AI agent (the MCP servers set it). Only such games allow changing `analysis` mid-game via `/rules`; state shows it as `rules_changeable`
- `white` / `black`: `{"name": "…"}`, a display name of up to 40 characters
- `engine`: `{"side": "white"|"black", "level": 0-20}`. The server plays that side with Stockfish, and its token is not returned. This is meant for headless games such as bot vs Stockfish. Engine resources are capped: see `CHESS_BOT_ENGINE_*`. When a human plays Stockfish on the board, Stockfish runs in the browser instead and holds a normal token.

```bash
curl -s -X POST http://localhost:8080/api/games -H 'Content-Type: application/json' \
  -d '{"move_time_ms": 10000, "white": {"name": "MyBot"}, "engine": {"side": "black", "level": 5}}'
```

**Custom start:** give at most one of `fen` (a FEN; `moves`, a list of UCI moves, may follow it), `pgn` (a PGN game, mainline; a `[FEN]` tag is honoured) or `from_game` (the id of any earlier game on this server, finished or not). `ply` picks how many of those moves are played before the new game begins (default: all, i.e. the final position). The new game starts at that position with an empty move list, so `ply`, takebacks, first-move limits and abort count from there. The FEN is checked (kings, pawns on edge ranks, en passant, the side not to move may not be in check); castling rights the pieces can't back up are dropped; a position that is already decided is refused (`409 start_is_over`). `source` (≤80 chars) overrides the label shown to players. The state then has `start_fen` and `source` (`null` for the standard start), the PGN gets `SetUp`/`FEN` tags plus an `Origin` tag, and the web client shows it in the online panel.
```sh
curl -s localhost:3000/api/games -H 'Content-Type: application/json' \
  -d '{"pgn": "1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6", "ply": 10, "engine": {"side": "white", "level": 8}}'
```

**Presence:** `players.<side>.connected` is true while that side has an open `/wait` with its token, or has made a request in the last 40 s. A server engine side is always connected. A `/wait` also returns early, with the same ply, when either side connects or disconnects.

**Game state:**
```jsonc
{
  "game_id": "R5NvvpsGKA",
  "status": "ongoing",          // ongoing | checkmate | stalemate | draw | resigned | timeout | aborted
  "result": "*",                // * | 1-0 | 0-1 | 1/2-1/2
  "winner": null,               // white | black | null
  "reason": null,               // threefold | fifty_move | insufficient_material | white_resigned | black_timeout | white_no_first_move | black_aborted | agreement | not_joined | …
  "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "start_fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", // position the game started from
  "source": null,               // custom start: where it came from, e.g. "PGN (A vs B) after ply 10", "game R5NvvpsGKA"
  "turn": "black",
  "ply": 1,
  "moves": [{ "san": "e4", "uci": "e2e4" }],
  "in_check": false,
  "players": {                  // name: null if none was given; engine: {level} when the server plays that side
    "white": { "name": "MyBot", "engine": null, "connected": true },
    "black": { "name": "Stockfish (level 5)", "engine": { "level": 5 }, "connected": true }
  },
  "move_time_ms": 30000,        // per-move limit from ply 2 on (clock games: 1800000)
  "first_move_ms": 1800000,     // limit for each side's first move, once both sides have joined
  "clock": null,                // clock games: { "initial_ms": 300000, "increment_ms": 3000 }
  "clocks": null,               // clock games: time left now, { "white": 297512, "black": 300000 }
  "offers": { "draw": null, "takeback": null }, // pending offer: the side that made it (white | black)
  "premoves": true,             // the host allows premoves in the web client
  "eval_bar": false,            // the host allows the evaluation bar in the web client
  "server_now": 1794420812000,  // server time of this response, to correct for client clock skew
  "created_at": 1794420808543,  // all times: Unix epoch milliseconds
  "last_move_at": 1794420810000,// null before the first move
  "joined_at": 1794420809000,   // when both sides were first connected; null until then
  "deadline_at": 1794420840000  // when the side to move loses on time; null once the game is over
}
```

**Time control:**
- *Start* (all games): nothing counts down until both sides are connected (an engine side always is); if that doesn't happen within 24 h of creation, the game is aborted with reason `not_joined`. From then on, each side's first move must arrive within `first_move_ms` (30 min), or the game ends with `status: "aborted"`, result `*`.
- *Per move* (default): from ply 2, every move must arrive within `move_time_ms`, which is 1 s to 24 h (default `BOT_MOVE_TIME_MS`). If it doesn't, the side to move loses with `status: "timeout"`.
- *Chess clock* (`clock`): each side has `initial_ms` in total and gets `increment_ms` back after each of its moves. The clocks start once both sides have made their first move. After that, the side whose clock runs out loses with `status: "timeout"`. `deadline_at` is when the clock of the side to move runs out.
- If the server restarts and a deadline passed while it was down, that side gets its time back (a fresh per-move limit, or the clock time it had at its last move) instead of losing.

**Offers:**
- *Draw*: `offer` sets `offers.draw` to your side; the opponent can `accept` (`status: "draw"`, reason `agreement`) or `decline`. Offering while the opponent's offer is pending accepts it. Making a move declines the opponent's pending offer; your own offer stays open through your move. One offer per side per position.
- *Takeback*: `request` asks to undo your last move: one ply if the opponent hasn't replied yet, else two (your move and the reply), so it is your turn again. Once accepted, the moves are removed and pending offers are cleared. Clocks are not refunded: both sides keep the time they have; the side to move gets a fresh per-move limit, or its clock runs again.
- A server engine side grants takebacks right away and accepts a draw only if its eval is +0.5 or worse for it.

**Errors** come back as `{"error": "<code>", "message": "<text>"}`:

| HTTP | `error` | When |
|---|---|---|
| 400 | `invalid_json`, `invalid_move_format`, `missing_token`, `invalid_action`, `invalid_move_time`, `invalid_clock`, `invalid_premoves`, `invalid_eval_bar`, `invalid_analysis`, `invalid_agent`, `invalid_name`, `invalid_since` | Malformed request |
| 401 | `invalid_token` | Token matches neither side |
| 404 | `not_found` | Unknown game or endpoint |
| 405 | `method_not_allowed` | Wrong HTTP method |
| 409 | `not_your_turn`, `game_over`, `cannot_abort`, `already_offered`, `no_offer`, `nothing_to_take_back`, `rules_locked` | Valid token, wrong moment |
| 413 | `body_too_large` | Body over 4 KB |
| 422 | `illegal_move` | Not legal in this position. Includes `legal_moves` (UCI) |
| 429 | `rate_limited` | Too many games created from this IP. Includes `retry_after_s` |

**Bot loop:** `GET` the state with your token to learn your side. Then repeat: if it's your turn, `POST move`; otherwise `GET wait?since=<ply>`. Answer offers in `offers` made to you. Stop when `status` is no longer `ongoing`.

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
| `create_game` | `move_time_ms?` or `clock_initial_ms?` + `clock_increment_ms?`, `premoves?`, `eval_bar?`, `analysis?`, `white_name?`, `black_name?`, `human_name?`, `engine_name?`, `engine_side?` (`white`/`black`), `engine_level?` (0–20), `human_side?` (`white`/`black`/`random`); start: one of `fen?`, `pgn?`, `from_game_id?`, `library_game_id?` (+ `library_key?`), plus `ply?` | Create a game; returns `game_id` and the token(s) for every side the server engine doesn't play. With `human_side`, only the agent's token plus `human_link`, a browser link for the user to play that side. `human_name` / `engine_name` name the user's side and the agent's (or server engine's) side, applied after a `random` side is drawn. The start options work as in *Custom start*; `library_game_id` starts from a game in the user's web-app library |
| `make_move` | `game_id?`, `token`, `move` (UCI) | Play a move; an illegal move returns an error listing the legal moves |
| `get_board` | `game_id?`, `token?`, `wait_since_ply?` | ASCII board, FEN, moves, legal moves, status, time left, rules (time control, premoves, eval bar) and pending offers. With `wait_since_ply` it long-polls (up to ~25 s) for the opponent's move |
| `resign` | `game_id?`, `token` | Resign |
| `abort` | `game_id?`, `token` | Abort before both sides' first moves |
| `draw` | `game_id?`, `token`, `action` (`offer`/`accept`/`decline`) | Draw offers |
| `takeback` | `game_id?`, `token`, `action` (`request`/`accept`/`decline`) | Takeback requests |
| `set_analysis` | `game_id?`, `token`, `enabled` | Allow or forbid Stockfish analysis in the web client mid-game (games created through MCP only) |
| `get_pgn` | `game_id?`, `token?` | PGN of the game, finished or ongoing |
| `list_games` | `status?` (`ongoing`/`over`/`all`), `player?`, `limit?` | Games without tokens. Default: ongoing games created or played (with a token) through MCP. With `player`: every game on the server (web-client ones too) where a player name contains that text, e.g. someone's previous games to branch from. Over stdio: only games this process saw |
| `list_library_games` | `library_key?`, `limit?`, `offset?` | The user's saved games in the web app (*My games*), newest first; ids for `create_game` `library_game_id` |

`game_id` can be left out whenever `token` is given: the token names its game.

**Saved games (library):** the web app and the bot service keep separate databases, so the library tools read *My games* through `api/games.php` with a read-only account API key: create it with the key button next to your name in the web app. Pass it as `library_key`, or set it as the server default (`CHESS_MCP_LIBRARY_KEY` for `/mcp`, `LIBRARY_KEY` for stdio). Over HTTP the bot service calls the web app at `CHESS_LIBRARY_API_URL`; over stdio at `BOT_API_URL`.

**Play against your agent:** by default the agent controls both sides. To play it yourself, either ask it to create the game with `human_side` and open the link it gives you, or start a game in the web client with opponent *Bot* and give the agent the bot token shown in the panel (it calls `get_board` with just that token).

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
