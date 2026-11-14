import { useCallback, useEffect, useState } from 'react';
import { EditorView } from './components/EditorView';
import type { RepertoireListResponse, VariantSegment } from './types';
import './App.css';

type AppMode = 'editor' | 'trainer';

export function App() {
  const [mode, setMode] = useState<AppMode>('editor');
  const [segments, setSegments] = useState<VariantSegment[]>([]);
  const [coreStatus, setCoreStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);

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
    setSelectedTrainId(segmentId);
    setMode('trainer');
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
        </nav>
      </header>

      {errorMsg && <div className="error-banner">{errorMsg}</div>}

      {mode === 'editor' ? (
        <EditorView
          segments={segments}
          onRefresh={refreshRepertoire}
          onTrainVariant={handleTrainVariant}
        />
      ) : (
        <div className="panel-card" style={{ margin: 'auto', maxWidth: 460 }}>
          <h2>Trainer</h2>
          <p className="muted">
            Selected variant: {selectedTrainId ?? 'Smart Random'} (Trainer UI coming in next
            commit).
          </p>
        </div>
      )}
    </div>
  );
}

export default App;
