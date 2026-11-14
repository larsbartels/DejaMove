import { useCallback, useEffect, useState } from 'react';
import { ChessBoardView } from './components/ChessBoardView';
import type { BoardStateResponse, GameStatus, LegalMove, Side } from './types';
import './App.css';

interface HistoryEntry {
  fen: string;
  sideToMove: Side;
  status: GameStatus;
  legalMoves: LegalMove[];
  uci?: string;
  san?: string;
}

export function App() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [orientation, setOrientation] = useState<Side>('white');
  const [coreStatus, setCoreStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadInitialBoard = useCallback(async () => {
    try {
      const ping = await window.dejamove.rpc<{ ok: boolean }>('ping');
      if (!ping.ok) throw new Error('Core ping failed');
      const init = await window.dejamove.rpc<BoardStateResponse>('board.initial');
      setHistory([
        {
          fen: init.fen,
          sideToMove: init.sideToMove,
          status: init.status,
          legalMoves: init.legalMoves,
        },
      ]);
      setCursor(0);
      setCoreStatus('ready');
      setErrorMsg(null);
    } catch (err) {
      setCoreStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadInitialBoard();
  }, [loadInitialBoard]);

  const current = history[cursor];

  const handleMove = useCallback(
    async (uci: string) => {
      if (!current) return;
      try {
        const res = await window.dejamove.rpc<BoardStateResponse>('board.applyMove', {
          fen: current.fen,
          move: uci,
        });
        if (!res.valid) return;
        const nextEntry: HistoryEntry = {
          fen: res.fen,
          sideToMove: res.sideToMove,
          status: res.status,
          legalMoves: res.legalMoves,
          uci: res.uci,
          san: res.san,
        };
        setHistory((prev) => [...prev.slice(0, cursor + 1), nextEntry]);
        setCursor((prev) => prev + 1);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    },
    [current, cursor],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
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

  const lastMove: [string, string] | undefined =
    current?.uci && current.uci.length >= 4
      ? [current.uci.slice(0, 2), current.uci.slice(2, 4)]
      : undefined;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <h1>DejaMove</h1>
          <span className={`status-pill ${coreStatus}`}>
            {coreStatus === 'ready'
              ? 'Core Connected'
              : coreStatus === 'connecting'
                ? 'Connecting...'
                : 'Core Error'}
          </span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
          >
            Flip Board
          </button>
          <button type="button" onClick={() => void loadInitialBoard()}>
            Reset
          </button>
        </div>
      </header>

      {errorMsg && <div className="error-banner">{errorMsg}</div>}

      <main className="workspace">
        <section className="board-pane">
          {current ? (
            <ChessBoardView
              fen={current.fen}
              orientation={orientation}
              turnColor={current.sideToMove}
              legalMoves={current.legalMoves}
              lastMove={lastMove}
              onMove={(uci) => void handleMove(uci)}
            />
          ) : (
            <div className="board-placeholder">Loading board...</div>
          )}
        </section>

        <aside className="side-pane">
          <div className="panel-card">
            <h2>Position</h2>
            {current && (
              <div className="meta-row">
                <span>Turn: {current.sideToMove}</span>
                <span>Status: {current.status}</span>
              </div>
            )}
            <div className="nav-controls">
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

          <div className="panel-card moves-card">
            <h2>Moves</h2>
            {history.length <= 1 ? (
              <p className="muted">Play moves on the board. Use Left/Right arrow keys to step.</p>
            ) : (
              <div className="move-list">
                {history.slice(1).map((entry, idx) => {
                  const ply = idx + 1;
                  const moveNum = Math.floor(idx / 2) + 1;
                  const isWhite = idx % 2 === 0;
                  return (
                    <button
                      key={`${ply}-${entry.uci}`}
                      type="button"
                      className={`move-chip ${cursor === ply ? 'active' : ''}`}
                      onClick={() => setCursor(ply)}
                    >
                      {isWhite ? `${moveNum}. ` : ''}
                      {entry.san}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
