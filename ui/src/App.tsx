import { useCallback, useEffect, useState } from 'react';
import { AnalysisView, type AnalysisHandoff } from './components/AnalysisView';
import { EditorView } from './components/EditorView';
import { TrainerView } from './components/TrainerView';
import type {
  BoardStateResponse,
  EditorTargetLocation,
  RepertoireListResponse,
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
    </div>
  );
}

export default App;
