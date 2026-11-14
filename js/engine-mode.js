// "Stockfish help" dropdown (Off / Eval bar / Full analysis), built on preview-select.
// Used in the toolbar, the Settings dialog and the New game dialog.
import { enhanceSelect } from './preview-select.js';
import { icon } from './icons.js';

export const ENGINE_MODES = {
  off: { label: 'Off', icon: 'eye-off' },
  bar: { label: 'Eval bar', icon: 'chart-column' },
  full: { label: 'Full analysis', icon: 'cpu' },
};

/** Mode for a pair of flags (full analysis wins over the bar). */
export const modeOf = (analysis, evalBar) => (analysis ? 'full' : evalBar ? 'bar' : 'off');

/**
 * @param {HTMLSelectElement} select  empty <select>; options are filled in here
 * @param {(mode: string) => void} onChange  called when the user picks a mode
 * @returns {{ set(mode: string, allowed?: string[]): void }}
 */
export function engineModeSelect(select, onChange) {
  select.innerHTML = Object.entries(ENGINE_MODES).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('');
  const picker = enhanceSelect(select, (k) => `<span class="pv-engine pv-engine-${k}">${icon(ENGINE_MODES[k].icon)}</span>`);
  select.addEventListener('change', () => onChange(select.value));
  return {
    get value() { return select.value; },
    set(mode, allowed = Object.keys(ENGINE_MODES)) {
      for (const o of select.options) o.disabled = !allowed.includes(o.value);
      select.value = mode;
      picker.refresh();
    },
  };
}
