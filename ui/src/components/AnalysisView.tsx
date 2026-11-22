import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChessBoardView } from './ChessBoardView';
import { EvalBar } from './EvalBar';
import { StockfishWasmService } from '../services/stockfishWorker';
import type {
  AnalysisPly,
  BoardArrow,
  BoardStateResponse,
  ContinuationOption,
  EngineLine,
  Side,
} from '../types';

export interface AnalysisHandoff {
  history: AnalysisPly[];
  cursor: number;
  orientation: Side;
}

interface AnalysisViewProps {
  handoff?: AnalysisHandoff | null;
  onReturnToTrainer?: () => void;
}

function formatLineEval(line: EngineLine): string {
  if (line.isMate) {
    return line.mateIn > 0 ? `#${line.mateIn}` : `-#${Math.abs(line.mateIn)}`;
  }
  const pawns = line.centipawns / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

export function AnalysisView({ handoff, onReturnToTrainer }: AnalysisViewProps) {
  const [history, setHistory] = useState<AnalysisPly[]>([]);
  const [cursor, setCursor] = useState(0);
  const [orientation, setOrientation] = useState<Side>('white');
  const [repertoireMoves, setRepertoireMoves] = useState<ContinuationOption[]>([]);
  const [engineEnabled, setEngineEnabled] = useState(false);
  const [multiPv, setMultiPv] = useState(3);
  const [targetDepth, setTargetDepth] = useState<number | 'infinite'>(20);
  const [engineLines, setEngineLines] = useState<EngineLine[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const engineRef = useRef<StockfishWasmService | null>(null);

  const loadInitial = useCallback(async () => {
    const init = await window.dejamove.rpc<BoardStateResponse>('board.initial');
    setHistory([
      {
        fen: init.fen,
        sideToMove: init.sideToMove,
        legalMoves: init.legalMoves,
      },
    ]);
    setCursor(0);
    setErrorMsg(null);
  }, []);

  useEffect(() => {
    if (handoff && handoff.history.length > 0) {
      setHistory(handoff.history);
      setCursor(Math.max(0, Math.min(handoff.cursor, handoff.history.length - 1)));
      setOrientation(handoff.orientation);
    } else if (history.length === 0) {
      void loadInitial();
    }
    // Sync when handoff changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff]);

  useEffect(() => {
    const svc = new StockfishWasmService((lines) => {
      setEngineLines(lines);
    });
    engineRef.current = svc;
    return () => {
      svc.destroy();
      engineRef.current = null;
    };
  }, []);

  const current = history[cursor];

  // Fetch repertoire continuations (red arrows) whenever position changes.
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    void window.dejamove
      .rpc<{ continuations: ContinuationOption[] }>('repertoire.continuationsAt', {
        fen: current.fen,
      })
      .then((res) => {
        if (!cancelled) {
          setRepertoireMoves(res.continuations ?? []);
        }
      })
      .catch((err) => {
        if (!cancelled) setErrorMsg(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [current]);

  // Trigger Stockfish analysis whenever enabled, position, MultiPV, or target depth changes.
  useEffect(() => {
    const svc = engineRef.current;
    if (!svc) return;
    if (!engineEnabled || !current) {
      svc.stop();
      setEngineLines([]);
      return;
    }
    svc.analyze(current.fen, multiPv, targetDepth, current.sideToMove);
  }, [engineEnabled, current, multiPv, targetDepth]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCursor((c) => Math.min(history.length - 1, c + 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setCursor(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setCursor(Math.max(0, history.length - 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [history.length]);

  const handleMove = async (uci: string) => {
    if (!current) return;
    const res = await window.dejamove.rpc<BoardStateResponse>('board.applyMove', {
      fen: current.fen,
      move: uci,
    });
    if (!res.valid) return;
    const nextEntry: AnalysisPly = {
      fen: res.fen,
      sideToMove: res.sideToMove,
      legalMoves: res.legalMoves,
      uci: res.uci,
      san: res.san,
    };
    setHistory((prev) => [...prev.slice(0, cursor + 1), nextEntry]);
    setCursor((c) => c + 1);
  };

  const arrows: BoardArrow[] = useMemo(() => {
    const list: BoardArrow[] = [];
    for (const c of repertoireMoves) {
      if (c.uci.length >= 4) {
        list.push({
          orig: c.uci.slice(0, 2),
          dest: c.uci.slice(2, 4),
          brush: 'red',
        });
      }
    }
    if (engineEnabled) {
      for (const line of engineLines.slice(0, multiPv)) {
        const best = line.pvUci[0];
        if (best && best.length >= 4) {
          list.push({
            orig: best.slice(0, 2),
            dest: best.slice(2, 4),
            brush: 'blue',
          });
        }
      }
    }
    return list;
  }, [repertoireMoves, engineEnabled, engineLines, multiPv]);

  const lastMove: [string, string] | undefined =
    current?.uci && current.uci.length >= 4
      ? [current.uci.slice(0, 2), current.uci.slice(2, 4)]
      : undefined;

  return (
    <div className="workspace">
      <aside className="repertoire-pane">
        <div className="panel-card repertoire-card">
          <div className="panel-header-row">
            <h2>Analysis</h2>
            {onReturnToTrainer && (
              <button type="button" className="primary" onClick={onReturnToTrainer}>
                Back to Trainer
              </button>
            )}
          </div>

          <div className="form-row" style={{ marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
            >
              Flip Board
            </button>
            <button type="button" onClick={() => void loadInitial()}>
              Reset
            </button>
          </div>

          <div className="engine-controls">
            <div className="panel-header-row">
              <strong>
                Stockfish
                {engineEnabled && engineLines[0] ? ` (d${engineLines[0].depth})` : ''}
              </strong>
              <button
                type="button"
                className={engineEnabled ? 'primary' : ''}
                onClick={() => setEngineEnabled((v) => !v)}
              >
                {engineEnabled ? 'On' : 'Off'}
              </button>
            </div>
            <label className="inline-label">
              Top N moves
              <select value={multiPv} onChange={(e) => setMultiPv(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-label">
              Depth
              <select
                value={String(targetDepth)}
                onChange={(e) =>
                  setTargetDepth(
                    e.target.value === 'infinite' ? 'infinite' : Number(e.target.value),
                  )
                }
              >
                <option value="14">14</option>
                <option value="16">16</option>
                <option value="20">20</option>
                <option value="24">24</option>
                <option value="infinite">Infinite</option>
              </select>
            </label>

            {engineEnabled && (
              <div className="engine-lines">
                {engineLines.length === 0 ? (
                  <p className="muted">Analyzing...</p>
                ) : (
                  engineLines.slice(0, multiPv).map((l) => (
                    <div key={l.multipv} className="engine-line-row">
                      <span className="eval-pill">{formatLineEval(l)}</span>
                      <span className="pv-text">{l.pvUci.slice(0, 5).join(' ')}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="repertoire-hits">
            <strong>Repertoire Moves (Red)</strong>
            {repertoireMoves.length === 0 ? (
              <p className="muted">No repertoire moves at this position.</p>
            ) : (
              <ul className="repertoire-hit-list">
                {repertoireMoves.map((m) => (
                  <li key={`${m.segmentId}-${m.uci}`}>
                    <button
                      type="button"
                      className="link-chip"
                      onClick={() => void handleMove(m.uci)}
                    >
                      {m.san}
                    </button>
                    {m.description && <span className="muted"> — {m.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </aside>

      <section className="board-pane analysis-board-pane">
        {errorMsg && <div className="error-banner">{errorMsg}</div>}
        <EvalBar topLine={engineLines[0]} orientation={orientation} enabled={engineEnabled} />
        {current ? (
          <ChessBoardView
            fen={current.fen}
            orientation={orientation}
            turnColor={current.sideToMove}
            legalMoves={current.legalMoves}
            arrows={arrows}
            lastMove={lastMove}
            onMove={(uci) => void handleMove(uci)}
          />
        ) : (
          <div className="board-placeholder">Loading board...</div>
        )}
      </section>

      <aside className="side-pane">
        <div className="panel-card moves-card">
          <div className="panel-header-row">
            <h2>Moves</h2>
            <div className="nav-mini">
              <button type="button" disabled={cursor === 0} onClick={() => setCursor(0)}>
                |&lt;
              </button>
              <button
                type="button"
                disabled={cursor === 0}
                onClick={() => setCursor((c) => Math.max(0, c - 1))}
              >
                &lt;
              </button>
              <button
                type="button"
                disabled={cursor >= history.length - 1}
                onClick={() => setCursor((c) => Math.min(history.length - 1, c + 1))}
              >
                &gt;
              </button>
              <button
                type="button"
                disabled={cursor >= history.length - 1}
                onClick={() => setCursor(Math.max(0, history.length - 1))}
              >
                &gt;|
              </button>
            </div>
          </div>

          {history.length <= 1 ? (
            <p className="muted">Play any legal move. Red = repertoire, Blue = Stockfish.</p>
          ) : (
            <div className="move-grid">
              {Array.from({ length: Math.ceil((history.length - 1) / 2) }, (_, rowIdx) => {
                const whitePly = rowIdx * 2 + 1;
                const blackPly = rowIdx * 2 + 2;
                const whiteEntry = history[whitePly];
                const blackEntry = history[blackPly];
                return (
                  <div key={rowIdx} className="move-row">
                    <span className="move-num">{rowIdx + 1}.</span>
                    <button
                      type="button"
                      className={`move-cell ${cursor === whitePly ? 'active' : ''}`}
                      onClick={() => setCursor(whitePly)}
                    >
                      {whiteEntry.san}
                    </button>
                    {blackEntry ? (
                      <button
                        type="button"
                        className={`move-cell ${cursor === blackPly ? 'active' : ''}`}
                        onClick={() => setCursor(blackPly)}
                      >
                        {blackEntry.san}
                      </button>
                    ) : (
                      <span className="move-cell empty" />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
