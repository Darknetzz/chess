// Bot API referee: authoritative game state, every move validated by chess.js.
// Zero dependencies: node:http + node:sqlite + node:crypto.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from '../vendor/chess.js/chess.js';
import { enginePool } from './engine.mjs';

const envInt = (k, d) => (Number.isInteger(+process.env[k]) && +process.env[k] > 0 ? +process.env[k] : d);
const PORT = envInt('PORT', 3000);
const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL('../data', import.meta.url));
const MIN_MOVE_MS = 1_000;
const MAX_MOVE_MS = 86_400_000;
const DEFAULT_MOVE_MS = Math.min(MAX_MOVE_MS, Math.max(MIN_MOVE_MS, envInt('BOT_MOVE_TIME_MS', 30_000)));
const CREATE_PER_HOUR = envInt('BOT_CREATE_PER_HOUR', 30);
const PROXY_HOPS = Number.isInteger(+process.env.BOT_PROXY_HOPS) ? +process.env.BOT_PROXY_HOPS : 1;
const WAIT_MS = envInt('BOT_WAIT_MS', 30_000);
const MAX_BODY = 4096;
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const ID_RE = /^[A-Za-z0-9]{10}$/;
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SIDE = { w: 'white', b: 'black' };
const SIDE_CODE = { white: 'w', black: 'b' };
const NAME_MAX = 40;
const PRESENCE_MS = 40_000; // a side counts as connected while it has an open /wait or made a request this recently
const engines = enginePool({
  maxProcs: envInt('BOT_ENGINE_MAX_PROCS', 2),
  maxDepth: envInt('BOT_ENGINE_MAX_DEPTH', 12),
  maxMs: envInt('BOT_ENGINE_MAX_MS', 2000),
});

// ---------- storage ----------
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'bot.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    moves TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ongoing',
    result TEXT NOT NULL DEFAULT '*',
    reason TEXT,
    white_hash TEXT NOT NULL,
    black_hash TEXT NOT NULL,
    move_time_ms INTEGER NOT NULL,
    last_move_at INTEGER,
    deadline_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS games_status ON games(status);
`);
if (db.prepare('PRAGMA user_version').get().user_version < 1) {
  db.exec(`
    BEGIN;
    ALTER TABLE games ADD COLUMN white_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE games ADD COLUMN black_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE games ADD COLUMN engine_side TEXT;
    ALTER TABLE games ADD COLUMN engine_level INTEGER;
    PRAGMA user_version = 1;
    COMMIT;
  `);
}
const q = {
  insert: db.prepare(`INSERT INTO games (id, created_at, white_hash, black_hash, move_time_ms, deadline_at, white_name, black_name, engine_side, engine_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  get: db.prepare('SELECT * FROM games WHERE id = ?'),
  ongoing: db.prepare(`SELECT * FROM games WHERE status = 'ongoing'`),
  save: db.prepare(`UPDATE games SET moves = ?, status = ?, result = ?, reason = ?, last_move_at = ?, deadline_at = ? WHERE id = ?`),
  deadline: db.prepare('UPDATE games SET deadline_at = ? WHERE id = ?'),
};

const hash = (t) => createHash('sha256').update(t).digest('hex');
const newId = () => Array.from({ length: 10 }, () => B62[randomInt(62)]).join('');

/** Live games in memory: id -> { row, chess, waiters:Set, timer }. Finished games are read from the DB on demand. */
const live = new Map();

function replay(row) {
  const chess = new Chess();
  for (const uci of row.moves ? row.moves.split(' ') : []) chess.move(fromUci(uci));
  return chess;
}

