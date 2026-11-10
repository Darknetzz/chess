// Thin promise wrapper around the Stockfish WASM web worker (UCI protocol).

export class Engine {
  constructor(url) {
    this.url = url;
    this.worker = null;
    this.readyPromise = null;
    this.pending = null;      // { resolve } for the active search
    this.staleBestmoves = 0;  // bestmove replies to ignore after a 'stop'
    this.searching = false;
  }

  init() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(this.url);
      } catch (err) {
        reject(err);
        return;
      }
      this.worker.onerror = (e) => reject(e.message || e);
      this.worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : String(e.data ?? '');
        if (line === 'uciok') this.send('isready');
        else if (line === 'readyok') resolve();
        else if (line.startsWith('bestmove')) this._onBestmove(line);
      };
      this.send('uci');
    });
    return this.readyPromise;
  }

  send(cmd) {
    this.worker?.postMessage(cmd);
  }

  _onBestmove(line) {
    this.searching = false;
    if (this.staleBestmoves > 0) {
      this.staleBestmoves--;
      return;
    }
    const move = line.split(/\s+/)[1];
    const p = this.pending;
    this.pending = null;
    p?.resolve(move && move !== '(none)' ? move : null);
  }

  async newGame() {
    await this.init();
    this.cancel();
    this.send('ucinewgame');
  }

  // Resolves with a UCI move string ("e2e4", "e7e8q") or null if cancelled / no move.
  async bestMove(fen, level) {
    await this.init();
    this.cancel();
    const lvl = Math.max(0, Math.min(20, level | 0));
    return new Promise((resolve) => {
      this.pending = { resolve };
      this.send(`setoption name Skill Level value ${lvl}`);
      this.send(`position fen ${fen}`);
      this.send(`go depth ${lvl + 1} movetime ${50 + lvl * 50}`);
      this.searching = true;
    });
  }

  cancel() {
    if (this.pending) {
      this.pending.resolve(null);
      this.pending = null;
    }
    if (this.searching) {
      this.staleBestmoves++;
      this.searching = false;
      this.send('stop');
    }
  }
}
