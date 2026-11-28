import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { BackupSnapshotInfo, SyncStatus } from '../types';

interface SyncModalProps {
  initialStatus: SyncStatus | null;
  onClose: () => void;
  onStatusChange: (status: SyncStatus) => void;
  onRepertoireChanged: () => Promise<void>;
}

function formatDateTime(iso?: string): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function SyncModal({
  initialStatus,
  onClose,
  onStatusChange,
  onRepertoireChanged,
}: SyncModalProps) {
  const [status, setStatus] = useState<SyncStatus | null>(initialStatus);
  const [clientId, setClientId] = useState(initialStatus?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [secretDirty, setSecretDirty] = useState(false);
  const [showGuide, setShowGuide] = useState(!initialStatus?.configured);
  const [backupLabel, setBackupLabel] = useState('');
  const [backups, setBackups] = useState<BackupSnapshotInfo[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<BackupSnapshotInfo | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const applyStatus = useCallback(
    (next: SyncStatus) => {
      setStatus(next);
      onStatusChange(next);
      if (next.clientId && !clientId) {
        setClientId(next.clientId);
      }
    },
    [clientId, onStatusChange],
  );

  const refreshBackups = useCallback(async () => {
    setLoadingBackups(true);
    try {
      const res = await window.dejamove.sync.listBackups();
      if (!res.ok) {
        setErrorMsg(res.error ?? 'Could not list Google Drive backups.');
      } else {
        setBackups(res.backups);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingBackups(false);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const next = await window.dejamove.sync.getStatus();
        setStatus(next);
        onStatusChange(next);
        setClientId(next.clientId ?? '');
        if (next.connected) {
          await refreshBackups();
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
  }, [onStatusChange, refreshBackups]);

  const handleSaveCredentials = async (e: FormEvent) => {
    e.preventDefault();
    setBusyAction('save');
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      const next = await window.dejamove.sync.configure({
        clientId: clientId.trim(),
        ...(secretDirty ? { clientSecret } : {}),
      });
      setSecretDirty(false);
      setClientSecret('');
      applyStatus(next);
      setInfoMsg('Google OAuth configuration saved.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleClearSecret = async () => {
    setBusyAction('save');
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      const next = await window.dejamove.sync.configure({
        clientId: clientId.trim(),
        clientSecret: '',
      });
      setSecretDirty(false);
      setClientSecret('');
      applyStatus(next);
      setInfoMsg('Cleared saved client secret.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleConnect = async () => {
    setBusyAction('connect');
    setErrorMsg(null);
    setInfoMsg('Waiting for Google sign-in in your browser...');
    try {
      const next = await window.dejamove.sync.connect();
      applyStatus(next);
      setInfoMsg(next.email ? `Signed in as ${next.email}.` : 'Signed in to Google Drive.');
      await refreshBackups();
    } catch (err) {
      setInfoMsg(null);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDisconnect = async () => {
    setBusyAction('disconnect');
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      const next = await window.dejamove.sync.disconnect();
      applyStatus(next);
      setBackups([]);
      setConfirmRestore(null);
      setInfoMsg('Disconnected from Google Drive.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleAutoSync = async (enabled: boolean) => {
    setErrorMsg(null);
    try {
      const next = await window.dejamove.sync.setAutoSync(enabled);
      applyStatus(next);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSyncNow = async () => {
    setBusyAction('sync');
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      const res = await window.dejamove.sync.syncNow();
      const next = await window.dejamove.sync.getStatus();
      applyStatus(next);
      if (!res.ok) {
        setErrorMsg(res.error ?? 'Sync failed.');
      } else {
        await onRepertoireChanged();
        setInfoMsg(
          `Synced with Google Drive (${res.added ?? 0} added, ${res.updated ?? 0} updated).`,
        );
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateBackup = async (e: FormEvent) => {
    e.preventDefault();
    setBusyAction('backup');
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      const res = await window.dejamove.sync.createBackup(backupLabel.trim() || undefined);
      if (!res.ok) {
        setErrorMsg(res.error ?? 'Backup creation failed.');
      } else {
        setBackupLabel('');
        await refreshBackups();
        setInfoMsg(`Created snapshot: ${res.snapshot?.name ?? 'backup.json'}.`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmRestore = async () => {
    if (!confirmRestore) return;
    setBusyAction('restore');
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      const res = await window.dejamove.sync.restoreBackup(confirmRestore.id);
      if (!res.ok) {
        setErrorMsg(res.error ?? 'Restore failed.');
      } else {
        const restoredName = confirmRestore.name;
        setConfirmRestore(null);
        await onRepertoireChanged();
        setInfoMsg(`Restored local repertoire from snapshot "${restoredName}".`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card sync-modal">
        <div className="modal-header">
          <h2>Google Drive Sync &amp; Backup</h2>
          <button type="button" onClick={onClose} disabled={busyAction !== null}>
            Close
          </button>
        </div>

        <div className="sync-status-row">
          <span
            className={`status-pill ${
              status?.connected ? 'ready' : status?.configured ? 'connecting' : 'error'
            }`}
          >
            {status?.connected
              ? `Connected${status.email ? ` (${status.email})` : ''}`
              : status?.configured
                ? 'Configured (Signed Out)'
                : 'Not Configured'}
          </span>
          <span className="muted">Last synced: {formatDateTime(status?.lastSyncedAt)}</span>
        </div>

        {errorMsg && <div className="error-banner">{errorMsg}</div>}
        {!errorMsg && status?.lastError && (
          <div className="error-banner">Last sync error: {status.lastError}</div>
        )}
        {infoMsg && <div className="info-banner">{infoMsg}</div>}

        <div className="sync-section">
          <div className="panel-header-row" style={{ marginBottom: 6 }}>
            <h3>1. Google Cloud OAuth Configuration</h3>
            <button type="button" className="link-chip" onClick={() => setShowGuide((v) => !v)}>
              {showGuide ? 'Hide Setup Guide' : 'Show Setup Guide'}
            </button>
          </div>

          {showGuide && (
            <div className="sync-guide">
              <ol>
                <li>
                  Create a project in Google Cloud Console and enable the{' '}
                  <strong>Google Drive API</strong>.
                </li>
                <li>
                  Configure OAuth consent screen (External / Testing, add your Google account as a
                  Test user if unpublished) with scope <code>.../auth/drive.file</code>.
                </li>
                <li>
                  Create an <strong>OAuth Client ID</strong> of type <strong>Desktop app</strong>,
                  then paste the Client ID (and Client Secret if issued) below.
                </li>
              </ol>
            </div>
          )}

          <form className="sync-config-form" onSubmit={(e) => void handleSaveCredentials(e)}>
            <div className="form-group">
              <label>
                OAuth Client ID
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="123456789-abc.apps.googleusercontent.com"
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Client Secret (if issued by Desktop OAuth)
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => {
                    setSecretDirty(true);
                    setClientSecret(e.target.value);
                  }}
                  placeholder={
                    status?.hasClientSecret
                      ? '•••••••• (saved — type to replace)'
                      : 'Optional client secret'
                  }
                />
              </label>
              {status?.hasClientSecret && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handleClearSecret()}
                >
                  Clear Secret
                </button>
              )}
              <button type="submit" disabled={busyAction !== null || !clientId.trim()}>
                Save Credentials
              </button>
            </div>
          </form>

          <div className="form-row" style={{ marginTop: 8 }}>
            {!status?.connected ? (
              <button
                type="button"
                className="primary"
                disabled={busyAction !== null || !status?.configured}
                onClick={() => void handleConnect()}
              >
                {busyAction === 'connect' ? 'Signing In...' : 'Sign in with Google'}
              </button>
            ) : (
              <button
                type="button"
                className="danger"
                disabled={busyAction !== null}
                onClick={() => void handleDisconnect()}
              >
                Sign Out
              </button>
            )}
          </div>
        </div>

        {status?.connected && (
          <>
            <div className="sync-section">
              <div className="panel-header-row" style={{ marginBottom: 6 }}>
                <h3>2. Multi-PC Sync</h3>
                <label className="sync-checkbox">
                  <input
                    type="checkbox"
                    checked={status.autoSync}
                    disabled={busyAction !== null}
                    onChange={(e) => void handleToggleAutoSync(e.target.checked)}
                  />
                  Auto-sync on startup
                </label>
              </div>
              <p className="muted" style={{ marginBottom: 8 }}>
                Smart-merges local and remote variants in <code>DejaMove/repertoire.json</code>,
                keeping newest training stats per variant without overwriting offline work.
              </p>
              <button
                type="button"
                className="primary"
                disabled={busyAction !== null}
                onClick={() => void handleSyncNow()}
              >
                {busyAction === 'sync' ? 'Syncing...' : 'Sync Now'}
              </button>
            </div>

            <div className="sync-section">
              <div className="panel-header-row" style={{ marginBottom: 6 }}>
                <h3>3. Backup Snapshots (DejaMove/backups/)</h3>
                <button
                  type="button"
                  className="link-chip"
                  disabled={loadingBackups || busyAction !== null}
                  onClick={() => void refreshBackups()}
                >
                  {loadingBackups ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>

              <form className="fen-search-form" onSubmit={(e) => void handleCreateBackup(e)}>
                <input
                  type="text"
                  value={backupLabel}
                  onChange={(e) => setBackupLabel(e.target.value)}
                  placeholder="Optional snapshot label (e.g. before-tournament)..."
                />
                <button type="submit" disabled={busyAction !== null}>
                  {busyAction === 'backup' ? 'Creating...' : 'Create Backup Snapshot'}
                </button>
              </form>

              {confirmRestore && (
                <div className="confirm-restore-box">
                  <p>
                    Replace your local repertoire with snapshot &ldquo;{confirmRestore.name}
                    &rdquo;? Unsynced local changes not in that snapshot will be replaced locally.
                  </p>
                  <div className="form-row">
                    <button
                      type="button"
                      className="danger"
                      disabled={busyAction !== null}
                      onClick={() => void handleConfirmRestore()}
                    >
                      {busyAction === 'restore' ? 'Restoring...' : 'Confirm Restore'}
                    </button>
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => setConfirmRestore(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {backups.length === 0 ? (
                <p className="muted" style={{ marginTop: 8 }}>
                  {loadingBackups
                    ? 'Loading snapshots from Google Drive...'
                    : 'No backup snapshots found yet.'}
                </p>
              ) : (
                <div className="backup-list">
                  {backups.map((b) => (
                    <div key={b.id} className="backup-item">
                      <div className="backup-meta">
                        <strong>{b.name}</strong>
                        <span className="muted">
                          {formatDateTime(b.createdTime)}
                          {b.sizeBytes !== undefined ? ` • ${formatBytes(b.sizeBytes)}` : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => setConfirmRestore(b)}
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
