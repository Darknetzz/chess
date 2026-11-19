// Settings dialog: renders the form from the current settings and reports changes.
/* global $ */
import { BOARD_THEMES, PIECE_SETS, DEFAULTS, GAME_KEYS, ENGINE_HASH_MB, boardColors } from './settings.js';
import { maxEngineThreads, engineThreads } from './engine.js';
import { pieceUrl } from './board.js';
import { enhanceSelect } from './preview-select.js';


/**
 * @param {object} opts
 *   get() -> current settings
 *   onChange(patch) -> apply a partial settings update
 */
export function initSettingsUi({ get, onChange }) {
  const $modal = $('#settings-modal');
  const $form = $('#settings-form');

  $form.find('[name=boardTheme]').html(Object.entries(BOARD_THEMES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join(''));
  $form.find('[name=pieceSet]').html(Object.entries(PIECE_SETS).map(([k, label]) => `<option value="${k}">${label}</option>`).join(''));

  const maxThreads = maxEngineThreads();
  $form.find('[name=engineThreads]').html(
    [`<option value="0">Auto (${engineThreads(0)})</option>`, ...Array.from({ length: maxThreads }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`)].join(''),
  );
  $form.find('[name=engineHash]').html(ENGINE_HASH_MB.map((mb) => `<option value="${mb}">${mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}</option>`).join(''));
  $('#engine-note').text(maxThreads > 1
    ? `${maxThreads} CPU threads available.`
    : 'Multi-threading unavailable here (needs a cross-origin isolated page), so the engine uses one thread.');

  const pickers = Object.entries(previewRenderers(get)).map(([name, render]) => enhanceSelect($form.find(`[name=${name}]`)[0], render));

  function fill() {
    const s = get();
    $form.find('[name]').each((_, el) => {
      const v = s[el.name];
      if (v === undefined) return;
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.name === 'engineThreads') el.value = String(Math.min(v, maxThreads));
      else el.value = String(v);
    });
    // Custom colour pickers start from the active theme so switching to "custom" is seamless.
    const { light, dark } = boardColors(s);
    if (s.boardTheme !== 'custom') {
      $form.find('[name=lightColor]').val(light);
      $form.find('[name=darkColor]').val(dark);
    }
    $form.find('.custom-only').prop('hidden', s.boardTheme !== 'custom');
    $('#size-out').text(`${s.boardSize}px`);
    $('#piece-preview').html(
      ['wK', 'wQ', 'wN', 'bK', 'bQ', 'bN'].map((p) => `<img src="${pieceUrl(p[0], p[1].toLowerCase())}" alt="">`).join(''),
    );
    pickers.forEach((p) => p.refresh());
  }

  $form.on('input change', '[name]', (e) => {
    const el = e.target;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'range' || el.type === 'number') {
      v = Number(el.value);
      if (!Number.isFinite(v) || el.value === '') return;
    } else v = typeof DEFAULTS[el.name] === 'number' ? Number(el.value) : el.value;
    const patch = { [el.name]: v };
    if (el.name === 'boardTheme' && v === 'custom') {
      patch.lightColor = String($form.find('[name=lightColor]').val());
      patch.darkColor = String($form.find('[name=darkColor]').val());
    }
    onChange(patch);
    fill();
  });
  $form.on('submit', (e) => e.preventDefault());

  $('#settings-reset').on('click', () => {
    const keep = Object.fromEntries(GAME_KEYS.map((k) => [k, get()[k]]));
    onChange({ ...DEFAULTS, ...keep });
    fill();
  });
  $('#settings-close').on('click', () => $modal[0].close());

  return {
    open() {
      fill();
      $('#settings-msg').text('');
      $modal[0].showModal();
    },
    message: (text) => $('#settings-msg').text(text),
  };
}

/** Small visual previews for the dropdown pickers, keyed by setting name. */
function previewRenderers(get) {
  const checker = (light, dark) => `<span class="pv-checker" style="--l:${light};--d:${dark}"></span>`;
  return {
    boardTheme(k) {
      const t = BOARD_THEMES[k];
      const s = get();
      return t?.light ? checker(t.light, t.dark) : checker(s.lightColor, s.darkColor);
    },
    pieceSet(set) {
      return `<span class="pv-pieces">${['wK', 'wN', 'bQ'].map((p) => `<img src="${pieceUrl(p[0], p[1].toLowerCase(), set)}" alt="">`).join('')}</span>`;
    },
    coordMode(mode) {
      const { light, dark } = boardColors(get());
      let svg = '';
      for (let r = 0; r < 2; r++) {
        for (let f = 0; f < 2; f++) {
          const isLight = (r + f) % 2 === 0;
          const fill = isLight ? dark : light;
          svg += `<rect x="${f * 8}" y="${r * 8}" width="8" height="8" fill="${isLight ? light : dark}"/>`;
          if (mode === 'all' || (mode === 'edge' && f === 0)) svg += `<text x="${f * 8 + 0.8}" y="${r * 8 + 4.2}" fill="${fill}">${2 - r}</text>`;
          if (mode === 'all' || (mode === 'edge' && r === 1)) svg += `<text x="${f * 8 + 7.3}" y="${r * 8 + 7.5}" fill="${fill}" text-anchor="end">${'ab'[f]}</text>`;
        }
      }
      return `<svg class="pv-coords" viewBox="0 0 16 16" aria-hidden="true">${svg}</svg>`;
    },
    uiTheme(mode) {
      return `<span class="pv-ui pv-ui-${mode}"><span>Aa</span></span>`;
    },
  };
}
