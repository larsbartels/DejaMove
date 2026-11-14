import { useEffect, useMemo, useRef, useState } from 'react';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Key } from 'chessground/types';
import type { DrawShape } from 'chessground/draw';

import type { BoardArrow, LegalMove, Side } from '../types';

interface ChessBoardViewProps {
  fen: string;
  orientation: Side;
  turnColor: Side;
  legalMoves: LegalMove[];
  arrows?: BoardArrow[];
  lastMove?: [string, string];
  onMove: (uci: string) => void;
}

interface PendingPromotion {
  from: Key;
  to: Key;
}

export function ChessBoardView({
  fen,
  orientation,
  turnColor,
  legalMoves,
  arrows = [],
  lastMove,
  onMove,
}: ChessBoardViewProps) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<Api | null>(null);
  const [pendingPromo, setPendingPromo] = useState<PendingPromotion | null>(null);

  const dests = useMemo(() => {
    const map = new Map<Key, Key[]>();
    for (const m of legalMoves) {
      const from = m.from as Key;
      const to = m.to as Key;
      const list = map.get(from) ?? [];
      if (!list.includes(to)) {
        list.push(to);
      }
      map.set(from, list);
    }
    return map;
  }, [legalMoves]);

  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const legalMovesRef = useRef(legalMoves);
  legalMovesRef.current = legalMoves;

  useEffect(() => {
    if (!boardRef.current) return;
    const api = Chessground(boardRef.current, {
      fen,
      orientation,
      turnColor,
      movable: {
        free: false,
        color: turnColor,
        dests,
        showDests: true,
      },
      draggable: {
        enabled: true,
        showGhost: true,
      },
      selectable: {
        enabled: true,
      },
      events: {
        move: (orig, dest) => {
          const matching = legalMovesRef.current.filter((m) => m.from === orig && m.to === dest);
          if (matching.length === 0) return;
          if (matching.some((m) => m.promotion)) {
            setPendingPromo({ from: orig, to: dest });
          } else {
            onMoveRef.current(matching[0].uci);
          }
        },
      },
    });
    apiRef.current = api;
    const observer = new ResizeObserver(() => {
      api.redrawAll();
    });
    observer.observe(boardRef.current);

    return () => {
      observer.disconnect();
      api.destroy();
      apiRef.current = null;
    };
    // Initialize Chessground once on mount; updates are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const shapes: DrawShape[] = arrows.map((a) => ({
      orig: a.orig as Key,
      dest: a.dest as Key,
      brush: a.brush,
    }));
    api.set({
      fen,
      orientation,
      turnColor,
      lastMove: lastMove ? [lastMove[0] as Key, lastMove[1] as Key] : undefined,
      movable: {
        free: false,
        color: turnColor,
        dests,
      },
    });
    api.setAutoShapes(shapes);
  }, [fen, orientation, turnColor, dests, arrows, lastMove]);

  const choosePromotion = (piece: 'q' | 'r' | 'b' | 'n') => {
    if (!pendingPromo) return;
    const uci = `${pendingPromo.from}${pendingPromo.to}${piece}`;
    setPendingPromo(null);
    onMove(uci);
  };

  return (
    <div className="board-wrapper">
      <div ref={boardRef} className="chessground-board" />
      {pendingPromo && (
        <div className="promotion-overlay">
          <div className="promotion-dialog">
            <span>Promote to:</span>
            <div className="promotion-buttons">
              {(['q', 'r', 'b', 'n'] as const).map((p) => (
                <button key={p} type="button" onClick={() => choosePromotion(p)}>
                  {p.toUpperCase()}
                </button>
              ))}
              <button type="button" className="cancel" onClick={() => setPendingPromo(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
