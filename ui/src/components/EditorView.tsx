import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ChessBoardView } from './ChessBoardView';
import { BoardSetupModal } from './BoardSetupModal';
import type {
  AddVariantResponse,
  BoardArrow,
  BoardStateResponse,
  EditVariantResponse,
  EditorTargetLocation,
  FindByFenResponse,
  LegalMove,
  PositionMatch,
  Side,
  VariantSegment,
} from '../types';

interface EditorViewProps {
  segments: VariantSegment[];
  targetLocation?: EditorTargetLocation | null;
  onRefresh: () => Promise<void>;
  onTrainVariant: (segmentId: string) => void;
  onOpenFenInAnalysis: (fen: string) => void;
}

function formatMatchLocation(m: PositionMatch): string {
  if (m.matchKind === 'start') return 'Start';
  if (m.matchKind === 'end') return m.moveSan ? `End (${m.moveSan})` : 'End';
  return m.moveSan ? `After ${m.moveSan}` : `Ply ${m.plyIndex}`;
}

function getVariantLabel(seg: VariantSegment): string {
  return seg.displayName || seg.name || 'Variant';
}

interface EditorPly {
  fen: string;
  sideToMove: Side;
  legalMoves: LegalMove[];
  uci?: string;
  san?: string;
  description: string;
}

