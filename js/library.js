// "My games" dialog: list, replay, delete, export and import saved games.
/* global $ */
import { store } from './store.js';
import { recordToPgn, parseImport, exportJson, download, today } from './pgn.js';
import { icon } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const RESULT_TEXT = { '1-0': '1–0', '0-1': '0–1', '1/2-1/2': '½–½', '*': 'in progress' };

/**
 * @param {object} opts
 *   onReplay(record)  -> open a game in replay mode
 *   onDeleted(id)     -> a game was deleted
 *   currentId()       -> id of the live game (highlighted)
 *   beforeOpen()      -> awaited before listing (flush pending saves)
 */
export function initLibrary({ onReplay, onDeleted, currentId, beforeOpen }) {
  const $modal = $('#games-modal');
  let games = [];

  const msg = (text) => $('#games-msg').text(text);

  function render() {
    $('#games-where').text(store.remote() ? '(account)' : '(this browser)');
    if (!games.length) {
      $('#games-list').html('<p class="muted">No saved games yet. Games are saved automatically as you play.</p>');
      return;
    }
    const cur = currentId();
    $('#games-list').html(
      games
        .map((g, i) => {
          const date = g.createdAt ? new Date(g.createdAt * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
          const n = Math.ceil(g.moves.length / 2);
          const sub = [g.title, g.termination, `${n} move${n === 1 ? '' : 's'}`].filter(Boolean).map(esc).join(' · ');
          return `<div class="game-row${g.id === cur ? ' current' : ''}" data-i="${i}">
            <div class="game-info">
              <div class="game-players">${esc(g.white || '?')} <span class="muted">vs</span> ${esc(g.black || '?')}
                <span class="badge r${esc(g.result).replace(/[^0-9a-z]/gi, '')}">${RESULT_TEXT[g.result] || esc(g.result)}</span>
                ${g.assisted ? '<span class="badge" title="Stockfish analysis was used">hints</span>' : ''}
                ${g.id === cur ? '<span class="badge">current</span>' : ''}</div>
              <div class="game-sub muted">${esc(date)} · ${sub}</div>
            </div>
            <div class="game-actions">
              <button type="button" data-act="replay">${icon('play')}<span class="lbl">Replay</span></button>
              <button type="button" data-act="pgn" title="Download PGN">${icon('download')}<span class="lbl">PGN</span></button>
              <button type="button" data-act="delete" title="Delete" aria-label="Delete">${icon('trash-2')}</button>
            </div>
          </div>`;
        })
        .join(''),
    );
  }

  async function refresh() {
    msg('Loading…');
    try {
      games = await store.list();
      msg('');
    } catch (err) {
      games = [];
      msg(`Could not load games: ${err.message || err}`);
    }
    render();
  }

  $('#games-list').on('click', 'button[data-act]', async (e) => {
    const g = games[Number($(e.currentTarget).closest('.game-row').data('i'))];
    if (!g) return;
    const act = e.currentTarget.dataset.act;
    if (act === 'replay') {
      $modal[0].close();
      onReplay(g);
    } else if (act === 'pgn') {
      try {
        download(recordToPgn(g), `chess-${(g.white || 'white').replace(/\W+/g, '_')}-vs-${(g.black || 'black').replace(/\W+/g, '_')}-${g.id}.pgn`, 'application/x-chess-pgn');
      } catch (err) {
        msg(`Export failed: ${err.message || err}`);
      }
    } else if (act === 'delete') {
      if (!confirm(`Delete ${g.white || '?'} vs ${g.black || '?'}? This cannot be undone.`)) return;
      try {
        await store.remove(g.id);
        onDeleted(g.id);
        await refresh();
      } catch (err) {
        msg(`Delete failed: ${err.message || err}`);
      }
    }
  });

  function exportAll(kind) {
    if (!games.length) return msg('Nothing to export.');
    if (kind === 'json') return download(exportJson(games), `chess-games-${today()}.json`, 'application/json');
    const parts = [];
    let bad = 0;
    for (const g of games) {
      try {
        parts.push(recordToPgn(g));
      } catch {
        bad++;
      }
    }
    download(parts.join('\n\n') + '\n', `chess-games-${today()}.pgn`, 'application/x-chess-pgn');
    if (bad) msg(`${bad} corrupt game(s) skipped.`);
  }

  $('#games-export-pgn').on('click', () => exportAll('pgn'));
  $('#games-export-json').on('click', () => exportAll('json'));

  $('#games-import').on('click', () => {
    $('#import-box').prop('hidden', false);
    $('#import-text').val('').trigger('focus');
  });
  $('#import-cancel').on('click', () => $('#import-box').prop('hidden', true));
  $('#import-file').on('click', () => $('#games-file').trigger('click'));
  $('#games-file').on('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5_000_000) return msg('File too large (max 5 MB).');
    $('#import-text').val(await file.text());
  });
  $('#import-go').on('click', async () => {
    const text = String($('#import-text').val());
    if (!text.trim()) return msg('Paste PGN/JSON or choose a file first.');
    const { games: parsed, errors } = parseImport(text);
    if (!parsed.length) return msg(`Nothing imported. ${errors.slice(0, 3).join(' · ')}`);
    msg(`Importing ${parsed.length} game(s)…`);
    try {
      await store.importMany(parsed);
      $('#import-box').prop('hidden', true);
      await refresh();
      const errText = errors.length ? ` ${errors.length} skipped: ${errors.slice(0, 3).join(' · ')}${errors.length > 3 ? ' …' : ''}` : '';
      msg(`Imported ${parsed.length} game(s).${errText}`);
    } catch (err) {
      msg(`Import failed: ${err.message || err}`);
    }
  });

  $('#games-close').on('click', () => $modal[0].close());

  return {
    async open() {
      $('#import-box').prop('hidden', true);
      $modal[0].showModal();
      await beforeOpen();
      await refresh();
    },
  };
}
