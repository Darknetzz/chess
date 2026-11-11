// JSON API client. `api.available` is false when the site is served without PHP (guest-only mode).

const BASE = new URL('../api/', import.meta.url);

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const api = {
  available: false,
  registration: false,
  user: null, // { username, settings }

  async req(path, { method = 'GET', body } = {}) {
    const res = await fetch(new URL(path, BASE), {
      method,
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'chess', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json().catch(() => null);
    if (!res.ok || data === null) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
    return data;
  },

  /** Probe the backend and load the session user. Never throws. */
  async init() {
    try {
      const me = await this.req('auth.php?a=me');
      this.available = true;
      this.registration = !!me.registration;
      this.user = me.user;
    } catch {
      this.available = false;
      this.user = null;
    }
    return this.user;
  },

  async login(username, password, register = false) {
    const me = await this.req(`auth.php?a=${register ? 'register' : 'login'}`, { method: 'POST', body: { username, password } });
    this.user = me.user;
    return this.user;
  },

  async logout() {
    await this.req('auth.php?a=logout', { method: 'POST', body: {} });
    this.user = null;
  },

  saveSettings: (s) => api.req('settings.php', { method: 'PUT', body: s }),
  listGames: (offset = 0, limit = 200) => api.req(`games.php?offset=${offset}&limit=${limit}`),
  getGame: (id) => api.req(`games.php?id=${encodeURIComponent(id)}`),
  createGame: (g) => api.req('games.php', { method: 'POST', body: g }),
  updateGame: (id, g) => api.req(`games.php?id=${encodeURIComponent(id)}`, { method: 'PUT', body: g }),
  deleteGame: (id) => api.req(`games.php?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importGames: (games) => api.req('games.php?a=import', { method: 'POST', body: { games } }),
};
