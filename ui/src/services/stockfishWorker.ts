import type { EngineLine, Side } from '../types';

function parseInfoLine(line: string, sideToMove: Side): EngineLine | null {
  if (!line.startsWith('info ')) return null;
  const tokens = line.split(/\s+/);
  let depth = 0;
  let multipv = 1;
  let isMate = false;
  let centipawns = 0;
  let mateIn = 0;
  let hasScore = false;
  const pvUci: string[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === 'depth' && i + 1 < tokens.length) {
      depth = Number(tokens[++i]) || 0;
    } else if (tok === 'multipv' && i + 1 < tokens.length) {
      multipv = Number(tokens[++i]) || 1;
    } else if (tok === 'score' && i + 2 < tokens.length) {
      const kind = tokens[++i];
      const val = Number(tokens[++i]) || 0;
      const sign = sideToMove === 'black' ? -1 : 1;
      if (kind === 'cp') {
        isMate = false;
        centipawns = val * sign;
        hasScore = true;
      } else if (kind === 'mate') {
        isMate = true;
        mateIn = val * sign;
        hasScore = true;
      }
    } else if (tok === 'pv') {
      for (let j = i + 1; j < tokens.length; j++) {
        pvUci.push(tokens[j]);
      }
      break;
    }
  }

  if (!hasScore || pvUci.length === 0) return null;
  return { multipv, depth, isMate, centipawns, mateIn, pvUci };
}

export class StockfishWasmService {
  private worker: Worker | null = null;
  private ready = false;
  private pendingAnalyze: {
    fen: string;
    multiPv: number;
    depth: number;
    sideToMove: Side;
  } | null = null;
  private linesByPv = new Map<number, EngineLine>();
  private currentSide: Side = 'white';
  private onUpdate: (lines: EngineLine[]) => void;

  constructor(onUpdate: (lines: EngineLine[]) => void) {
    this.onUpdate = onUpdate;
  }

  start(): void {
    if (this.worker) return;
    const worker = new Worker('./stockfish/stockfish-19-lite-single.js');
    this.worker = worker;

    worker.onmessage = (event: MessageEvent<string>) => {
      const line = String(event.data ?? '').trim();
      if (!line) return;

      if (line === 'uciok') {
        worker.postMessage('isready');
        return;
      }
      if (line === 'readyok') {
        this.ready = true;
        if (this.pendingAnalyze) {
          const req = this.pendingAnalyze;
          this.pendingAnalyze = null;
          this.analyze(req.fen, req.multiPv, req.depth, req.sideToMove);
        }
        return;
      }
      if (line.startsWith('info ')) {
        const parsed = parseInfoLine(line, this.currentSide);
        if (parsed) {
          const prev = this.linesByPv.get(parsed.multipv);
          if (!prev || parsed.depth >= prev.depth) {
            this.linesByPv.set(parsed.multipv, parsed);
            const sorted = Array.from(this.linesByPv.values()).sort(
              (a, b) => a.multipv - b.multipv,
            );
            this.onUpdate(sorted);
          }
        }
      }
    };

    worker.postMessage('uci');
  }

  analyze(fen: string, multiPv: number, depth: number, sideToMove: Side): void {
    this.start();
    if (!this.worker) return;
    if (!this.ready) {
      this.pendingAnalyze = { fen, multiPv, depth, sideToMove };
      return;
    }
    this.currentSide = sideToMove;
    this.linesByPv.clear();
    this.worker.postMessage('stop');
    this.worker.postMessage(`setoption name MultiPV value ${Math.max(1, Math.min(5, multiPv))}`);
    this.worker.postMessage(`position fen ${fen}`);
    this.worker.postMessage(`go depth ${depth}`);
  }

  stop(): void {
    if (this.worker && this.ready) {
      this.worker.postMessage('stop');
    }
  }

  destroy(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
    }
  }
}
