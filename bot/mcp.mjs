#!/usr/bin/env node
// MCP server over stdio for the bot API: create_game, make_move, get_board.
// Calls the REST API at BOT_API_URL (default http://localhost:3000). No npm deps.
//   {"command": "node", "args": ["bot/mcp.mjs"], "env": {"BOT_API_URL": "https://chess.example.com"}}
import { createInterface } from 'node:readline';
import { mcpServer } from './mcp-core.mjs';

const BASE = new URL(process.env.BOT_API_URL || 'http://localhost:3000');
if (!BASE.pathname.endsWith('/')) BASE.pathname += '/'; // site root; the API is at <root>api/games

async function api(path, { method = 'GET', body, token } = {}) {
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
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) {
    const { error, message, ...extra } = data || {};
    throw { status: r.status, code: error || 'http_error', message: message || `HTTP ${r.status}`, extra };
  }
  return data;
}

const enc = encodeURIComponent;
const backend = {
  create: (opts) => api('', { method: 'POST', body: opts }),
  get: (id, token) => api(`/${enc(id)}`, { token }),
  wait: (id, since, token) => api(`/${enc(id)}/wait?since=${since}`, { token }),
  move: (id, token, move) => api(`/${enc(id)}/move`, { method: 'POST', body: { token, move } }),
};

const mcp = mcpServer(backend, { link: (id) => new URL(`?game=${id}`, BASE).href });
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
