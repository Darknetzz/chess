// Saved-game storage: the account (API) when logged in, otherwise a local list in localStorage.
// A game record: { id, createdAt, updatedAt, startFen, moves: [uci], result, termination,
//                  mode, humanColor, botLevel, white, black, title }

import { api } from './api.js';

const LOCAL_KEY = 'chess.games.v1';
const LOCAL_MAX = 300;
const IMPORT_CHUNK = 200;

const now = () => Math.floor(Date.now() / 1000);

function readLocal() {
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeLocal(list) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list.slice(0, LOCAL_MAX)));
  } catch {
    /* storage full/unavailable */
  }
}

const newLocalId = () => `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sortNewest = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);

export const store = {
  remote: () => !!api.user,

  async list() {
    if (!this.remote()) return readLocal().sort(sortNewest);
    const all = [];
    for (let offset = 0; ; offset += 200) {
      const { games, total } = await api.listGames(offset, 200);
      all.push(...games);
      if (!games.length || all.length >= total) break;
    }
    return all;
  },

  /** Create (no id) or update a game; returns the stored record. */
  async save(game) {
    const { id, ...data } = game;
    if (this.remote()) {
      if (id && typeof id === 'number') return api.updateGame(id, data);
      return api.createGame(data);
    }
    const list = readLocal();
    const t = now();
    const i = id ? list.findIndex((g) => g.id === id) : -1;
    const rec = { ...data, id: i >= 0 ? id : newLocalId(), createdAt: i >= 0 ? list[i].createdAt : data.createdAt || t, updatedAt: t };
    if (i >= 0) list.splice(i, 1);
    list.unshift(rec);
    writeLocal(list);
    return rec;
  },

  async remove(id) {
    if (this.remote()) return api.deleteGame(id);
    writeLocal(readLocal().filter((g) => g.id !== id));
  },

  /** Bulk add; returns the new ids in order. */
  async importMany(games) {
    const clean = games.map(({ id, updatedAt, ...g }) => g);
    if (this.remote()) {
      const ids = [];
      for (let i = 0; i < clean.length; i += IMPORT_CHUNK) ids.push(...(await api.importGames(clean.slice(i, i + IMPORT_CHUNK))).ids);
      return ids;
    }
    const t = now();
    const recs = clean.map((g) => ({ ...g, id: newLocalId(), createdAt: g.createdAt || t, updatedAt: t }));
    writeLocal([...[...recs].reverse(), ...readLocal()]);
    return recs.map((r) => r.id);
  },

  localGames: () => readLocal(),
  clearLocal: () => writeLocal([]),
};
