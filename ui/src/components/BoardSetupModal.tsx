import { useState } from 'react';
import type { BoardStateResponse, Side } from '../types';

interface BoardSetupModalProps {
  initialFen: string;
  onConfirm: (fen: string) => void;
  onCancel: () => void;
}

const PIECE_SYMBOLS: Record<string, string> = {
  K: '♔',
  Q: '♕',
  R: '♖',
  B: '♗',
  N: '♘',
  P: '♙',
  k: '♚',
  q: '♛',
  r: '♜',
  b: '♝',
  n: '♞',
  p: '♟',
};

const PALETTE = ['K', 'Q', 'R', 'B', 'N', 'P', 'k', 'q', 'r', 'b', 'n', 'p'] as const;

const STANDARD_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

function parsePlacement(fen: string): (string | null)[][] {
  const placement = fen.split(' ')[0] || STANDARD_PLACEMENT;
  const rows = placement.split('/');
  const grid: (string | null)[][] = [];
  for (let r = 0; r < 8; r++) {
    const row: (string | null)[] = [];
    const str = rows[r] ?? '8';
    for (const ch of str) {
      if (ch >= '1' && ch <= '8') {
        for (let k = 0; k < Number(ch); k++) row.push(null);
      } else {
        row.push(ch);
      }
    }
    while (row.length < 8) row.push(null);
    grid.push(row.slice(0, 8));
  }
  return grid;
}

function gridToPlacement(grid: (string | null)[][]): string {
  return grid
    .map((row) => {
      let out = '';
      let empty = 0;
      for (const cell of row) {
        if (!cell) {
          empty++;
        } else {
          if (empty > 0) {
            out += String(empty);
            empty = 0;
          }
          out += cell;
        }
      }
      if (empty > 0) out += String(empty);
      return out;
    })
    .join('/');
}

export function BoardSetupModal({ initialFen, onConfirm, onCancel }: BoardSetupModalProps) {
  const parts = initialFen.split(' ');
  const [grid, setGrid] = useState<(string | null)[][]>(() => parsePlacement(initialFen));
  const [turn, setTurn] = useState<Side>(parts[1] === 'b' ? 'black' : 'white');
  const [castling, setCastling] = useState(parts[2] ?? 'KQkq');
  const [selectedTool, setSelectedTool] = useState<string | null>('P');
  const [fenInput, setFenInput] = useState(initialFen);
  const [error, setError] = useState<string | null>(null);

  const syncFen = (nextGrid: (string | null)[][], nextTurn: Side, nextCastling: string) => {
    const placement = gridToPlacement(nextGrid);
    const c = nextCastling.trim() || '-';
    const fen = `${placement} ${nextTurn === 'white' ? 'w' : 'b'} ${c} - 0 1`;
    setFenInput(fen);
    setError(null);
    return fen;
  };

  const handleSquareClick = (r: number, c: number) => {
    const next = grid.map((row) => [...row]);
    if (selectedTool === null) {
      next[r][c] = null;
    } else {
      next[r][c] = next[r][c] === selectedTool ? null : selectedTool;
    }
    setGrid(next);
    syncFen(next, turn, castling);
  };

  const toggleCastling = (flag: string) => {
    const current = castling === '-' ? '' : castling;
    const next = current.includes(flag)
      ? current.replace(flag, '')
      : ['K', 'Q', 'k', 'q'].filter((f) => f === flag || current.includes(f)).join('');
    const finalCastling = next || '-';
    setCastling(finalCastling);
    syncFen(grid, turn, finalCastling);
  };

  const applyFenInput = () => {
    const p = fenInput.trim().split(' ');
    setGrid(parsePlacement(fenInput.trim()));
    setTurn(p[1] === 'b' ? 'black' : 'white');
    setCastling(p[2] ?? '-');
    setError(null);
  };

  const handleConfirm = async () => {
    const res = await window.dejamove.rpc<BoardStateResponse>('board.state', {
      fen: fenInput.trim(),
    });
    if (!res.valid) {
      setError(res.error ?? 'Invalid chess position (ensure both kings are present).');
      return;
    }
    onConfirm(res.fen);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card setup-modal">
        <div className="modal-header">
          <h2>Custom Starting Position</h2>
          <button type="button" onClick={onCancel}>
            Close
          </button>
        </div>

        <div className="setup-body">
          <div className="setup-board">
            {grid.map((row, r) =>
              row.map((piece, c) => {
                const dark = (r + c) % 2 === 1;
                return (
                  <button
                    key={`${r}-${c}`}
                    type="button"
                    className={`setup-square ${dark ? 'dark' : 'light'}`}
                    onClick={() => handleSquareClick(r, c)}
                  >
                    {piece ? PIECE_SYMBOLS[piece] : ''}
                  </button>
                );
              }),
            )}
          </div>

          <div className="setup-controls">
            <div className="palette-grid">
              {PALETTE.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`palette-btn ${selectedTool === p ? 'active' : ''}`}
                  onClick={() => setSelectedTool(p)}
                >
                  {PIECE_SYMBOLS[p]}
                </button>
              ))}
              <button
                type="button"
                className={`palette-btn erase ${selectedTool === null ? 'active' : ''}`}
                onClick={() => setSelectedTool(null)}
              >
                Erase
              </button>
            </div>

            <div className="setup-row">
              <span>Side to move:</span>
              <button
                type="button"
                className={turn === 'white' ? 'active' : ''}
                onClick={() => {
                  setTurn('white');
                  syncFen(grid, 'white', castling);
                }}
              >
                White
              </button>
              <button
                type="button"
                className={turn === 'black' ? 'active' : ''}
                onClick={() => {
                  setTurn('black');
                  syncFen(grid, 'black', castling);
                }}
              >
                Black
              </button>
            </div>

            <div className="setup-row">
              <span>Castling:</span>
              {(['K', 'Q', 'k', 'q'] as const).map((flag) => (
                <button
                  key={flag}
                  type="button"
                  className={castling.includes(flag) ? 'active' : ''}
                  onClick={() => toggleCastling(flag)}
                >
                  {flag}
                </button>
              ))}
            </div>

            <div className="setup-row">
              <button
                type="button"
                onClick={() => {
                  const g = parsePlacement(STANDARD_PLACEMENT);
                  setGrid(g);
                  setTurn('white');
                  setCastling('KQkq');
                  syncFen(g, 'white', 'KQkq');
                }}
              >
                Initial
              </button>
              <button
                type="button"
                onClick={() => {
                  const g = parsePlacement('8/8/8/8/8/8/8/8');
                  setGrid(g);
                  setCastling('-');
                  syncFen(g, turn, '-');
                }}
              >
                Clear
              </button>
            </div>

            <div className="fen-row">
              <input
                type="text"
                value={fenInput}
                onChange={(e) => setFenInput(e.target.value)}
                placeholder="Paste FEN..."
              />
              <button type="button" onClick={applyFenInput}>
                Load FEN
              </button>
            </div>

            {error && <div className="error-banner">{error}</div>}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void handleConfirm()}>
            Use Position
          </button>
        </div>
      </div>
    </div>
  );
}
