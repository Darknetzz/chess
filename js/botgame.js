// Client for the bot API (/api/games). Used by the board to spectate or play a server-refereed game.
// URL: ?game=<id> to watch, ?game=<id>#token=<token> to play that token's side (the hash never reaches server logs).

const BASE = new URL('../api/games/', import.meta.url);
const ID_RE = /^[A-Za-z0-9]{10}$/;

export class BotApiError extends Error {
  constructor(message, status, code) {
    super(message);
    Object.assign(this, { status, code });
  }
}

async function req(path, { method = 'GET', body, token, signal } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token && method === 'GET') headers.Authorization = `Bearer ${token}`;
  const res = await fetch(new URL(path, BASE), { method, signal, cache: 'no-store', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new BotApiError(data?.message || `Request failed (${res.status})`, res.status, data?.error);
  return data;
}

/** { id, token } from the page URL, or null when not in bot-game mode. */
export function remoteFromUrl(loc = location) {
  const id = new URLSearchParams(loc.search).get('game');
  if (!id || !ID_RE.test(id)) return null;
  const token = new URLSearchParams(loc.hash.slice(1)).get('token');
  return { id, token: token || null };
}

export const botApi = {
  get: (id, token) => req(id, { token }),
  wait: (id, since, token) => req(`${id}/wait?since=${since}`, { token }),
  move: (id, token, move) => req(`${id}/move`, { method: 'POST', body: { token, move } }),
  resign: (id, token) => req(`${id}/resign`, { method: 'POST', body: { token } }),
};
