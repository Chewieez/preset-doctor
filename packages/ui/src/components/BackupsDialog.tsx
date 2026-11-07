import { useEffect, useState, type ReactNode } from 'react';
import type { BackupInfo, Platform, StudioState } from '../contract';
import { api, AppError, call, messageOf } from '../api';
import { backupFitsFolder, SLICER_TEXT } from '../model';
import { useSlicer } from '../slicerContext';
import { Dialog } from './Dialog';

interface Props {
  platform: Platform;
  root: string;
  /** Web: the folder inside `root` that holds the backups. */
  backupsDir: string;
  /**
   * Whether the slicer of `root` is known (scanned, or a default folder). When it isn't, every
   * backup is listed and can be picked; the restore itself refuses another slicer's backup.
   */
  slicerKnown: boolean;
  studio: StudioState | 'checking';
  /** Web: the "I've closed Bambu Studio" checkbox, which stands in for the process check. */
  studioGate?: ReactNode;
  /** `skipped`: OrcaSlicer sync files left out (see RestoreResult.skipped). */
  onRestored: (backupId: string, restoredCount: number, skipped: number) => void;
  /**
   * The restore wrote some files (`written`) and then failed; the message names the backup that
   * undoes it.
   */
  onRestoreStopped: (message: string, written: readonly string[]) => void;
  onClose: () => void;
}

const REASON: Record<NonNullable<BackupInfo['reason']>, string> = {
  'before-fix': 'Saved before a repair',
  'before-restore': 'Saved before a restore',
  manual: 'Saved by hand',
};

export function BackupsDialog({
  platform,
  root,
  backupsDir,
  slicerKnown,
  studio,
  studioGate,
  onRestored,
  onRestoreStopped,
  onClose,
}: Props) {
  const web = platform === 'web';
  const slicer = useSlicer();
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  /** Backups of the other slicer's folder are listed only on request; they can't go back here. */
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Backup the user is asked about a second time, because it came from another folder. */
  const [otherSource, setOtherSource] = useState<{ id: string; message: string } | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    call(api.listBackups()).then(setBackups, (e: unknown) => setError(messageOf(e)));
  }, []);

  const restore = async (id: string, allowOtherSource = false): Promise<void> => {
    setRestoring(true);
    setError(null);
    try {
      const r = await call(api.restore(root, id, { allowOtherSource }));
      onRestored(r.backupId, r.restoredCount, r.skipped.length);
    } catch (e) {
      if (e instanceof AppError && e.code === 'other-source') {
        setOtherSource({ id, message: e.message });
      } else if (e instanceof AppError && e.code === 'partial') {
        onRestoreStopped(e.message, e.written ?? []);
        return;
      } else {
        setError(messageOf(e));
      }
      setRestoring(false);
    }
  };

  // listBackups reads a backup that doesn't say as Bambu Studio's.
  const ofThisSlicer = (b: BackupInfo): boolean => backupFitsFolder(b, slicer.id, slicerKnown);
  const otherCount = backups?.filter((b) => !ofThisSlicer(b)).length ?? 0;
  const shown = backups && (showAll ? backups : backups.filter(ofThisSlicer));

  const download = async (id: string): Promise<void> => {
    setError(null);
    try {
      if (api.downloadBackup) await call(api.downloadBackup(id));
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <Dialog
      title="Restore a backup"
      onClose={restoring ? () => undefined : onClose}
      testId="backups-dialog"
      footer={
        <>
          {!web && (
            <button
              type="button"
              className="btn"
              onClick={() =>
                call(api.openBackupsFolder()).catch((e: unknown) => setError(messageOf(e)))
              }
            >
              Open backups folder
            </button>
          )}
          <button type="button" className="btn" onClick={onClose} disabled={restoring}>
            Close
          </button>
        </>
      }
    >
      <p>
        A restore puts every preset file from the backup back into <code>{root}</code>. Your current
        presets are backed up first, so a restore can be undone too.
      </p>
      {web && (
        <p className="muted">
          Backups are saved in the <code>{backupsDir}</code> folder inside <code>{root}</code>.
          Download one to keep a copy somewhere else.
        </p>
      )}
      {studioGate}
      {!web && studio !== 'closed' && (
        <p className="warn-text">Close {slicer.name} to restore a backup.</p>
      )}
      {error && <p className="error-text">{error}</p>}
      {backups === null && !error && <p className="muted">Loading…</p>}
      {shown?.length === 0 && (
        <p className="muted">No backups yet. One is made before the first repair.</p>
      )}
      {otherCount > 0 && (
        <label className="option" data-testid="show-all-backups">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          <span>
            Show all backups ({otherCount} from another slicer's folder, which can't be restored
            here)
          </span>
        </label>
      )}
      {shown && shown.length > 0 && (
        <ul className="backup-list" data-testid="backup-list">
          {shown.map((b) => (
            <li key={b.id}>
              <div>
                <strong>{formatWhen(b)}</strong>
                <span className="muted">
                  {b.reason ? REASON[b.reason] : 'Backup'} · {b.fileCount} files ·{' '}
                  {formatBytes(b.bytes)}
                  {(!slicerKnown || !ofThisSlicer(b)) && ` · ${SLICER_TEXT[b.slicer].name}`}
                </span>
                <span className="muted backup-source">
                  From {b.sourceRoot ? <code>{b.sourceRoot}</code> : 'an unknown folder'}
                </span>
              </div>
              {otherSource?.id === b.id ? (
                <div className="confirm other-source" data-testid="other-source-confirm">
                  <span className="warn-text">
                    {otherSource.message} Restore it into <code>{root}</code> anyway?
                  </span>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={restoring || studio !== 'closed'}
                    onClick={() => void restore(b.id, true)}
                  >
                    {restoring ? 'Restoring…' : 'Restore anyway'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={restoring}
                    onClick={() => {
                      setOtherSource(null);
                      setConfirming(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : confirming === b.id ? (
                <div className="confirm">
                  <span>Put this backup back?</span>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={restoring || studio !== 'closed'}
                    onClick={() => void restore(b.id)}
                  >
                    {restoring ? 'Restoring…' : 'Yes, restore'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={restoring}
                    onClick={() => setConfirming(null)}
                  >
                    No
                  </button>
                </div>
              ) : (
                <div className="confirm">
                  {web && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void download(b.id)}
                      data-testid="download-backup"
                    >
                      Download
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    disabled={restoring || studio !== 'closed' || !ofThisSlicer(b)}
                    onClick={() => setConfirming(b.id)}
                  >
                    Restore…
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function formatWhen(b: BackupInfo): string {
  const d = b.createdAt ? new Date(b.createdAt) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : b.id;
}

function formatBytes(n: number): string {
  return n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
}
