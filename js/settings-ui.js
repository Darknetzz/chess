// Settings dialog: renders the form from the current settings and reports changes.
/* global $ */
import { BOARD_THEMES, PIECE_SETS, DEFAULTS, boardColors } from './settings.js';
import { pieceUrl } from './board.js';

const GAME_KEYS = ['mode', 'side', 'level', 'orientation'];

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

  function fill() {
    const s = get();
    $form.find('[name]').each((_, el) => {
      const v = s[el.name];
      if (v === undefined) return;
      if (el.type === 'checkbox') el.checked = !!v;
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
  }

  $form.on('input change', '[name]', (e) => {
    const el = e.target;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'range' || el.type === 'number') {
      v = Number(el.value);
      if (!Number.isFinite(v) || el.value === '') return;
    } else v = el.value;
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