function fromUci(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

function load(id) {
  if (live.has(id)) return live.get(id);
  const row = q.get.get(id);
  if (!row) return null;
  const g = { row, chess: replay(row), waiters: new Set(), timer: null, seen: { w: 0, b: 0 }, open: { w: 0, b: 0 }, presence: '' };
  if (row.status === 'ongoing') {
    live.set(id, g);
    schedule(g);
    engineTurn(g);
  }
  return g;
}

/** If the server plays the side to move, ask the engine pool and play its reply. */
function engineTurn(g, attempt = 0) {
  const r = g.row;
  if (r.status !== 'ongoing' || r.engine_side !== g.chess.turn() || g.thinking) return;
  g.thinking = true;
  const ply = g.chess.history().length;
  engines
    .bestMove(g.chess.fen(), r.engine_level)
    .then((uci) => {
      g.thinking = false;
      if (r.status !== 'ongoing' || g.chess.history().length !== ply) return;
      if (!uci) throw new Error('engine returned no move');
      applyMove(g, uci);
    })
    .catch((e) => {
      g.thinking = false;
      console.error(`engine failed in ${r.id} (attempt ${attempt + 1}):`, e.message);
      // Retry a few times; if the engine keeps failing, the engine side loses on time like any client.
      if (attempt < 3) setTimeout(() => engineTurn(g, attempt + 1), 1000).unref();
    });
}

function persist(g) {
  const r = g.row;
  q.save.run(r.moves, r.status, r.result, r.reason, r.last_move_at, r.deadline_at, r.id);
}

function finish(g, status, result, reason) {
  Object.assign(g.row, { status, result, reason, deadline_at: null });
  clearTimeout(g.timer);
  live.delete(g.row.id);
}

/** Outcome after a move, or null if the game goes on. */
function outcome(chess) {
  const mover = chess.turn() === 'w' ? '0-1' : '1-0';
  if (chess.isCheckmate()) return ['checkmate', mover, null];
  if (chess.isStalemate()) return ['stalemate', '1/2-1/2', null];
  if (chess.isInsufficientMaterial()) return ['draw', '1/2-1/2', 'insufficient_material'];
  if (chess.isThreefoldRepetition()) return ['draw', '1/2-1/2', 'threefold'];
  if (chess.isDrawByFiftyMoves()) return ['draw', '1/2-1/2', 'fifty_move'];
  return null;
}

// ---------- clocks ----------
function schedule(g) {
  clearTimeout(g.timer);
  if (g.row.status !== 'ongoing') return;
  g.timer = setTimeout(() => onDeadline(g), Math.max(0, g.row.deadline_at - Date.now()));
  g.timer.unref();
}

function onDeadline(g) {
  if (g.row.status !== 'ongoing' || Date.now() < g.row.deadline_at) return schedule(g);
  const loser = g.chess.turn();
  finish(g, 'timeout', loser === 'w' ? '0-1' : '1-0', `${SIDE[loser]}_timeout`);
  persist(g);
  wake(g);
}

// ---------- long-poll ----------
function wake(g) {
  g.presence = presenceSig(g);
  const s = state(g);
  for (const w of g.waiters) w(s);
  g.waiters.clear();
}

// ---------- presence ----------
const connected = (g, c) => g.row.engine_side === c || g.open[c] > 0 || Date.now() - g.seen[c] < PRESENCE_MS;
const presenceSig = (g) => `${+connected(g, 'w')}${+connected(g, 'b')}`;

/** Record activity by a side; wake waiters if someone's connected state changed. */
function touch(g, side) {
  g.seen[side] = Date.now();
  if (g.row.status === 'ongoing' && presenceSig(g) !== g.presence) wake(g);
}
setInterval(() => {
  for (const g of live.values()) if (presenceSig(g) !== g.presence) wake(g);
}, 5_000).unref();

// ---------- views ----------
function state(g) {
  const r = g.row;
  const history = g.chess.history({ verbose: true });
  const winner = r.result === '1-0' ? 'white' : r.result === '0-1' ? 'black' : null;
  return {
    game_id: r.id,
    status: r.status,
    result: r.result,
    winner,
    reason: r.reason,
    fen: g.chess.fen(),
    turn: SIDE[g.chess.turn()],
    ply: history.length,
    moves: history.map((m) => ({ san: m.san, uci: m.lan })),
    in_check: g.chess.isCheck(),
    players: Object.fromEntries(
      ['w', 'b'].map((c) => [
        SIDE[c],
        { name: r[`${SIDE[c]}_name`] || null, engine: r.engine_side === c ? { level: r.engine_level } : null, connected: connected(g, c) },
      ]),
    ),
    move_time_ms: r.move_time_ms,
    created_at: r.created_at,
    last_move_at: r.last_move_at,
    deadline_at: r.deadline_at,
  };
}

// ---------- HTTP ----------
class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, extra });
  }
}
const err = (status, code, message, extra) => new ApiError(status, code, message, extra);

