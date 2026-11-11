// jQuery board renderer: squares, pieces, coordinates, flip, click + drag moves, promotion picker.
/* global $ */

const FILES = 'abcdefgh';
const PIECE_NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };

let pieceSet = 'cburnett';

/** Select the piece set folder under img/pieces/. */
export function setPieceSet(set) {
  pieceSet = set;
}

export function pieceUrl(color, type) {
  return `img/pieces/${pieceSet}/${color}${type.toUpperCase()}.svg`;
}

export class Board {
  /**
   * @param {jQuery} $root container element
   * @param {object} opts
   *   getMoves(square) -> verbose legal moves from that square
   *   onMove(from, to, promotion, dragged) -> called when the user makes a legal move
   * render() state also takes: autoQueen (skip the promotion picker),
   *   animate ({ from, to, ms } slide the piece that just landed on `to`)
   */
  constructor($root, opts) {
    this.opts = opts;
    this.state = { pieces: {}, orientation: 'w', coordMode: 'edge', lastMove: null, checkSquare: null, movable: null, autoQueen: false };
    this.selected = null;
    this.targets = new Map(); // dest square -> [verbose moves]
    this.drag = null;
    this.promoResolve = null;

    this.$root = $root.addClass('board-wrap');
    this.$board = $('<div class="board" role="grid" aria-label="Chess board"></div>').appendTo($root);
    this.$promo = $('<div class="promo" hidden></div>').appendTo($root);

    this._bind();
  }

  /** Merge new state and re-render. */
  render(partial = {}) {
    const { animate, ...rest } = partial;
    Object.assign(this.state, rest);
    const { pieces, orientation, coordMode, lastMove, checkSquare } = this.state;
    const ranks = orientation === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const files = orientation === 'w' ? [...FILES] : [...FILES].reverse();

    let html = '';
    ranks.forEach((rank, row) => {
      files.forEach((file, col) => {
        const sq = file + rank;
        const light = (FILES.indexOf(file) + rank) % 2 === 0;
        const cls = ['sq', light ? 'light' : 'dark'];
        if (lastMove && (lastMove.from === sq || lastMove.to === sq)) cls.push('last');
        if (checkSquare === sq) cls.push('check');
        let inner = '';
        if (coordMode === 'all') {
          inner += `<span class="coord coord-all">${sq}</span>`;
        } else if (coordMode === 'edge') {
          if (col === 0) inner += `<span class="coord coord-rank">${rank}</span>`;
          if (row === 7) inner += `<span class="coord coord-file">${file}</span>`;
        }
        const p = pieces[sq];
        if (p) {
          const color = p.color === 'w' ? 'White' : 'Black';
          inner += `<div class="piece" style="background-image:url(${pieceUrl(p.color, p.type)})" role="img" aria-label="${color} ${PIECE_NAMES[p.type]}"></div>`;
        }
        html += `<div class="${cls.join(' ')}" data-sq="${sq}" role="gridcell" aria-label="${sq}">${inner}</div>`;
      });
    });
    this.$board.html(html);
    if (animate?.ms > 0) this._animate(animate);

    // Keep a valid selection across re-renders (e.g. coord toggle / flip mid-selection).
    if (this.selected && this._canMove(pieces[this.selected])) this._select(this.selected);
    else this._deselect();
  }

