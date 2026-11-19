// User settings: defaults, validation, persistence (localStorage + account) and applying them to the page.

const STORAGE_KEY = 'chess.settings.v1';

export const BOARD_THEMES = {
  brown: { label: 'Brown', light: '#f0d9b5', dark: '#b58863' },
  green: { label: 'Green', light: '#eeeed2', dark: '#769656' },
  blue: { label: 'Blue', light: '#dee3e6', dark: '#8ca2ad' },
  gray: { label: 'Gray', light: '#dcdcdc', dark: '#a0a0a0' },
  purple: { label: 'Purple', light: '#e9e0f3', dark: '#9478b8' },
  coral: { label: 'Coral', light: '#f5e6d8', dark: '#d08a6e' },
  custom: { label: 'Custom' },
};

export const PIECE_SETS = {
  cburnett: 'Cburnett',
  merida: 'Merida',
  chessnut: 'Chessnut',
  fantasy: 'Fantasy',
  celtic: 'Celtic',
  spatial: 'Spatial',
  mpchess: 'MPChess',
};

export const ANIMATION_MS = { off: 0, fast: 120, normal: 220, slow: 380 };

/** Chess clock presets: key -> [minutes, increment seconds]. */
export const CLOCK_PRESETS = {
  '1+0': [1, 0], '2+1': [2, 1], '3+0': [3, 0], '3+2': [3, 2], '5+0': [5, 0], '5+3': [5, 3],
  '10+0': [10, 0], '10+5': [10, 5], '15+10': [15, 10], '30+0': [30, 0], '30+20': [30, 20],
};
export const MOVE_TIMES = [30000, 120000, 600000, 86400000];

export const DEFAULTS = {
  // game
  playerName: '', // display name in online games ('' = account username)
  mode: 'free',
  side: 'w',
  level: 5,
  orientation: 'w',
  timeControl: '5+3', // a CLOCK_PRESETS key, 'custom' (clockMinutes + clockIncrement) or 'move' (moveTimeMs per move)
  clockMinutes: 5,
  clockIncrement: 3,
  moveTimeMs: 120000,
  // board look
  coordMode: 'edge',
  boardTheme: 'brown',
  lightColor: '#f0d9b5',
  darkColor: '#b58863',
  highlightColor: '#9bc700',
  pieceSet: 'cburnett',
  boardSize: 720,
  uiTheme: 'system',
  // motion & sound
  animation: 'normal',
  sound: true,
  volume: 60,
  // behaviour
  showHints: true,
  showLastMove: true,
  showCheck: true,
  autoQueen: false,
  confirmActions: true,
  confirmMove: false,
  premoves: true, // default for "Allow premoves" when hosting a game (the game's rule decides)
  analysis: false,
  evalBar: false, // default for the New game dialog's "evaluation bar" (each game keeps its own)
  allowAnalysis: false, // default for the New game dialog's "allow analysis" (online games)
  freeUndo: false, // default for the New game dialog's Stockfish "free undo/redo" (local game, no clock)
  autoplaySpeed: 1.5,
  // analysis engine (this device)
  engineThreads: 0, // 0 = auto (all cores but one)
  engineHash: 128, // MB
  analysisDepth: 28,
};

export const ENGINE_HASH_MB = [16, 32, 64, 128, 256, 512, 1024];

const ENUMS = {
  mode: ['free', 'bot'],
  side: ['w', 'b', 'random'],
  orientation: ['w', 'b'],
  coordMode: ['off', 'edge', 'all'],
  boardTheme: Object.keys(BOARD_THEMES),
  pieceSet: Object.keys(PIECE_SETS),
  uiTheme: ['system', 'light', 'dark'],
  animation: Object.keys(ANIMATION_MS),
  timeControl: [...Object.keys(CLOCK_PRESETS), 'custom', 'move'],
  moveTimeMs: MOVE_TIMES,
  engineHash: ENGINE_HASH_MB,
};
const RANGES = { level: [0, 20], boardSize: [320, 1200], volume: [0, 100], autoplaySpeed: [0.25, 5], clockMinutes: [0.25, 180], clockIncrement: [0, 180], engineThreads: [0, 256], analysisDepth: [10, 60] };

/** Game-mode keys: kept from the session in progress when account settings load. */
export const GAME_KEYS = ['mode', 'side', 'level', 'orientation', 'timeControl', 'clockMinutes', 'clockIncrement', 'moveTimeMs', 'premoves', 'evalBar', 'allowAnalysis', 'freeUndo'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Keep only known keys with valid values; fill the rest from defaults. */
export function sanitize(input) {
  const out = { ...DEFAULTS };
  if (!input || typeof input !== 'object') return out;
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = input[k];
    if (v === undefined || typeof v !== typeof def) continue;
    if (ENUMS[k] && !ENUMS[k].includes(v)) continue;
    if (RANGES[k]) {
      if (!Number.isFinite(v)) continue;
      out[k] = Math.min(RANGES[k][1], Math.max(RANGES[k][0], v));
      continue;
    }
    if (k.endsWith('Color') && !COLOR_RE.test(v)) continue;
    out[k] = k === 'playerName' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : v;
  }
  return out;
}

export function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitize(JSON.parse(raw));
    // Migrate settings from the v1 single-key state.
    const old = JSON.parse(localStorage.getItem('chess.state.v1') || 'null');
    return sanitize(old?.settings);
  } catch {
    return sanitize(null);
  }
}

export function saveLocal(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

/** Square colours for the current theme. */
export function boardColors(s) {
  const t = BOARD_THEMES[s.boardTheme];
  return s.boardTheme === 'custom' || !t?.light ? { light: s.lightColor, dark: s.darkColor } : { light: t.light, dark: t.dark };
}

/** Push settings into CSS custom properties / attributes. */
export function apply(s) {
  const root = document.documentElement;
  const { light, dark } = boardColors(s);
  root.style.setProperty('--light', light);
  root.style.setProperty('--dark', dark);
  root.style.setProperty('--last', `color-mix(in srgb, ${s.highlightColor} 45%, transparent)`);
  root.style.setProperty('--board-max', `${s.boardSize}px`);
  if (s.uiTheme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = s.uiTheme;
  root.classList.toggle('no-hints', !s.showHints);
}