function send(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw err(413, 'body_too_large', `Request body exceeds ${MAX_BODY} bytes`);
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw err(400, 'invalid_json', 'Request body is not valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw err(400, 'invalid_json', 'Request body must be a JSON object');
  return data;
}

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Each trusted proxy appends one entry; the client's address is PROXY_HOPS from the end.
  return (PROXY_HOPS > 0 && xff.length >= PROXY_HOPS ? xff[xff.length - PROXY_HOPS] : null) || req.socket.remoteAddress || '?';
}

const createLog = new Map(); // ip -> [timestamps]
function rateLimit(ip) {
  const now = Date.now();
  const recent = (createLog.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= CREATE_PER_HOUR) {
    const retry = Math.ceil((recent[0] + 3_600_000 - now) / 1000);
    throw err(429, 'rate_limited', `Too many games created; try again in ${retry}s`, { retry_after_s: retry });
  }
  recent.push(now);
  createLog.set(ip, recent);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of createLog) if (!ts.some((t) => now - t < 3_600_000)) createLog.delete(ip);
}, 600_000).unref();

/** Which side a token belongs to ('w'/'b'), or throws. */
function authSide(g, token) {
  if (typeof token !== 'string' || !token) throw err(400, 'missing_token', 'Body must include "token"');
  const h = Buffer.from(hash(token), 'hex');
  for (const [side, stored] of [['w', g.row.white_hash], ['b', g.row.black_hash]]) {
    if (timingSafeEqual(h, Buffer.from(stored, 'hex'))) return side;
  }
  throw err(401, 'invalid_token', 'Token does not match either side of this game');
}

function needGame(id) {
  const g = ID_RE.test(id) ? load(id) : null;
  if (!g) throw err(404, 'not_found', `No game with id "${id}"`);
  return g;
}

function needOngoing(g) {
  if (g.row.status !== 'ongoing') throw err(409, 'game_over', `Game is over (${g.row.status}, ${g.row.result})`);
}

function create(body, req) {
  let ms = body.move_time_ms ?? DEFAULT_MOVE_MS;
  if (!Number.isInteger(ms) || ms < MIN_MOVE_MS || ms > MAX_MOVE_MS) {
    throw err(400, 'invalid_move_time', `move_time_ms must be an integer between ${MIN_MOVE_MS} and ${MAX_MOVE_MS}`);
  }
  const names = {};
  for (const side of ['white', 'black']) {
    const p = body[side] ?? {};
    const name = p && typeof p === 'object' ? (p.name ?? '') : null;
    if (typeof name !== 'string' || name.length > NAME_MAX) throw err(400, 'invalid_player', `"${side}" must be {name} with name up to ${NAME_MAX} chars`);
    names[side] = name.trim().replace(/[\u0000-\u001f]/g, '');
  }
  let engine = null;
  if (body.engine != null) {
    const { side, level = 5 } = body.engine;
    if (!SIDE_CODE[side] || !Number.isInteger(level) || level < 0 || level > 20) {
      throw err(400, 'invalid_engine', '"engine" must be {side: "white"|"black", level: 0-20}');
    }
    engine = { side: SIDE_CODE[side], level };
    names[side] ||= `Stockfish (level ${level})`;
  }
  rateLimit(clientIp(req));
  const tokens = { white: randomBytes(32).toString('base64url'), black: randomBytes(32).toString('base64url') };
  const now = Date.now();
  let id;
  do id = newId(); while (q.get.get(id));
  q.insert.run(id, now, hash(tokens.white), hash(tokens.black), ms, now + ms, names.white, names.black, engine?.side ?? null, engine?.level ?? null);
  const g = load(id);
  const out = { ...state(g) };
  // The server plays the engine side, so its token is never handed out.
  for (const c of ['w', 'b']) if (engine?.side !== c) out[`${SIDE[c]}_token`] = tokens[SIDE[c]];
  return out;
}

function move(g, body) {
  const side = authSide(g, body.token);
  touch(g, side);
  needOngoing(g);
  if (side !== g.chess.turn()) throw err(409, 'not_your_turn', `Not your turn: ${SIDE[g.chess.turn()]} to move`);
  const uci = typeof body.move === 'string' ? body.move.trim().toLowerCase() : '';
  if (!UCI_RE.test(uci)) throw err(400, 'invalid_move_format', 'Body must include "move" in UCI form, e.g. "e2e4" or "e7e8q"');
  return applyMove(g, uci);
}

