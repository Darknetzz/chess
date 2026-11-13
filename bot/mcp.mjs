#!/usr/bin/env node
// MCP server over stdio for the bot API: create_game, make_move, get_board, resign, abort, draw, takeback, set_analysis, get_pgn,
// list_games, list_library_games. Calls the REST API at BOT_API_URL (default http://localhost:3000); the saved-games library is
// api/games.php on the same site, read with a web-app API key (tool argument, or LIBRARY_KEY as the default). No npm deps.
//   {"command": "node", "args": ["bot/mcp.mjs"], "env": {"BOT_API_URL": "https://chess.example.com", "LIBRARY_KEY": "ck_…"}}
import { createInterface } from 'node:readline';
import { mcpServer, libraryFetch } from './mcp-core.mjs';

const BASE = new URL(process.env.BOT_API_URL || 'http://localhost:3000');
if (!BASE.pathname.endsWith('/')) BASE.pathname += '/'; // site root; the API is at <root>api/games

async function api(path, { method = 'GET', body, token, text = false } = {}) {
  let r;
  try {
    r = await fetch(new URL(`api/games${path}`, BASE), {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body && JSON.stringify(body),
    });
  } catch (e) {
    throw { status: 0, code: 'unreachable', message: `Bot API unreachable at ${BASE.href} (${e.cause?.code || e.message})` };
  }
  if (text && r.ok) return r.text();
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) {
    const { error, message, ...extra } = data || {};
    throw { status: r.status, code: error || 'http_error', message: message || `HTTP ${r.status}`, extra };
  }
  return data;
}

const enc = encodeURIComponent;
// Games this process created, used or saw, for list_games (the REST API has no listing).
const used = new Set();
const note = (s) => {
  if (s?.game_id) used.add(s.game_id);
  return s;
};
const post = (id, path, body) => api(`/${enc(id)}/${path}`, { method: 'POST', body }).then(note);
const backend = {
  create: (opts) => api('', { method: 'POST', body: { ...opts, agent: true } }).then(note),
  get: (id, token) => api(`/${enc(id)}`, { token }).then((s) => (token ? note(s) : s)),
  wait: (id, since, token) => api(`/${enc(id)}/wait?since=${since}`, { token }).then((s) => (token ? note(s) : s)),
  move: (id, token, move) => post(id, 'move', { token, move }),
  resign: (id, token) => post(id, 'resign', { token }),
  abort: (id, token) => post(id, 'abort', { token }),
  draw: (id, token, action) => post(id, 'draw', { token, action }),
  takeback: (id, token, action) => post(id, 'takeback', { token, action }),
  rules: (id, token, analysis) => post(id, 'rules', { token, analysis }),
  pgn: (id, token) => api(`/${enc(id)}/pgn`, { token, text: true }),
  lookup: async (token) => note(await api('/by-token', { token })).game_id,
  list: async ({ status = 'ongoing', player = '', limit = 50 } = {}) => {
    const games = (await Promise.all([...used].map((id) => api(`/${enc(id)}`).catch(() => null)))).filter(Boolean);
    const named = (s) => !player || ['white', 'black'].some((c) => (s.players?.[c]?.name || '').toLowerCase().includes(player.toLowerCase()));
    return games
      .filter((s) => (status === 'all' || (status === 'ongoing') === (s.status === 'ongoing')) && named(s))
      .sort((x, y) => y.created_at - x.created_at)
      .slice(0, limit);
  },
  library: (key, query) => libraryFetch(BASE, key, query),
  libraryKey: process.env.LIBRARY_KEY || undefined,
};

const link = (id, token) => {
  const u = new URL(`?game=${id}`, BASE);
  if (token) u.hash = `token=${token}`; // fragment: never reaches server logs
  return u.href;
};
const mcp = mcpServer(backend, { link });
const session = {};
const write = (msg) => msg && process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  // Requests run concurrently: a long-poll get_board must not block other calls.
  mcp.handle(msg, session).then(write, (e) => console.error(e));
});
console.error(`chess MCP (stdio) -> ${BASE.href}`);
