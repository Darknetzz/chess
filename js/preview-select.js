// Custom dropdown that shows a visual preview next to each option.
// The native <select> stays in the form (hidden) as the source of truth; picking an option sets its
// value and fires a bubbling `change`, so existing form handlers keep working.

let uid = 0;

/**
 * @param {HTMLSelectElement} select
 * @param {(value: string) => string} renderPreview  HTML for the preview of one option value
 * @returns {{ refresh(): void }}
 */
export function enhanceSelect(select, renderPreview) {
  const id = `pselect-${++uid}`;
  select.classList.add('pselect-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pselect-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', id);
  // Before the select, so clicking the surrounding <label> text activates the button.
  select.before(btn);

  const list = document.createElement('div');
  list.id = id;
  list.className = 'pselect-list';
  list.setAttribute('role', 'listbox');
  list.popover = 'auto';
  // Outside the <label> (clicks inside it would re-activate the button) but inside the dialog.
  (select.closest('dialog') || document.body).append(list);

  let active = -1;
  const options = () => [...list.querySelectorAll('[role=option]')];

  function render() {
    const cur = select.selectedOptions[0];
    btn.innerHTML = `<span class="pselect-preview">${renderPreview(select.value)}</span>`
      + `<span class="pselect-label">${cur ? cur.textContent : ''}</span><span class="pselect-chev" aria-hidden="true"></span>`;
    list.innerHTML = [...select.options].map((o, i) => (
      `<div role="option" class="pselect-opt" id="${id}-${i}" data-value="${o.value}" aria-selected="${o.value === select.value}">`
      + `<span class="pselect-preview">${renderPreview(o.value)}</span><span class="pselect-label">${o.textContent}</span></div>`
    )).join('');
  }

  function setActive(i) {
    const opts = options();
    if (!opts.length) return;
    active = Math.max(0, Math.min(opts.length - 1, i));
    opts.forEach((o, j) => o.classList.toggle('active', j === active));
    btn.setAttribute('aria-activedescendant', opts[active].id);
    opts[active].scrollIntoView({ block: 'nearest' });
  }

  function position() {
    const r = btn.getBoundingClientRect();
    list.style.minWidth = `${r.width}px`;
    list.style.left = `${Math.max(4, Math.min(r.left, innerWidth - list.offsetWidth - 4))}px`;
    const below = innerHeight - r.bottom - 8;
    const h = list.offsetHeight;
    if (h > below && r.top - 8 > below) list.style.top = `${Math.max(4, r.top - h - 4)}px`;
    else list.style.top = `${r.bottom + 4}px`;
  }

  const isOpen = () => list.matches(':popover-open');

  function open() {
    if (isOpen()) return;
    render();
    list.showPopover();
    position();
    setActive(select.selectedIndex);
  }

  function close(focus = true) {
    if (isOpen()) list.hidePopover();
    if (focus) btn.focus();
  }

  function pick(value) {
    close();
    if (value === select.value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    render();
  }

  list.addEventListener('toggle', (e) => {
    const opened = e.newState === 'open';
    btn.setAttribute('aria-expanded', String(opened));
    if (!opened) btn.removeAttribute('aria-activedescendant');
  });
  // Light dismiss fires on pointerdown; ignore the click that follows on the button so it doesn't reopen.
  let justClosed = false;
  btn.addEventListener('pointerdown', () => { justClosed = isOpen(); });
  btn.addEventListener('click', () => {
    if (justClosed) { justClosed = false; return; }
    if (isOpen()) close(); else open();
  });
  list.addEventListener('click', (e) => {
    const opt = e.target.closest('[role=option]');
    if (opt) pick(opt.dataset.value);
  });
  list.addEventListener('pointermove', (e) => {
    const opt = e.target.closest('[role=option]');
    if (opt) setActive(options().indexOf(opt));
  });
  btn.addEventListener('keydown', (e) => {
    const n = options().length;
    if (!isOpen()) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': setActive(active + 1); break;
      case 'ArrowUp': setActive(active - 1); break;
      case 'Home': setActive(0); break;
      case 'End': setActive(n - 1); break;
      case 'Enter': case ' ': pick(options()[active].dataset.value); break;
      case 'Escape': close(); break;
      case 'Tab': close(false); return;
      default: return;
    }
    e.preventDefault();
  });
  const reposition = () => { if (isOpen()) position(); };
  addEventListener('resize', reposition);
  addEventListener('scroll', reposition, true); // the dialog itself scrolls on small screens

  render();
  return { refresh: render };
}
