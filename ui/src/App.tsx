import { useCallback, useEffect, useState } from 'react';
import { AnalysisView, type AnalysisHandoff } from './components/AnalysisView';
import { EditorView } from './components/EditorView';
import { SyncModal } from './components/SyncModal';
import { TrainerView } from './components/TrainerView';
import type {
  BoardStateResponse,
  EditorTargetLocation,
  RepertoireListResponse,
  SyncStatus,
  TrainingSessionState,
  VariantSegment,
} from './types';
import './App.css';

type AppMode = 'editor' | 'trainer' | 'analysis';

export function App() {
  const [mode, setMode] = useState<AppMode>('editor');
  const [segments, setSegments] = useState<VariantSegment[]>([]);
  const [coreStatus, setCoreStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);
  const [pausedTraining, setPausedTraining] = useState<TrainingSessionState | null>(null);
  const [analysisHandoff, setAnalysisHandoff] = useState<AnalysisHandoff | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTargetLocation | null>(null);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);

  const refreshRepertoire = useCallback(async () => {
    try {
      const res = await window.dejamove.rpc<RepertoireListResponse>('training.listWithScores');
      setSegments(res.segments ?? []);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        const ping = await window.dejamove.rpc<{ ok: boolean }>('ping');
        if (!ping.ok) throw new Error('Core ping failed');
        await refreshRepertoire();
        setCoreStatus('ready');

        try {
          const status = await window.dejamove.sync.getStatus();
          setSyncStatus(status);
          if (status.connected && status.autoSync) {
            setSyncBusy(true);
            const res = await window.dejamove.sync.syncNow();
            if (res.ok) {
              await refreshRepertoire();
            }
            setSyncStatus(await window.dejamove.sync.getStatus());
          }
        } catch {
          // Non-fatal: startup sync failures are surfaced in sync status UI.
        } finally {
          setSyncBusy(false);
        }
      } catch (err) {
        setCoreStatus('error');
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    };
    void init();
  }, [refreshRepertoire]);

  const handleTrainVariant = (segmentId: string) => {
    setPausedTraining(null);
    setSelectedTrainId(segmentId);
    setMode('trainer');
  };

  const handleOpenInAnalysis = (session: TrainingSessionState, handoff: AnalysisHandoff) => {
    setPausedTraining(session);
    setAnalysisHandoff(handoff);
    setMode('analysis');
  };

  const handleReturnToTrainer = () => {
    setMode('trainer');
  };

  const handleOpenVariantInEditor = (segmentId: string, plyIndex: number) => {
    setEditorTarget({ segmentId, plyIndex, nonce: Date.now() });
    setMode('editor');
  };

  const handleOpenFenInAnalysis = async (fen: string) => {
    try {
      const res = await window.dejamove.rpc<BoardStateResponse>('board.state', { fen });
      if (!res.valid) {
        setErrorMsg(res.error ?? 'Invalid FEN');
        return;
      }
      setErrorMsg(null);
      setAnalysisHandoff({
        history: [
          {
            fen: res.fen,
            sideToMove: res.sideToMove,
            legalMoves: res.legalMoves,
          },
        ],
        cursor: 0,
        orientation: res.sideToMove,
      });
      setMode('analysis');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

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
          <nav className="mode-tabs">
            <button
              type="button"
              className={mode === 'editor' ? 'active' : ''}
              onClick={() => setMode('editor')}
            >
              Repertoire Editor
            </button>
            <button
              type="button"
              className={mode === 'trainer' ? 'active' : ''}
              onClick={() => setMode('trainer')}
            >
              Trainer
            </button>
            <button
              type="button"
              className={mode === 'analysis' ? 'active' : ''}
              onClick={() => {
                setAnalysisHandoff(null);
                setMode('analysis');
              }}
            >
              Analysis Board
            </button>
          </nav>

          <button
            type="button"
            className="sync-header-btn"
            onClick={() => setShowSyncModal(true)}
            title="Google Drive sync & backup snapshots"
          >
            <span
              className={`sync-dot ${
                syncBusy ? 'syncing' : syncStatus?.connected ? 'connected' : ''
              }`}
            />
            {syncBusy ? 'Syncing...' : 'Cloud Sync'}
          </button>
        </div>
      </header>

      {errorMsg && <div className="error-banner">{errorMsg}</div>}

      {mode === 'editor' && (
        <EditorView
          segments={segments}
          targetLocation={editorTarget}
          onRefresh={refreshRepertoire}
          onTrainVariant={handleTrainVariant}
          onOpenFenInAnalysis={(fen) => void handleOpenFenInAnalysis(fen)}
        />
      )}
      {mode === 'trainer' && (
        <TrainerView
          segments={segments}
          initialSegmentId={selectedTrainId}
          resumedSession={pausedTraining}
          onRefresh={refreshRepertoire}
          onOpenInAnalysis={handleOpenInAnalysis}
        />
      )}
      {mode === 'analysis' && (
        <AnalysisView
          handoff={analysisHandoff}
          onReturnToTrainer={pausedTraining ? handleReturnToTrainer : undefined}
          onOpenVariantInEditor={handleOpenVariantInEditor}
        />
      )}

      {showSyncModal && (
        <SyncModal
          initialStatus={syncStatus}
          onClose={() => setShowSyncModal(false)}
          onStatusChange={setSyncStatus}
          onRepertoireChanged={refreshRepertoire}
        />
      )}
    </div>
  );
}

export default App;
