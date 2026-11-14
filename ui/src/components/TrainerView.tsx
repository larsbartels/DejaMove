import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChessBoardView } from './ChessBoardView';
import type { AnalysisHandoff } from './AnalysisView';
import type {
  AnalysisPly,
  BoardArrow,
  BoardStateResponse,
  Side,
  TrainingSessionState,
  TrainingStartResponse,
  TrainingSubmitResponse,
  VariantSegment,
} from '../types';

interface TrainerViewProps {
  segments: VariantSegment[];
  initialSegmentId: string | null;
  resumedSession?: TrainingSessionState | null;
  onRefresh: () => Promise<void>;
  onOpenInAnalysis: (session: TrainingSessionState, handoff: AnalysisHandoff) => void;
}

export function TrainerView({
  segments,
  initialSegmentId,
  resumedSession,
  onRefresh,
  onOpenInAnalysis,
}: TrainerViewProps) {
  const [session, setSession] = useState<TrainingSessionState | null>(resumedSession ?? null);
  const [selectedId, setSelectedId] = useState<string>(initialSegmentId ?? '');
  const [sideFilter, setSideFilter] = useState<'all' | Side>('all');
  const [wrongArrow, setWrongArrow] = useState<BoardArrow | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const turnStartMsRef = useRef<number>(performance.now());

  const startSession = useCallback(
    async (mode: 'specific' | 'smartRandom', segmentId?: string) => {
      setErrorMsg(null);
      setWrongArrow(null);
      const params: Record<string, unknown> = { mode };
      if (mode === 'specific' && segmentId) {
        params.segmentId = segmentId;
      } else if (mode === 'smartRandom' && sideFilter !== 'all') {
        params.side = sideFilter;
      }
      const res = await window.dejamove.rpc<TrainingStartResponse>('training.start', params);
      if (!res.ok || !res.session) {
        setErrorMsg(res.error ?? 'Could not start training session.');
        return;
      }
      setSession(res.session);
      turnStartMsRef.current = performance.now();
    },
    [sideFilter],
  );

  useEffect(() => {
    if (resumedSession) {
      setSession(resumedSession);
      turnStartMsRef.current = performance.now();
      return;
    }
    if (initialSegmentId) {
      setSelectedId(initialSegmentId);
      void startSession('specific', initialSegmentId);
    } else if (!session && segments.length > 0) {
      void startSession('smartRandom');
    }
    // Only auto-start when entering Trainer or when initialSegmentId/resumedSession changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSegmentId, resumedSession]);

  const handleOpenInAnalysis = async () => {
    if (!session) return;
    const startState = await window.dejamove.rpc<BoardStateResponse>('board.state', {
      fen: session.startFen,
    });
    const history: AnalysisPly[] = [
      {
        fen: startState.fen,
        sideToMove: startState.sideToMove,
        legalMoves: startState.legalMoves,
      },
    ];
    for (const h of session.history) {
      const st = await window.dejamove.rpc<BoardStateResponse>('board.state', { fen: h.fen });
      history.push({
        fen: st.fen,
        sideToMove: st.sideToMove,
        legalMoves: st.legalMoves,
        uci: h.uci,
        san: h.san,
      });
    }
    onOpenInAnalysis(session, {
      history,
      cursor: history.length - 1,
      orientation: session.userSide,
    });
  };

  const handleUserMove = async (uci: string) => {
    if (!session || !session.active || session.completed || session.awaitingMistakeAdvance) {
      return;
    }
    const elapsedMs = Math.round(performance.now() - turnStartMsRef.current);
    const res = await window.dejamove.rpc<TrainingSubmitResponse>('training.submitMove', {
      move: uci,
      elapsedMs,
    });
    if (!res.accepted) {
      setErrorMsg(res.error ?? 'Move not accepted.');
      return;
    }

    setErrorMsg(null);
    setSession(res.session);

    if (!res.correct && uci.length >= 4) {
      setWrongArrow({ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'red' });
    } else {
      setWrongArrow(null);
      turnStartMsRef.current = performance.now();
    }

    if (res.session.completed) {
      await onRefresh();
    }
  };

  const handleAdvanceMistake = useCallback(async () => {
    if (!session?.awaitingMistakeAdvance) return;
    const res = await window.dejamove.rpc<{ session: TrainingSessionState }>(
      'training.advanceAfterMistake',
    );
    setWrongArrow(null);
    setSession(res.session);
    turnStartMsRef.current = performance.now();
    if (res.session.completed) {
      await onRefresh();
    }
  }, [session?.awaitingMistakeAdvance, onRefresh]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if ((e.key === ' ' || e.key === 'Enter') && session?.awaitingMistakeAdvance) {
        e.preventDefault();
        void handleAdvanceMistake();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session?.awaitingMistakeAdvance, handleAdvanceMistake]);

  const arrows: BoardArrow[] = useMemo(() => {
    const list: BoardArrow[] = [];
    if (wrongArrow) list.push(wrongArrow);
    if (session?.awaitingMistakeAdvance) {
      for (const opt of session.pendingExpectedMoves) {
        if (opt.uci.length >= 4) {
          list.push({
            orig: opt.uci.slice(0, 2),
            dest: opt.uci.slice(2, 4),
            brush: 'green',
          });
        }
      }
    }
    return list;
  }, [wrongArrow, session]);

  const lastPlayed = session?.history[session.history.length - 1];
  const lastMove: [string, string] | undefined =
    lastPlayed?.uci && lastPlayed.uci.length >= 4
      ? [lastPlayed.uci.slice(0, 2), lastPlayed.uci.slice(2, 4)]
      : undefined;

  const canMove = Boolean(
    session &&
    session.active &&
    !session.completed &&
    !session.awaitingMistakeAdvance &&
    session.sideToMove === session.userSide,
  );

  return (
    <div className="workspace">
      <aside className="repertoire-pane">
        <div className="panel-card repertoire-card">
          <h2>Training Mode</h2>

          <div className="form-group">
            <label>
              Smart Random Side
              <select
                value={sideFilter}
                onChange={(e) => setSideFilter(e.target.value as 'all' | Side)}
              >
                <option value="all">Both Sides</option>
                <option value="white">White Only</option>
                <option value="black">Black Only</option>
              </select>
            </label>
            <button
              type="button"
              className="primary"
              disabled={segments.length === 0}
              onClick={() => void startSession('smartRandom')}
            >
              Smart Random
            </button>
          </div>

          <div className="form-group" style={{ marginTop: 12 }}>
            <label>
              Specific Variant
              <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                <option value="">Choose variant...</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    [{s.side === 'white' ? 'W' : 'B'}] {s.name} (
                    {Math.round(s.effectiveScore ?? s.stats.score)}%)
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!selectedId}
              onClick={() => void startSession('specific', selectedId)}
            >
              Train Selected
            </button>
          </div>

          {session && (
            <div className="trainer-status-card">
              <div className="meta-row">
                <strong>{session.currentSegmentName || 'Variant'}</strong>
                <span className={`side-badge ${session.userSide}`}>
                  {session.userSide === 'white' ? 'W' : 'B'}
                </span>
              </div>
              <button type="button" onClick={() => void handleOpenInAnalysis()}>
                Open in Analysis
              </button>
              {!session.completed && !session.awaitingMistakeAdvance && (
                <p className="muted">Play {session.userSide}&apos;s next move on the board.</p>
              )}
              {session.awaitingMistakeAdvance && (
                <div className="mistake-box">
                  <p>
                    Expected:{' '}
                    <strong>{session.pendingExpectedMoves.map((m) => m.san).join(' or ')}</strong>
                  </p>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void handleAdvanceMistake()}
                  >
                    Continue Line (Space)
                  </button>
                </div>
              )}
              {session.completed && (
                <div className="completed-box">
                  <strong>Line Complete</strong>
                  {session.scoreDeltas.map((d) => (
                    <div key={d.segmentId} className="score-delta-row">
                      <span>{d.name}</span>
                      <span className={d.passed ? 'pass' : 'fail'}>
                        {Math.round(d.previousScore)}% → {Math.round(d.newScore)}%
                      </span>
                    </div>
                  ))}
                  <div className="form-row" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void startSession('smartRandom')}
                    >
                      Next (Smart)
                    </button>
                    <button
                      type="button"
                      onClick={() => void startSession('specific', session.startSegmentId)}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      <section className="board-pane">
        {errorMsg && <div className="error-banner">{errorMsg}</div>}
        {session ? (
          <ChessBoardView
            fen={session.currentFen}
            orientation={session.userSide}
            turnColor={session.sideToMove}
            legalMoves={canMove ? session.legalMoves : []}
            arrows={arrows}
            lastMove={lastMove}
            onMove={(uci) => void handleUserMove(uci)}
          />
        ) : (
          <div className="board-placeholder">
            {segments.length === 0
              ? 'Add variants in the Repertoire Editor first.'
              : 'Select a variant or click Smart Random to begin.'}
          </div>
        )}
      </section>

      <aside className="side-pane">
        <div className="panel-card moves-card">
          <h2>Played Moves</h2>
          {!session || session.history.length === 0 ? (
            <p className="muted">Moves will appear here as the line progresses.</p>
          ) : (
            <div className="move-grid">
              {Array.from({ length: Math.ceil(session.history.length / 2) }, (_, rowIdx) => {
                const w = session.history[rowIdx * 2];
                const b = session.history[rowIdx * 2 + 1];
                return (
                  <div key={rowIdx} className="move-row">
                    <span className="move-num">{rowIdx + 1}.</span>
                    <span className={`move-cell ${w?.wasMistake ? 'mistake' : ''}`}>{w?.san}</span>
                    {b ? (
                      <span className={`move-cell ${b.wasMistake ? 'mistake' : ''}`}>{b.san}</span>
                    ) : (
                      <span className="move-cell empty" />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {lastPlayed?.description && (
            <div className="description-box">
              <span className="muted">Note ({lastPlayed.san}):</span>
              <p style={{ margin: '4px 0 0', fontSize: '0.85rem' }}>{lastPlayed.description}</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