/** Validate and play a UCI move for the side to move; shared by clients and the server engine. */
function applyMove(g, uci) {
  const legal = g.chess.moves({ verbose: true }).map((m) => m.lan);
  if (!legal.includes(uci)) {
    const needsPromo = legal.some((l) => l.length === 5 && l.startsWith(uci));
    throw err(422, 'illegal_move', needsPromo ? `${uci} needs a promotion piece, e.g. ${uci}q` : `${uci} is not legal in this position`, {
      legal_moves: legal,
    });
  }
  g.chess.move(fromUci(uci));
  const now = Date.now();
  const r = g.row;
  r.moves = r.moves ? `${r.moves} ${uci}` : uci;
  r.last_move_at = now;
  r.deadline_at = now + r.move_time_ms;
  const end = outcome(g.chess);
  if (end) finish(g, ...end);
  else schedule(g);
  persist(g);
  wake(g);
  engineTurn(g);
  return state(g);
}

function resign(g, body) {
  const side = authSide(g, body.token);
  touch(g, side);
  needOngoing(g);
  finish(g, 'resigned', side === 'w' ? '0-1' : '1-0', `${SIDE[side]}_resigned`);
  persist(g);
  wake(g);
  return state(g);
}

/** Long-poll. A waiter also wakes when either side connects or disconnects (same ply, new `players`). */
function wait(g, url, res, side) {
  const s = state(g);
  const raw = url.searchParams.get('since');
  const since = raw === null ? s.ply : Number(raw);
  if (!Number.isInteger(since) || since < 0) throw err(400, 'invalid_since', '"since" must be a non-negative integer ply count');
  if (s.ply > since || s.status !== 'ongoing') return s;
  if (side) {
    g.open[side]++;
    if (presenceSig(g) !== g.presence) wake(g); // tell the others before we start waiting ourselves
  }
  return new Promise((resolve) => {
    let closed = false;
    const done = (st) => {
      if (closed) return;
      closed = true;
      clearTimeout(t);
      g.waiters.delete(done);
      if (side) {
        g.open[side]--;
        g.seen[side] = Date.now();
      }
      resolve(st);
    };
    const t = setTimeout(() => done(state(g)), WAIT_MS);
    g.waiters.add(done);
    res.on('close', () => done(null));
  });
}

const ROUTE = /^\/api\/games(?:\/([^/]+)(?:\/(move|resign|wait))?)?\/?$/;

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  const m = url.pathname.match(ROUTE);
  if (!m) throw err(404, 'not_found', 'Unknown endpoint');
  const [, id, action] = m;
  const want = !id ? 'POST' : !action ? 'GET' : action === 'wait' ? 'GET' : 'POST';
  if (req.method !== want) {
    res.setHeader('Allow', want);
    throw err(405, 'method_not_allowed', `Use ${want} for this endpoint`);
  }
  if (!id) return send(res, 201, create(await readJson(req), req));
  const g = needGame(id);
  if (want === 'GET') {
    // Optional "Authorization: Bearer <token>" adds "you": the side that token plays.
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
    const side = bearer ? authSide(g, bearer) : null;
    if (side) touch(g, side);
    const s = action === 'wait' ? await wait(g, url, res, side) : state(g);
    return s && send(res, 200, side ? { ...s, you: SIDE[side] } : s);
  }
  const body = await readJson(req);
  return send(res, 200, action === 'move' ? move(g, body) : resign(g, body));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof ApiError) return send(res, e.status, { error: e.code, message: e.message, ...e.extra });
    console.error(e);
    send(res, 500, { error: 'server_error', message: 'Internal error' });
  });
});
server.requestTimeout = WAIT_MS + 30_000;

// ---------- startup: restore live games; don't punish bots for our downtime ----------
const now = Date.now();
for (const row of q.ongoing.all()) {
  if (row.deadline_at < now) {
    row.deadline_at = now + row.move_time_ms;
    q.deadline.run(row.deadline_at, row.id);
  }
  load(row.id);
}

server.listen(PORT, () => console.log(`bot api on :${PORT}, ${live.size} live game(s), data ${DATA_DIR}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    server.closeAllConnections();
    engines.close();
    db.close();
    process.exit(0);
  });
}