  /** FLIP: draw the moved piece at its origin square, then transition it home. */
  _animate({ from, to, ms }) {
    const $from = this._$sq(from);
    const $piece = this._$sq(to).children('.piece');
    if (!$from.length || !$piece.length) return;
    const a = $from[0].getBoundingClientRect();
    const b = $piece[0].getBoundingClientRect();
    const el = $piece[0];
    el.style.transition = 'none';
    el.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`;
    el.style.zIndex = '5';
    void el.offsetWidth; // force reflow so the start position sticks
    el.style.transition = `transform ${ms}ms ease-out`;
    el.style.transform = '';
    setTimeout(() => {
      el.style.transition = '';
      el.style.zIndex = '';
    }, ms + 20);
  }

  _canMove(piece) {
    const m = this.state.movable;
    return !!piece && (m === 'both' || m === piece.color);
  }

  _$sq(sq) {
    return this.$board.children(`[data-sq="${sq}"]`);
  }

  _select(sq) {
    this._clearHints();
    this.selected = sq;
    this.targets = new Map();
    for (const m of this.opts.getMoves(sq)) {
      if (!this.targets.has(m.to)) this.targets.set(m.to, []);
      this.targets.get(m.to).push(m);
    }
    this._$sq(sq).addClass('sel');
    for (const to of this.targets.keys()) {
      this._$sq(to).addClass(this.state.pieces[to] || this.targets.get(to)[0].flags.includes('e') ? 'hint-capture' : 'hint');
    }
  }

  _clearHints() {
    this.$board.children().removeClass('sel hint hint-capture');
  }

  _deselect() {
    this.selected = null;
    this.targets = new Map();
    this._clearHints();
  }

  async _tryMove(from, to, dragged = false) {
    const moves = this.targets.get(to);
    if (!moves) return false;
    let promotion;
    if (moves.some((m) => m.promotion)) {
      promotion = this.state.autoQueen ? 'q' : await this._askPromotion(moves[0].color, to);
      if (!promotion) {
        this._deselect();
        return false;
      }
    }
    this._deselect();
    this.opts.onMove(from, to, promotion, dragged);
    return true;
  }

  _askPromotion(color, to) {
    return new Promise((resolve) => {
      this.promoResolve = resolve;
      const html = ['q', 'r', 'b', 'n']
        .map((t) => `<button type="button" class="promo-btn" data-p="${t}" title="${PIECE_NAMES[t]}" style="background-image:url(${pieceUrl(color, t)})"></button>`)
        .join('');
      this.$promo.html(`<div class="promo-box" role="dialog" aria-label="Promote pawn on ${to}">${html}</div>`).prop('hidden', false);
    });
  }

  _closePromotion(choice) {
    this.$promo.prop('hidden', true).empty();
    const r = this.promoResolve;
    this.promoResolve = null;
    r?.(choice);
  }

  _bind() {
    this.$promo.on('click', (e) => {
      const $btn = $(e.target).closest('.promo-btn');
      this._closePromotion($btn.length ? $btn.data('p') : null);
    });

    this.$board.on('pointerdown', '.sq', (e) => {
      if (e.button !== 0 || this.promoResolve) return;
      const sq = e.currentTarget.dataset.sq;
      if (this.selected && sq !== this.selected && this.targets.has(sq)) {
        e.preventDefault();
        this._tryMove(this.selected, sq);
        return;
      }
      const piece = this.state.pieces[sq];
      if (this._canMove(piece)) {
        e.preventDefault();
        const wasSelected = this.selected === sq;
        this._select(sq);
        this._startDrag(e, sq, wasSelected);
      } else {
        this._deselect();
      }
    });
  }

  _startDrag(e, from, wasSelected) {
    const $sq = this._$sq(from);
    const $piece = $sq.children('.piece');
    const size = $sq[0].getBoundingClientRect().width;
    const $ghost = $piece.clone().addClass('ghost').css({ width: size, height: size }).appendTo(document.body);
    const moveGhost = (ev) => $ghost.css({ left: ev.clientX - size / 2, top: ev.clientY - size / 2 });
    moveGhost(e);
    $piece.addClass('dragging');
    let moved = false;
    const startX = e.clientX;
    const startY = e.clientY;

    const onMove = (ev) => {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) moved = true;
      moveGhost(ev);
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const over = el && $(el).closest('.sq')[0];
      this.$board.children('.drag-over').removeClass('drag-over');
      if (over && this.targets.has(over.dataset.sq)) $(over).addClass('drag-over');
    };
    const onUp = (ev) => {
      $(document).off('pointermove', onMove).off('pointerup pointercancel', onUp);
      $ghost.remove();
      $piece.removeClass('dragging');
      this.$board.children('.drag-over').removeClass('drag-over');
      if (ev.type === 'pointercancel') return;
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const to = el && $(el).closest('.sq').data('sq');
      if (to && to !== from && this.targets.has(to)) {
        this._tryMove(from, to, true);
      } else if (to === from && wasSelected && !moved) {
        this._deselect(); // second click on the same piece toggles selection off
      }
    };
    $(document).on('pointermove', onMove).on('pointerup pointercancel', onUp);
  }
}
