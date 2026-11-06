import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Finding } from '@preset-doctor/core';
import type { AppConfig, PlanPayload, ScanPayload, StudioState } from './contract';
import { api, AppError, call, messageOf } from './api';
import { BackupsDialog } from './components/BackupsDialog';
import { DetailPanel, type Preview } from './components/DetailPanel';
import { FindingsTable } from './components/FindingsTable';
import { FixBar } from './components/FixBar';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { ReviewDialog } from './components/ReviewDialog';
import { CopyBack } from './components/web/CopyBack';
import { StudioConfirm } from './components/web/StudioConfirm';
import { WebGuide } from './components/web/WebGuide';
import {
  choiceFor,
  cloudSyncFinding,
  countByStatus,
  findingsByPath,
  fixesFor,
  initialSelection,
  isProblem,
  mergePaths,
  repairNotice,
  restoreNotice,
  selectedChoices,
  visiblePresets,
  type Filter,
  type Selection,
} from './model';

const STUDIO_POLL_MS = 3000;

interface Notice {
  kind: 'success' | 'error';
  title: string;
  lines: string[];
  /** The backup made or used, offered for download in the web version. */
  backupId?: string;
}

/** Web: what the user has to copy back into Bambu Studio's folder. */
interface CopyBackState {
  files: string[];
  restored: boolean;
}