export function EditorView({
  segments,
  targetLocation,
  onRefresh,
  onTrainVariant,
  onOpenFenInAnalysis,
}: EditorViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadTargetId, setReloadTargetId] = useState<string | null>(null);
  const [recordingMode, setRecordingMode] = useState(false);
  const [branchSource, setBranchSource] = useState<{
    parentId: string;
    afterPly: number;
  } | null>(null);
  const [extendTargetId, setExtendTargetId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [draftName, setDraftName] = useState('');
  const [draftSide, setDraftSide] = useState<Side>('white');
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [orientation, setOrientation] = useState<Side>('white');
  const [history, setHistory] = useState<EditorPly[]>([]);
  const [cursor, setCursor] = useState(0);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [variantSearch, setVariantSearch] = useState('');
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
  const [fenQuery, setFenQuery] = useState('');
  const [fenSearchResult, setFenSearchResult] = useState<FindByFenResponse | null>(null);
  const [fenSearchError, setFenSearchError] = useState<string | null>(null);

  const selectedSegment = useMemo(
    () => segments.find((s) => s.id === selectedId) ?? null,
    [segments, selectedId],
  );

  const allTags = useMemo(() => {
    const seen = new Map<string, string>();
    for (const seg of segments) {
      for (const tag of seg.tags ?? []) {
        const key = tag.toLowerCase();
        if (!seen.has(key)) {
          seen.set(key, tag);
        }
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [segments]);

  const filteredSegments = useMemo(() => {
    const q = variantSearch.trim().toLowerCase();
    const tagFilter = activeTagFilter?.toLowerCase() ?? null;

    return segments.filter((seg) => {
      const segTags = seg.tags ?? [];
      if (tagFilter && !segTags.some((t) => t.toLowerCase() === tagFilter)) {
        return false;
      }
      if (!q) return true;
      if (q.startsWith('#')) {
        const tagQuery = q.slice(1).trim();
        if (!tagQuery) return segTags.length > 0;
        return segTags.some((t) => t.toLowerCase().includes(tagQuery));
      }
      const label = getVariantLabel(seg).toLowerCase();
      return label.includes(q) || segTags.some((t) => t.toLowerCase().includes(q));
    });
  }, [segments, variantSearch, activeTagFilter]);

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

  const loadSegmentIntoBoard = useCallback(
    async (seg: VariantSegment, targetCursor?: number, keepStatus = false) => {
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
      const nextCursor =
        targetCursor !== undefined
          ? Math.max(0, Math.min(targetCursor, plies.length - 1))
          : plies.length - 1;
      setHistory(plies);
      setCursor(nextCursor);
      setOrientation(seg.side);
      setDraftName(seg.name);
      setDraftSide(seg.side);
      setDraftTags(seg.tags ?? []);
      setTagInput('');
      setRecordingMode(false);
      setBranchSource(null);
      setExtendTargetId(null);
      setConfirmDeleteId(null);
      setErrorMsg(null);
      if (!keepStatus) {
        setStatusMsg(null);
      }
    },
    [],
  );

  useEffect(() => {
    if (!reloadTargetId) return;
    const seg = segments.find((s) => s.id === reloadTargetId);
    if (seg) {
      setSelectedId(seg.id);
      setReloadTargetId(null);
      void loadSegmentIntoBoard(seg, undefined, true);
    }
  }, [reloadTargetId, segments, loadSegmentIntoBoard]);

  useEffect(() => {
    if (!targetLocation) return;
    const seg = segments.find((s) => s.id === targetLocation.segmentId);
    if (seg) {
      setSelectedId(seg.id);
      void loadSegmentIntoBoard(seg, targetLocation.plyIndex);
    }
  }, [targetLocation, segments, loadSegmentIntoBoard]);

  useEffect(() => {
    if (!recordingMode && !selectedSegment) {
      if (targetLocation && segments.some((s) => s.id === targetLocation.segmentId)) {
        return;
      }
      if (segments.length > 0) {
        setSelectedId(segments[0].id);
        void loadSegmentIntoBoard(segments[0]);
      } else {
        void loadBoardAtFen();
      }
    }
  }, [
    segments,
    selectedSegment,
    recordingMode,
    targetLocation,
    loadSegmentIntoBoard,
    loadBoardAtFen,
  ]);

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
    setExtendTargetId(null);
    setConfirmDeleteId(null);
    setDraftName('');
    setDraftSide('white');
    setDraftTags([]);
    setTagInput('');
    setOrientation('white');
    setErrorMsg(null);
    setStatusMsg(null);
    await loadBoardAtFen();
  };

  const startNewVariantFromFen = async (fen: string, side: Side) => {
    setSelectedId(null);
    setRecordingMode(true);
    setBranchSource(null);
    setExtendTargetId(null);
    setConfirmDeleteId(null);
    setDraftName('');
    setDraftSide(side);
    setDraftTags([]);
    setTagInput('');
    setOrientation(side);
    setErrorMsg(null);
    setStatusMsg('Recording new variant from imported FEN. Play moves and click Save Variant.');
    await loadBoardAtFen(fen);
  };

  const jumpToMatch = (match: PositionMatch) => {
    const seg = segments.find((s) => s.id === match.segmentId);
    if (!seg) return;
    setSelectedId(seg.id);
    setRecordingMode(false);
    setBranchSource(null);
    void loadSegmentIntoBoard(seg, match.plyIndex);
  };

  const handleFenSearch = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = fenQuery.trim();
    if (!trimmed) {
      setFenSearchResult(null);
      setFenSearchError(null);
      return;
    }
    try {
      const res = await window.dejamove.rpc<FindByFenResponse>('repertoire.findByFen', {
        fen: trimmed,
      });
      if (!res.ok) {
        setFenSearchResult(null);
        setFenSearchError(res.error ?? 'Invalid FEN');
        return;
      }
      setFenSearchError(null);
      setFenSearchResult(res);
      if (res.matches.length > 0) {
        jumpToMatch(res.matches[0]);
      }
    } catch (err) {
      setFenSearchResult(null);
      setFenSearchError(err instanceof Error ? err.message : String(err));
    }
  };

  const clearFenSearch = () => {
    setFenQuery('');
    setFenSearchResult(null);
    setFenSearchError(null);
  };

  const startBranchFromCursor = async () => {
    if (!selectedSegment || cursor === 0) return;
    const branchFen = history[cursor].fen;
    setBranchSource({ parentId: selectedSegment.id, afterPly: cursor - 1 });
    setExtendTargetId(null);
    setConfirmDeleteId(null);
    setRecordingMode(true);
    setDraftName('');
    setDraftSide(selectedSegment.side);
    setDraftTags(selectedSegment.tags ?? []);
    setTagInput('');
    setOrientation(selectedSegment.side);
    setErrorMsg(null);
    setStatusMsg('Play the new branch moves on the board, then click Save Branch.');
    await loadBoardAtFen(branchFen);
  };

  const startExtendVariant = async () => {
    if (!selectedSegment) return;
    const endFen =
      selectedSegment.moves.length > 0
        ? selectedSegment.moves[selectedSegment.moves.length - 1].fen
        : selectedSegment.startFen;
    setExtendTargetId(selectedSegment.id);
    setBranchSource(null);
    setConfirmDeleteId(null);
    setRecordingMode(true);
    setDraftName(selectedSegment.name);
    setDraftSide(selectedSegment.side);
    setDraftTags(selectedSegment.tags ?? []);
    setTagInput('');
    setOrientation(selectedSegment.side);
    setErrorMsg(null);
    setStatusMsg('Play continuation moves on the board, then click Save Extension.');
    await loadBoardAtFen(endFen);
  };

  const handleTruncateAtCursor = async () => {
    if (!selectedSegment || cursor <= 0 || cursor >= history.length - 1) return;
    const res = await window.dejamove.rpc<EditVariantResponse>('repertoire.truncateVariant', {
      id: selectedSegment.id,
      keepPlies: cursor,
    });
    if (!res.ok) {
      setErrorMsg(res.error ?? 'Failed to truncate variant.');
      return;
    }
    setConfirmDeleteId(null);
    setErrorMsg(null);
    setStatusMsg(`Truncated variant after move ${cursor}.`);
    setReloadTargetId(res.segmentId);
    await onRefresh();
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

      setExtendTargetId(null);
      setConfirmDeleteId(null);
      setDraftTags(selectedSegment.tags ?? []);
      setTagInput('');

      if (cursor === 0) {
        setRecordingMode(true);
        setBranchSource(null);
        setDraftName('');
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
        setDraftName('');
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

    if (extendTargetId) {
      const res = await window.dejamove.rpc<EditVariantResponse>('repertoire.extendVariant', {
        id: extendTargetId,
        moves,
      });
      if (!res.ok) {
        setErrorMsg(res.error ?? 'Failed to extend variant.');
        return;
      }
      setRecordingMode(false);
      setExtendTargetId(null);
      setErrorMsg(null);
      setStatusMsg('Variant extended and links updated automatically.');
      setReloadTargetId(res.segmentId);
      await onRefresh();
      return;
    }

    const res = branchSource
      ? await window.dejamove.rpc<AddVariantResponse>('repertoire.branchFrom', {
          parentId: branchSource.parentId,
          afterPly: branchSource.afterPly,
          name: draftName.trim(),
          moves,
          tags: draftTags,
        })
      : await window.dejamove.rpc<AddVariantResponse>('repertoire.addVariant', {
          name: draftName.trim(),
          side: draftSide,
          startFen: history[0].fen,
          moves,
          tags: draftTags,
        });

    if (!res.ok) {
      setErrorMsg(res.error ?? 'Failed to save variant.');
      return;
    }

    setRecordingMode(false);
    setBranchSource(null);
    setErrorMsg(null);
    setStatusMsg(
      res.splitOccurred
        ? 'Saved and automatically split existing variant at the branch point.'
        : 'Variant saved.',
    );
    setReloadTargetId(res.segmentId);
    await onRefresh();
  };

  const handleRename = async () => {
    if (!selectedSegment) return;
    const trimmed = draftName.trim();
    await window.dejamove.rpc('repertoire.renameVariant', {
      id: selectedSegment.id,
      name: trimmed,
    });
    await onRefresh();
    setStatusMsg(trimmed ? 'Renamed.' : 'Cleared explicit name (using default display name).');
  };

  const persistTags = async (nextTags: string[]) => {
    setDraftTags(nextTags);
    if (!recordingMode && selectedSegment) {
      const res = await window.dejamove.rpc<{ ok: boolean }>('repertoire.setTags', {
        id: selectedSegment.id,
        tags: nextTags,
      });
      if (res.ok) {
        await onRefresh();
        setStatusMsg('Tags updated.');
      }
    }
  };

  const handleAddTag = async () => {
    const trimmed = tagInput.trim().replace(/^,+|,+$/g, '');
    if (!trimmed) return;
    if (draftTags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
      setTagInput('');
      return;
    }
    setTagInput('');
    await persistTags([...draftTags, trimmed]);
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    await persistTags(draftTags.filter((t) => t !== tagToRemove));
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

  const handleConfirmDelete = async () => {
    if (!selectedSegment) return;
    await window.dejamove.rpc('repertoire.removeVariant', { id: selectedSegment.id });
    setConfirmDeleteId(null);
    setSelectedId(null);
    await onRefresh();
  };

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

          <div className="fen-search-box">
            <form className="fen-search-form" onSubmit={(e) => void handleFenSearch(e)}>
              <input
                type="text"
                value={fenQuery}
                onChange={(e) => setFenQuery(e.target.value)}
                placeholder="Paste FEN to find variant..."
              />
              <button type="submit">Find</button>
              {(fenQuery || fenSearchResult || fenSearchError) && (
                <button type="button" onClick={clearFenSearch}>
                  Clear
                </button>
              )}
            </form>

            {fenSearchError && <div className="fen-error">{fenSearchError}</div>}

            {fenSearchResult && fenSearchResult.ok && (
              <div className="fen-results">
                {fenSearchResult.matches.length > 0 ? (
                  <>
                    <div className="panel-header-row" style={{ marginBottom: 4 }}>
                      <span className="muted">
                        {fenSearchResult.matches.length === 1
                          ? '1 matching position'
                          : `${fenSearchResult.matches.length} matching positions`}
                      </span>
                      {fenSearchResult.fen && (
                        <button
                          type="button"
                          className="link-chip"
                          onClick={() => onOpenFenInAnalysis(fenSearchResult.fen!)}
                        >
                          Analyze FEN
                        </button>
                      )}
                    </div>
                    {fenSearchResult.matches.map((m) => (
                      <button
                        key={`${m.segmentId}-${m.plyIndex}`}
                        type="button"
                        className="fen-match-item"
                        onClick={() => jumpToMatch(m)}
                      >
                        <div className="variant-item-top">
                          <span className={`side-badge ${m.side}`}>
                            {m.side === 'white' ? 'W' : 'B'}
                          </span>
                          <span className="variant-name">{m.name}</span>
                          <span className="score-badge">{Math.round(m.effectiveScore)}%</span>
                        </div>
                        <div className="variant-item-sub">
                          <span>{formatMatchLocation(m)}</span>
                          {m.nextMoveSan && <span>Next: {m.nextMoveSan}</span>}
                        </div>
                      </button>
                    ))}
                  </>
                ) : (
                  <div className="fen-empty-actions">
                    <span className="muted">No variant contains this position.</span>
                    {fenSearchResult.fen && (
                      <div className="form-row">
                        <button
                          type="button"
                          className="primary"
                          onClick={() =>
                            void startNewVariantFromFen(
                              fenSearchResult.fen!,
                              fenSearchResult.sideToMove ?? 'white',
                            )
                          }
                        >
                          + Create Variant from FEN
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenFenInAnalysis(fenSearchResult.fen!)}
                        >
                          Open in Analysis
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="variant-search-box">
            <div className="fen-search-form">
              <input
                type="text"
                value={variantSearch}
                onChange={(e) => setVariantSearch(e.target.value)}
                placeholder="Search by name or #tag..."
              />
              {(variantSearch || activeTagFilter) && (
                <button
                  type="button"
                  onClick={() => {
                    setVariantSearch('');
                    setActiveTagFilter(null);
                  }}
                >
                  Reset
                </button>
              )}
            </div>
            {allTags.length > 0 && (
              <div className="tag-filter-bar">
                {allTags.map((tag) => {
                  const active = activeTagFilter?.toLowerCase() === tag.toLowerCase();
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={`tag-filter-pill ${active ? 'active' : ''}`}
                      onClick={() => setActiveTagFilter(active ? null : tag)}
                    >
                      #{tag}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="variant-list">
            {segments.length === 0 ? (
              <p className="muted">No variants yet. Click + New to create one.</p>
            ) : filteredSegments.length === 0 ? (
              <p className="muted">No variants match the current search or tag filter.</p>
            ) : (
              filteredSegments.map((seg) => {
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
                      <span className="variant-name">{getVariantLabel(seg)}</span>
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
                    {(seg.tags?.length ?? 0) > 0 && (
                      <div className="variant-tags-row">
                        {seg.tags!.map((tag) => (
                          <span key={tag} className="tag-pill">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
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
                ? extendTargetId
                  ? `Extend: ${selectedSegment ? getVariantLabel(selectedSegment) : 'Variant'}`
                  : branchSource
                    ? 'New Branch'
                    : 'New Variant'
                : selectedSegment
                  ? getVariantLabel(selectedSegment)
                  : 'Editor'}
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

          {!extendTargetId && (
            <>
              <div className="form-group">
                <label>
                  Name
                  <input
                    type="text"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    placeholder={
                      selectedSegment && !recordingMode && !selectedSegment.name
                        ? getVariantLabel(selectedSegment)
                        : 'Optional variant name...'
                    }
                  />
                </label>
              </div>

              {(recordingMode || selectedSegment) && (
                <div className="form-group tag-editor">
                  <label>
                    Tags
                    <div className="tag-input-row">
                      <input
                        type="text"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ',') {
                            e.preventDefault();
                            void handleAddTag();
                          }
                        }}
                        placeholder="Add tag (e.g. sharp, endgame)..."
                      />
                      <button
                        type="button"
                        disabled={!tagInput.trim()}
                        onClick={() => void handleAddTag()}
                      >
                        Add
                      </button>
                    </div>
                  </label>
                  {draftTags.length > 0 && (
                    <div className="tag-list">
                      {draftTags.map((tag) => (
                        <span key={tag} className="tag-chip">
                          #{tag}
                          <button
                            type="button"
                            className="tag-chip-remove"
                            aria-label={`Remove tag ${tag}`}
                            onClick={() => void handleRemoveTag(tag)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {recordingMode ? (
            <>
              {!branchSource && !extendTargetId && (
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
                  {extendTargetId
                    ? 'Save Extension'
                    : branchSource
                      ? 'Save Branch'
                      : 'Save Variant'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRecordingMode(false);
                    setBranchSource(null);
                    setExtendTargetId(null);
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
                  <button
                    type="button"
                    className="danger"
                    onClick={() => setConfirmDeleteId(selectedSegment.id)}
                  >
                    Delete
                  </button>
                </div>

                {confirmDeleteId === selectedSegment.id && (
                  <div className="confirm-delete-box">
                    <p>
                      Delete &ldquo;{getVariantLabel(selectedSegment)}&rdquo;? Parent and child
                      variants will remain intact.
                    </p>
                    <div className="form-row">
                      <button
                        type="button"
                        className="danger"
                        onClick={() => void handleConfirmDelete()}
                      >
                        Confirm Delete
                      </button>
                      <button type="button" onClick={() => setConfirmDeleteId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <div className="form-row">
                  <button type="button" onClick={() => void startExtendVariant()}>
                    Extend Variant
                  </button>
                  {cursor > 0 && (
                    <button type="button" onClick={() => void startBranchFromCursor()}>
                      Branch From Move {cursor}
                    </button>
                  )}
                </div>

                {cursor > 0 && cursor < history.length - 1 && (
                  <button type="button" onClick={() => void handleTruncateAtCursor()}>
                    Truncate After Move {cursor}
                  </button>
                )}

                {selectedSegment.parentIds.length > 0 && (
                  <div className="links-row">
                    <span className="muted">Parents:</span>
                    {selectedSegment.parentIds.map((pid) => {
                      const parent = segments.find((s) => s.id === pid);
                      if (!parent) return null;
                      return (
                        <button
                          key={pid}
                          type="button"
                          className="link-chip"
                          onClick={() => {
                            setSelectedId(pid);
                            void loadSegmentIntoBoard(parent);
                          }}
                        >
                          {getVariantLabel(parent)}
                        </button>
                      );
                    })}
                  </div>
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
                          {getVariantLabel(child)}
                        </button>
                      );
                    })}
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
