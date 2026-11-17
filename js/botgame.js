// Client for the bot API (/api/games). The board uses it for every live game: it plays, spectates
// and drives the in-browser Stockfish through exactly the same endpoints a bot would.
// URL: ?game=<id> to watch or resume, ?game=<id>#token=<token> (or &token=) to join as that side.
// Tokens are moved out of the URL into localStorage right away, so reloads resume the game.

const BASE = new URL('../api/games/', import.meta.url);
const ID_RE = /^[A-Za-z0-9]{10}$/;
const KEY = (id) => `chess.net.${id}`;

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
  let res;
  try {
    res = await fetch(new URL(path, BASE), { method, signal, cache: 'no-store', headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    throw new BotApiError(err.name === 'AbortError' ? 'Aborted' : 'Network error', 0, 'network');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new BotApiError(data?.message || `Request failed (${res.status})`, res.status, data?.error);
  return data;
}

/** Per-game local data: { token, engineToken, engineLevel, analysis, invite, botToken, saved }. */
export const netStore = {
  get(id) {
    try {
      return JSON.parse(localStorage.getItem(KEY(id)) || 'null') || {};
    } catch {
      return {};
    }
  },
  set(id, patch) {
    try {
      localStorage.setItem(KEY(id), JSON.stringify({ ...this.get(id), ...patch }));
    } catch {
      /* storage unavailable: the game still works until reload */
    }
  },
  drop(id) {
    try {
      localStorage.removeItem(KEY(id));
    } catch {
      /* ignore */
    }
  },
};

/** { id, token, ...stored } from the page URL, or null when no game is requested. */
export function remoteFromUrl(loc = location) {
  const params = new URLSearchParams(loc.search);
  const id = params.get('game');
  if (!id || !ID_RE.test(id)) return null;
  const urlToken = new URLSearchParams(loc.hash.slice(1)).get('token') || params.get('token');
  if (urlToken) {
    // A token in the link replaces whatever this browser had for the game (e.g. joining from an invite).
    const prev = netStore.get(id);
    netStore.set(id, prev.token === urlToken ? {} : { token: urlToken, engineToken: null, analysis: null, invite: null, botToken: null });
    history.replaceState(null, '', `${loc.pathname}?game=${id}`);
  }
  const stored = netStore.get(id);
  return { ...stored, id, token: stored.token || null };
}

/** Shareable link for a game; with a token it joins as that side. */
export const gameLink = (id, token) => {
  const u = new URL(location.pathname, location.origin);
  u.search = `?game=${id}`;
  if (token) u.hash = `token=${token}`;
  return u.href;
};

export const botApi = {
  create: (opts) => req('', { method: 'POST', body: opts }),
  get: (id, token) => req(id, { token }),
  wait: (id, since, token, signal) => req(`${id}/wait?since=${since}`, { token, signal }),
  move: (id, token, move) => req(`${id}/move`, { method: 'POST', body: { token, move } }),
  resign: (id, token) => req(`${id}/resign`, { method: 'POST', body: { token } }),
  abort: (id, token) => req(`${id}/abort`, { method: 'POST', body: { token } }),
  draw: (id, token, action) => req(`${id}/draw`, { method: 'POST', body: { token, action } }),
  takeback: (id, token, action, opponentToken) => req(`${id}/takeback`, { method: 'POST', body: { token, action, opponent_token: opponentToken } }),
  setName: (id, token, name) => req(`${id}/name`, { method: 'POST', body: { token, name } }),
};