interface ReviewState {
  plan: PlanPayload | null;
  loading: boolean;
  error: string | null;
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [root, setRoot] = useState('');
  const [rootExists, setRootExists] = useState(true);
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [payload, setPayload] = useState<ScanPayload | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ picks: {}, checked: {} });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('problems');
  const [search, setSearch] = useState('');
  const [updateBaseId, setUpdateBaseId] = useState(true);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [studioConfirmed, setStudioConfirmed] = useState(false);
  const [copyBack, setCopyBack] = useState<CopyBackState | null>(null);
  /** Ignores answers to older review plans (the .info toggle can fire several). */
  const reviewSeq = useRef(0);
  const web = config?.platform === 'web';
  const polledStudio = useStudioStatus(config?.platform === 'desktop');
  // A browser can't see processes: in the web version the user's confirmation gates every write.
  const studio: StudioState | 'checking' = web
    ? studioConfirmed
      ? 'closed'
      : 'unknown'
    : polledStudio;
  const studioGate = web ? (
    <StudioConfirm checked={studioConfirmed} disabled={applying} onChange={setStudioConfirmed} />
  ) : undefined;
  const noteWritten = (files: readonly string[], restored = false): void => {
    if (!web) return;
    setCopyBack((c) => ({
      files: mergePaths(c?.files ?? [], files),
      restored: restored || (c?.restored ?? false),
    }));
  };

  useEffect(() => {
    call(api.getConfig()).then(
      (c) => {
        setConfig(c);
        setRoot(c.root);
        setRootExists(c.rootExists);
      },
      (e: unknown) => setScanError(messageOf(e)),
    );
  }, []);

  const runScan = useCallback(async (dir: string, account: string | undefined): Promise<void> => {
    setScanning(true);
    setScanError(null);
    try {
      const p = await call(api.scan(dir, account));
      setPayload(p);
      setUserId(p.result.userId);
      setSelection(initialSelection(p.defaults));
      setRootExists(true);
      setSelectedPath((prev) =>
        prev && p.result.presets.some((x) => x.path === prev) ? prev : null,
      );
    } catch (e) {
      setPayload(null);
      setScanError(messageOf(e));
    } finally {
      setScanning(false);
    }
  }, []);

  const byPath = useMemo(
    () => (payload ? findingsByPath(payload.result) : new Map<string, Finding[]>()),
    [payload],
  );
  const rows = useMemo(
    () => (payload ? visiblePresets(payload.result, byPath, filter, search) : []),
    [payload, byPath, filter, search],
  );
  const problemCount = useMemo(
    () => (payload ? payload.result.presets.filter((p) => isProblem(p, byPath)).length : 0),
    [payload, byPath],
  );
  const choices = useMemo(
    () => (payload ? selectedChoices(payload.result, byPath, selection) : []),
    [payload, byPath, selection],
  );
  const selectedPreset = payload?.result.presets.find((p) => p.path === selectedPath) ?? null;
  const selectedFindings = selectedPath ? (byPath.get(selectedPath) ?? []) : [];
  const selectedFixes = fixesFor(selectedFindings);
  const preview = usePreview(
    selectedPath && selection.checked[selectedPath]
      ? choiceFor(selectedPath, selectedFixes, selection.picks)
      : null,
    updateBaseId,
    payload,
  );

  const counts = payload ? countByStatus(payload.result) : null;
  const cloud = payload ? cloudSyncFinding(payload.result) : undefined;
  const busy = scanning || applying;

  const changeFolder = async (): Promise<void> => {
    try {
      const picked = await call(api.pickFolder());
      if (picked === null) return;
      setRoot(picked);
      setPayload(null);
      // The account and the "Studio is closed" confirmation were about the previous folder.
      setUserId(undefined);
      setStudioConfirmed(false);
      setNotice(null);
      setCopyBack(null);
      setSelectedPath(null);
      await runScan(picked, undefined);
    } catch (e) {
      setScanError(messageOf(e));
    }
  };

  const pick = (path: string, candidate: string | null): void => {
    setSelection((s) => ({
      picks: candidate === null ? s.picks : { ...s.picks, [path]: candidate },
      checked: { ...s.checked, [path]: candidate !== null },
    }));
  };
  const toggle = (path: string, on: boolean): void => {
    setSelection((s) => ({ ...s, checked: { ...s.checked, [path]: on } }));
  };

  const planReview = async (baseId: boolean): Promise<void> => {
    const id = ++reviewSeq.current;
    setReview({ plan: null, loading: true, error: null });
    try {
      const plan = await call(api.plan(choices, { updateBaseId: baseId }));
      if (id === reviewSeq.current) setReview({ plan, loading: false, error: null });
    } catch (e) {
      if (id === reviewSeq.current) setReview({ plan: null, loading: false, error: messageOf(e) });
    }
  };
  const closeReview = (): void => {
    reviewSeq.current++;
    setReview(null);
  };

  /** Runs a banner button's action; a failure is added to the banner instead of vanishing. */
  const noticeAction = (what: string, pending: Promise<unknown>): void => {
    pending.catch((e: unknown) =>
      setNotice((n) => n && { ...n, lines: [...n.lines, `Couldn't ${what}: ${messageOf(e)}`] }),
    );
  };

  const apply = async (): Promise<void> => {
    const plan = review?.plan;
    if (!plan) return;
    setApplying(true);
    try {
      const r = await call(api.apply(plan.planId));
      closeReview();
      noteWritten(r.written);
      // The next step opens Studio, so the next write needs a fresh confirmation.
      setStudioConfirmed(false);
      setNotice({
        kind: 'success',
        backupId: r.backup.id,
        ...repairNotice(r, {
          web,
          cloud: cloud !== undefined,
          backupsDir: config?.backupsDir ?? '',
        }),
      });
      await runScan(root, userId);
    } catch (e) {
      if (e instanceof AppError && e.code === 'partial') {
        closeReview();
        noteWritten(e.written ?? []);
        setNotice({ kind: 'error', title: 'The repair stopped part-way.', lines: [e.message] });
        await runScan(root, userId);
      } else {
        setReview((r) => (r ? { ...r, error: messageOf(e) } : r));
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="app">
      <Header
        platform={config?.platform ?? 'desktop'}
        root={root}
        accounts={payload?.result.accounts ?? []}
        userId={userId}
        studio={studio}
        busy={busy}
        onChangeFolder={() => void changeFolder()}
        onChangeAccount={(id) => void runScan(root, id)}
      />

      {config?.testMode && (
        <div className="banner warning" role="status" data-testid="test-mode-banner">
          <span>
            <strong>Test mode.</strong> Started with PRESET_DOCTOR_ROOT, so the Bambu Studio check
            may be simulated for the folder it names.
          </span>
        </div>
      )}
      {payload && !payload.result.systemIndexRead && (
        <div className="banner warning" role="alert" data-testid="no-system-banner">
          <span>
            <strong>These results are incomplete.</strong> Bambu Studio's system presets (
            <code>system\BBL.json</code>) could not be read, so Preset Doctor couldn't check whether
            the presets yours are based on still exist.{' '}
            {web
              ? 'Copy the "system" folder into your copy again, then scan again.'
              : 'Open Bambu Studio once, close it, then scan again.'}
          </span>
        </div>
      )}
      {cloud && (
        <div className="banner warning" role="alert" data-testid="cloud-banner">
          <span>
            <strong>{cloud.title}.</strong> {cloud.explanation}
          </span>
        </div>
      )}
      {notice && (
        <div
          className={`banner ${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          data-testid="result-banner"
        >
          <div>
            <strong>{notice.title}</strong>
            {notice.lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </div>
          <div className="banner-actions">
            {notice.kind === 'success' && !web && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  noticeAction('open the backups folder', call(api.openBackupsFolder()))
                }
              >
                Open backups folder
              </button>
            )}
            {notice.kind === 'success' && web && notice.backupId && api.downloadBackup && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  noticeAction('download the backup', call(api.downloadBackup!(notice.backupId!)))
                }
                data-testid="download-notice-backup"
              >
                Download backup
              </button>
            )}
            <button
              type="button"
              className="btn ghost"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {web && copyBack && (
        <CopyBack
          root={root}
          files={copyBack.files}
          restored={copyBack.restored}
          onDismiss={() => setCopyBack(null)}
        />
      )}

      <div className="toolbar">
        <button
          type="button"
          className="btn primary"
          onClick={() => void runScan(root, userId)}
          disabled={busy || root === ''}
          data-testid="scan-button"
        >
          {scanning ? 'Scanning…' : payload ? 'Scan again' : 'Scan presets'}
        </button>
        {counts && (
          <p className="summary" data-testid="scan-summary">
            <span className="count hidden">{counts.hidden} hidden</span>
            <span className="count broken">{counts.broken} broken</span>
            <span className="count info">{counts.info} with notes</span>
            <span className="count ok">{counts.ok} OK</span>
            {payload?.result.systemVersion && (
              <span className="muted">· Studio presets version {payload.result.systemVersion}</span>
            )}
          </p>
        )}
      </div>
      {payload?.result.warnings.map((w, i) => (
        <p key={i} className="note">
          {w}
        </p>
      ))}

      <main className="content">
        {scanError && (
          <div className="banner error" role="alert">
            <span>{scanError}</span>
          </div>
        )}
        {!payload && web && <WebGuide busy={busy} onPick={() => void changeFolder()} />}
        {!payload && !scanError && !web && (
          <div className="intro">
            {rootExists ? (
              <>
                <h2>Check your filament presets</h2>
                <p>
                  Preset Doctor reads your Bambu Studio presets and lists the ones Studio can no
                  longer show, usually because an update renamed the preset they were based on.
                  Scanning only reads files; nothing changes until you review a repair and click to
                  apply it.
                </p>
              </>
            ) : (
              <>
                <h2>Bambu Studio's data folder wasn't found</h2>
                <p>
                  It usually lives at <code>%APPDATA%\BambuStudio</code>. Open Bambu Studio once, or
                  use <strong>Change folder…</strong> to pick it.
                </p>
              </>
            )}
          </div>
        )}
        {payload && counts && (
          <div className="split">
            <FindingsTable
              rows={rows}
              byPath={byPath}
              selection={selection}
              selectedPath={selectedPath}
              filter={filter}
              search={search}
              problemCount={problemCount}
              totalCount={payload.result.presets.length}
              onFilter={setFilter}
              onSearch={setSearch}
              onSelect={setSelectedPath}
              onToggle={toggle}
            />
            <DetailPanel
              preset={selectedPreset}
              findings={selectedFindings}
              fixes={selectedFixes}
              selection={selection}
              preview={preview}
              onPick={pick}
              onToggle={toggle}
            />
          </div>
        )}
      </main>

      {payload && (
        <FixBar
          count={choices.length}
          studio={studio}
          busy={busy}
          confirmToWrite={web}
          studioGate={studioGate}
          onFix={() => void planReview(updateBaseId)}
        />
      )}
      <Footer
        version={config?.version ?? ''}
        donationUrl={config?.donationUrl ?? ''}
        onRestore={() => setBackupsOpen(true)}
      />

      {review && (
        <ReviewDialog
          plan={review.plan}
          loading={review.loading}
          error={review.error}
          updateBaseId={updateBaseId}
          studio={studio}
          applying={applying}
          onToggleBaseId={(on) => {
            setUpdateBaseId(on);
            void planReview(on);
          }}
          onApply={() => void apply()}
          onClose={closeReview}
        />
      )}
      {backupsOpen && (
        <BackupsDialog
          platform={config?.platform ?? 'desktop'}
          root={root}
          backupsDir={config?.backupsDir ?? ''}
          studio={studio}
          studioGate={studioGate}
          onClose={() => setBackupsOpen(false)}
          onRestored={(id, count) => {
            setBackupsOpen(false);
            noteWritten([], true);
            setStudioConfirmed(false);
            setNotice({ kind: 'success', ...restoreNotice(id, count, web) });
            void runScan(root, userId);
          }}
          onRestoreStopped={(message, written) => {
            // Some files were put back, some not: say which backup undoes it, show the real state.
            setBackupsOpen(false);
            noteWritten(written);
            setNotice({ kind: 'error', title: 'The restore stopped part-way.', lines: [message] });
            void runScan(root, userId);
          }}
        />
      )}
    </div>
  );
}

/**
 * Polls whether Bambu Studio is running while `enabled`. The next check is scheduled only once
 * the previous one has answered, so slow process checks never overlap or arrive out of order.
 */
function useStudioStatus(enabled: boolean): StudioState | 'checking' {
  const [state, setState] = useState<StudioState | 'checking'>('checking');
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: number | undefined;
    const check = (): void => {
      api
        .studioStatus()
        .then(
          (r) => (r.ok ? r.value : 'unknown'),
          () => 'unknown' as const,
        )
        .then((s) => {
          if (!alive) return;
          setState(s);
          timer = window.setTimeout(check, STUDIO_POLL_MS);
        });
    };
    check();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [enabled]);
  return state;
}

/** Live diff of the fix chosen for the selected preset. Ignores answers to older requests. */
function usePreview(
  choice: ReturnType<typeof choiceFor>,
  updateBaseId: boolean,
  payload: ScanPayload | null,
): Preview {
  const [preview, setPreview] = useState<Preview>({ loading: false, changes: null, error: null });
  const seq = useRef(0);
  const key = choice ? JSON.stringify(choice) : '';
  useEffect(() => {
    const id = ++seq.current;
    if (!choice || !payload) {
      setPreview({ loading: false, changes: null, error: null });
      return;
    }
    setPreview((p) => ({ ...p, loading: true, error: null }));
    call(api.plan([choice], { updateBaseId })).then(
      (plan) =>
        id === seq.current && setPreview({ loading: false, changes: plan.changes, error: null }),
      (e: unknown) =>
        id === seq.current && setPreview({ loading: false, changes: null, error: messageOf(e) }),
    );
    // `key` stands in for `choice`, whose identity changes on every render.
  }, [key, updateBaseId, payload]);
  return preview;
}
