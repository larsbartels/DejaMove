import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChessBoardView } from './ChessBoardView';
import { BoardSetupModal } from './BoardSetupModal';
import type {
  AddVariantResponse,
  BoardArrow,
  BoardStateResponse,
  LegalMove,
  Side,
  VariantSegment,
} from '../types';

interface EditorViewProps {
  segments: VariantSegment[];
  onRefresh: () => Promise<void>;
  onTrainVariant: (segmentId: string) => void;
}

interface EditorPly {
  fen: string;
  sideToMove: Side;
  legalMoves: LegalMove[];
  uci?: string;
  san?: string;
  description: string;
}

export function EditorView({ segments, onRefresh, onTrainVariant }: EditorViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recordingMode, setRecordingMode] = useState(false);
  const [branchSource, setBranchSource] = useState<{
    parentId: string;
    afterPly: number;
  } | null>(null);

  const [draftName, setDraftName] = useState('');
  const [draftSide, setDraftSide] = useState<Side>('white');
  const [orientation, setOrientation] = useState<Side>('white');
  const [history, setHistory] = useState<EditorPly[]>([]);
  const [cursor, setCursor] = useState(0);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [linkParentId, setLinkParentId] = useState('');

  const selectedSegment = useMemo(
    () => segments.find((s) => s.id === selectedId) ?? null,
    [segments, selectedId],
  );

  const loadBoardAtFen = useCallback(async (fen?: string) => {
    const res = await window.dejamove.rpc<BoardStateResponse>(
      fen ? 'board.state' : 'board.initial',
      fen ? { fen } : {},
    );
    if (!res.valid) {
      setErrorMsg(res.error ?? 'Invalid board FEN');
      return;
    }
    setHistory([
      {
        fen: res.fen,
        sideToMove: res.sideToMove,
        legalMoves: res.legalMoves,
        description: '',
      },
    ]);
    setCursor(0);
  }, []);

  const loadSegmentIntoBoard = useCallback(async (seg: VariantSegment) => {
    const startState = await window.dejamove.rpc<BoardStateResponse>('board.state', {
      fen: seg.startFen,
    });
    const plies: EditorPly[] = [
      {
        fen: startState.fen,
        sideToMove: startState.sideToMove,
        legalMoves: startState.legalMoves,
        description: '',
      },
    ];
    for (const m of seg.moves) {
      const st = await window.dejamove.rpc<BoardStateResponse>('board.state', { fen: m.fen });
      plies.push({
        fen: m.fen,
        sideToMove: st.sideToMove,
        legalMoves: st.legalMoves,
        uci: m.uci,
        san: m.san,
        description: m.description,
      });
    }
    setHistory(plies);
    setCursor(plies.length - 1);
    setOrientation(seg.side);
    setDraftName(seg.name);
    setDraftSide(seg.side);
    setRecordingMode(false);
    setBranchSource(null);
    setErrorMsg(null);
    setStatusMsg(null);
    setLinkParentId('');
  }, []);

  useEffect(() => {
    if (!recordingMode && !selectedSegment) {
      if (segments.length > 0) {
        setSelectedId(segments[0].id);
        void loadSegmentIntoBoard(segments[0]);
      } else {
        void loadBoardAtFen();
      }
    }
  }, [segments, selectedSegment, recordingMode, loadSegmentIntoBoard, loadBoardAtFen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCursor((c) => Math.min(history.length - 1, c + 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [history.length]);

  const startNewVariant = async () => {
    setSelectedId(null);
    setRecordingMode(true);
    setBranchSource(null);
    setDraftName('');
    setDraftSide('white');
    setOrientation('white');
    setErrorMsg(null);
    setStatusMsg(null);
    await loadBoardAtFen();
  };

  const startBranchFromCursor = async () => {
    if (!selectedSegment || cursor === 0) return;
    const branchFen = history[cursor].fen;
    setBranchSource({ parentId: selectedSegment.id, afterPly: cursor - 1 });
    setRecordingMode(true);
    setDraftName(`${selectedSegment.name} (Branch)`);
    setDraftSide(selectedSegment.side);
    setOrientation(selectedSegment.side);
    setErrorMsg(null);
    setStatusMsg('Play the new branch moves on the board, then click Save Branch.');
    await loadBoardAtFen(branchFen);
  };

  const handleBoardMove = async (uci: string) => {
    const current = history[cursor];
    if (!current) return;

    // If viewing a saved segment, playing a move switches into recording a branch from here.
    if (!recordingMode && selectedSegment) {
      const res = await window.dejamove.rpc<BoardStateResponse>('board.applyMove', {
        fen: current.fen,
        move: uci,
      });
      if (!res.valid) return;

      if (cursor === 0) {
        setRecordingMode(true);
        setBranchSource(null);
        setDraftName(`${selectedSegment.name} (Alt)`);
        setDraftSide(selectedSegment.side);
        setHistory([
          current,
          {
            fen: res.fen,
            sideToMove: res.sideToMove,
            legalMoves: res.legalMoves,
            uci: res.uci,
            san: res.san,
            description: '',
          },
        ]);
        setCursor(1);
        setStatusMsg('Recording new line. Continue playing moves and click Save Variant.');
      } else {
        setBranchSource({ parentId: selectedSegment.id, afterPly: cursor - 1 });
        setRecordingMode(true);
        setDraftName(`${selectedSegment.name} (Branch)`);
        setDraftSide(selectedSegment.side);
        setHistory([
          { ...current, uci: undefined, san: undefined, description: '' },
          {
            fen: res.fen,
            sideToMove: res.sideToMove,
            legalMoves: res.legalMoves,
            uci: res.uci,
            san: res.san,
            description: '',
          },
        ]);
        setCursor(1);
        setStatusMsg('Recording new branch. Continue playing moves and click Save Branch.');
      }
      return;
    }

    const res = await window.dejamove.rpc<BoardStateResponse>('board.applyMove', {
      fen: current.fen,
      move: uci,
    });
    if (!res.valid) return;

    const nextEntry: EditorPly = {
      fen: res.fen,
      sideToMove: res.sideToMove,
      legalMoves: res.legalMoves,
      uci: res.uci,
      san: res.san,
      description: '',
    };
    setHistory((prev) => [...prev.slice(0, cursor + 1), nextEntry]);
    setCursor((c) => c + 1);
  };

  const saveRecordedVariant = async () => {
    if (history.length <= 1) {
      setErrorMsg('Play at least one move on the board before saving.');
      return;
    }
    const moves = history.slice(1).map((h) => ({
      move: h.uci ?? h.san ?? '',
      description: h.description,
    }));

    const res = branchSource
      ? await window.dejamove.rpc<AddVariantResponse>('repertoire.branchFrom', {
          parentId: branchSource.parentId,
          afterPly: branchSource.afterPly,
          name: draftName.trim() || 'New Branch',
          moves,
        })
      : await window.dejamove.rpc<AddVariantResponse>('repertoire.addVariant', {
          name: draftName.trim() || 'New Variant',
          side: draftSide,
          startFen: history[0].fen,
          moves,
        });

    if (!res.ok) {
      setErrorMsg(res.error ?? 'Failed to save variant.');
      return;
    }

    setRecordingMode(false);
    setBranchSource(null);
    await onRefresh();
    setSelectedId(res.segmentId);
    setStatusMsg(
      res.splitOccurred
        ? 'Saved and automatically split existing variant at the branch point.'
        : 'Variant saved.',
    );
  };

  const handleRename = async () => {
    if (!selectedSegment || !draftName.trim()) return;
    await window.dejamove.rpc('repertoire.renameVariant', {
      id: selectedSegment.id,
      name: draftName.trim(),
    });
    await onRefresh();
    setStatusMsg('Renamed.');
  };

  const handleDescriptionChange = (text: string) => {
    setHistory((prev) =>
      prev.map((item, idx) => (idx === cursor ? { ...item, description: text } : item)),
    );
  };

  const saveSelectedMoveDescription = async () => {
    if (!selectedSegment || cursor === 0 || recordingMode) return;
    await window.dejamove.rpc('repertoire.setMoveDescription', {
      id: selectedSegment.id,
      plyIndex: cursor - 1,
      description: history[cursor]?.description ?? '',
    });
    await onRefresh();
    setStatusMsg('Description saved.');
  };

  const handleDelete = async () => {
    if (!selectedSegment) return;
    await window.dejamove.rpc('repertoire.removeVariant', { id: selectedSegment.id });
    setSelectedId(null);
    await onRefresh();
  };

  const handleLinkParent = async () => {
    if (!selectedSegment || !linkParentId) return;
    const res = await window.dejamove.rpc<{ ok: boolean; error?: string }>(
      'repertoire.linkParentChild',
      {
        parentId: linkParentId,
        childId: selectedSegment.id,
      },
    );
    if (!res.ok) {
      setErrorMsg(res.error ?? 'Could not link parent.');
      return;
    }
    setLinkParentId('');
    await onRefresh();
    setStatusMsg('Linked transposition parent.');
  };

  const compatibleParents = useMemo(() => {
    if (!selectedSegment) return [];
    return segments.filter((s) => {
      if (s.id === selectedSegment.id) return false;
      if (selectedSegment.parentIds.includes(s.id)) return false;
      const endNorm =
        s.moves.length > 0 ? s.moves[s.moves.length - 1].normalizedFen : s.startNormalizedFen;
      return endNorm === selectedSegment.startNormalizedFen;
    });
  }, [segments, selectedSegment]);

  const current = history[cursor];
  const lastMove: [string, string] | undefined =
    current?.uci && current.uci.length >= 4
      ? [current.uci.slice(0, 2), current.uci.slice(2, 4)]
      : undefined;

  // When at the end of a saved segment, show arrows for its child continuations.
  const childArrows: BoardArrow[] = useMemo(() => {
    if (recordingMode || !selectedSegment || cursor !== history.length - 1) return [];
    return selectedSegment.childIds
      .map((cid) => segments.find((s) => s.id === cid))
      .filter((c): c is VariantSegment => Boolean(c && c.moves.length > 0))
      .map((c) => ({
        orig: c.moves[0].uci.slice(0, 2),
        dest: c.moves[0].uci.slice(2, 4),
        brush: 'green' as const,
      }));
  }, [recordingMode, selectedSegment, cursor, history.length, segments]);

  return (
    <div className="workspace">
      <aside className="repertoire-pane">
        <div className="panel-card repertoire-card">
          <div className="panel-header-row">
            <h2>Repertoire ({segments.length})</h2>
            <button type="button" className="primary" onClick={() => void startNewVariant()}>
              + New
            </button>
          </div>
          <div className="variant-list">
            {segments.length === 0 ? (
              <p className="muted">No variants yet. Click + New to create one.</p>
            ) : (
              segments.map((seg) => {
                const eff = Math.round(seg.effectiveScore ?? seg.stats.score);
                const isSelected = !recordingMode && selectedSegment?.id === seg.id;
                return (
                  <button
                    key={seg.id}
                    type="button"
                    className={`variant-item ${isSelected ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedId(seg.id);
                      void loadSegmentIntoBoard(seg);
                    }}
                  >
                    <div className="variant-item-top">
                      <span className={`side-badge ${seg.side}`}>
                        {seg.side === 'white' ? 'W' : 'B'}
                      </span>
                      <span className="variant-name">{seg.name}</span>
                      <span className="score-badge">{eff}%</span>
                    </div>
                    <div className="variant-item-sub">
                      <span>{seg.moves.length} plies</span>
                      {seg.parentIds.length > 0 && (
                        <span>
                          {seg.parentIds.length === 1
                            ? '1 parent'
                            : `${seg.parentIds.length} parents`}
                        </span>
                      )}
                      {seg.childIds.length > 0 && <span>{seg.childIds.length} branches</span>}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </aside>

      <section className="board-pane">
        {current ? (
          <ChessBoardView
            fen={current.fen}
            orientation={orientation}
            turnColor={current.sideToMove}
            legalMoves={current.legalMoves}
            arrows={childArrows}
            lastMove={lastMove}
            onMove={(uci) => void handleBoardMove(uci)}
          />
        ) : (
          <div className="board-placeholder">Loading board...</div>
        )}
      </section>

      <aside className="side-pane">
        <div className="panel-card">
          <div className="panel-header-row">
            <h2>
              {recordingMode
                ? branchSource
                  ? 'New Branch'
                  : 'New Variant'
                : (selectedSegment?.name ?? 'Editor')}
            </h2>
            <button
              type="button"
              onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
            >
              Flip
            </button>
          </div>

          {errorMsg && <div className="error-banner">{errorMsg}</div>}
          {statusMsg && <div className="info-banner">{statusMsg}</div>}

          <div className="form-group">
            <label>
              Name
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Variant name..."
              />
            </label>
          </div>

          {recordingMode ? (
            <>
              {!branchSource && (
                <div className="form-row">
                  <label>
                    Side
                    <select
                      value={draftSide}
                      onChange={(e) => {
                        const s = e.target.value as Side;
                        setDraftSide(s);
                        setOrientation(s);
                      }}
                    >
                      <option value="white">White</option>
                      <option value="black">Black</option>
                    </select>
                  </label>
                  <button type="button" onClick={() => setShowSetupModal(true)}>
                    Board Setup...
                  </button>
                </div>
              )}
              <div className="form-row">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void saveRecordedVariant()}
                >
                  {branchSource ? 'Save Branch' : 'Save Variant'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRecordingMode(false);
                    setBranchSource(null);
                    if (selectedSegment) void loadSegmentIntoBoard(selectedSegment);
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            selectedSegment && (
              <div className="editor-actions">
                <div className="form-row">
                  <button type="button" onClick={() => void handleRename()}>
                    Rename
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onTrainVariant(selectedSegment.id)}
                  >
                    Train This
                  </button>
                  <button type="button" className="danger" onClick={() => void handleDelete()}>
                    Delete
                  </button>
                </div>

                {cursor > 0 && (
                  <button type="button" onClick={() => void startBranchFromCursor()}>
                    Branch From Move {cursor}
                  </button>
                )}

                {selectedSegment.childIds.length > 0 && (
                  <div className="links-row">
                    <span className="muted">Branches:</span>
                    {selectedSegment.childIds.map((cid) => {
                      const child = segments.find((s) => s.id === cid);
                      if (!child) return null;
                      return (
                        <button
                          key={cid}
                          type="button"
                          className="link-chip"
                          onClick={() => {
                            setSelectedId(cid);
                            void loadSegmentIntoBoard(child);
                          }}
                        >
                          {child.name}
                        </button>
                      );
                    })}
                  </div>
                )}

                {compatibleParents.length > 0 && (
                  <div className="form-row">
                    <select value={linkParentId} onChange={(e) => setLinkParentId(e.target.value)}>
                      <option value="">Link transposition parent...</option>
                      {compatibleParents.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!linkParentId}
                      onClick={() => void handleLinkParent()}
                    >
                      Link
                    </button>
                  </div>
                )}
              </div>
            )
          )}
        </div>

        <div className="panel-card moves-card">
          <div className="panel-header-row">
            <h2>Moves</h2>
            <div className="nav-mini">
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
            </div>
          </div>

          {history.length <= 1 ? (
            <p className="muted">
              {recordingMode
                ? 'Play moves on the board to build the variant.'
                : 'Select or create a variant.'}
            </p>
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

          {cursor > 0 && current && (
            <div className="description-box">
              <label>
                Move Note ({current.san})
                <textarea
                  rows={2}
                  value={current.description}
                  onChange={(e) => handleDescriptionChange(e.target.value)}
                  placeholder="Optional move description..."
                />
              </label>
              {!recordingMode && selectedSegment && (
                <button type="button" onClick={() => void saveSelectedMoveDescription()}>
                  Save Note
                </button>
              )}
            </div>
          )}
        </div>
      </aside>

      {showSetupModal && current && (
        <BoardSetupModal
          initialFen={history[0]?.fen ?? current.fen}
          onCancel={() => setShowSetupModal(false)}
          onConfirm={(fen) => {
            setShowSetupModal(false);
            void loadBoardAtFen(fen);
          }}
        />
      )}
    </div>
  );
}
