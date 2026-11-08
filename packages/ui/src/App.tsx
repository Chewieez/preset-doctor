import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Finding,
  FixChoice,
  PresetSummary,
  PresetType,
  ScanResult,
} from '@preset-doctor/core';
import type { AppConfig, PlanPayload, ScanPayload, StudioState } from './contract';
import { api, AppError, call, messageOf } from './api';
import { BackupsDialog } from './components/BackupsDialog';
import { DetailPanel, type Preview } from './components/DetailPanel';
import { FindingsTable } from './components/FindingsTable';
import { FixBar } from './components/FixBar';
import { NozzlesDialog } from './components/NozzlesDialog';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { PrintersStrip, type StripNote } from './components/PrintersStrip';
import { ReviewDialog } from './components/ReviewDialog';
import { CopyBack } from './components/web/CopyBack';
import { StudioConfirm } from './components/web/StudioConfirm';
import { WebGuide } from './components/web/WebGuide';
import {
  choiceFor,
  cloudSyncFinding,
  COMPAT_COPIES_QUERY,
  COMPAT_OTHER_QUERY,
  countByStatus,
  countByType,
  defaultTab,
  familyCopies,
  familyCopiesFinding,
  findingsByPath,
  fixesFor,
  forOtherSelection,
  initialSelection,
  isProblem,
  mergePaths,
  notForSelectionFinding,
  nozzleNotice,
  nozzleOffers,
  partialIndexText,
  presetsOfType,
  presetTabs,
  problemsByType,
  repairNotice,
  restoreNotice,
  selectedChoices,
  setChecked,
  SLICER_TEXT,
  slicerOfRoot,
  typeOf,
  unreadIndexTypes,
  visiblePresets,
  type Filter,
  type Selection,
} from './model';
import { SlicerContext } from './slicerContext';

const STUDIO_POLL_MS = 3000;

interface Notice {
  kind: 'success' | 'error';
  title: string;
  lines: string[];
  /** The backup made or used, offered for download in the web version. */
  backupId?: string;
}

/** Web: what the user has to copy back into the slicer's folder. */
interface CopyBackState {
  files: string[];
  restored: boolean;
}

interface ReviewState {
  /** What is reviewed: repairs, or offering presets for more nozzle sizes. */
  kind: 'repair' | 'nozzles';
  choices: FixChoice[];
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
  const [tab, setTab] = useState<PresetType>('filament');
  /** Folder and account of the last scan: a rescan of the same ones keeps the open tab. */
  const lastScanned = useRef('');
  const [updateBaseId, setUpdateBaseId] = useState(true);
  const [review, setReview] = useState<ReviewState | null>(null);
  /** The "more nozzle sizes" dialog, open with these presets ticked. */
  const [nozzlesFor, setNozzlesFor] = useState<string[] | null>(null);
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
      const key = `${dir}\u0000${p.result.userId}`;
      const tabs = presetTabs(p.result);
      const fresh = defaultTab(p.result, findingsByPath(p.result));
      // Compared now: React runs the updater later, after the ref below has changed.
      const rescan = key === lastScanned.current;
      setTab((prev) => (rescan && tabs.includes(prev) ? prev : fresh));
      lastScanned.current = key;
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
    () => (payload ? visiblePresets(payload.result, byPath, filter, search, tab) : []),
    [payload, byPath, filter, search, tab],
  );
  const tabRows = useMemo(
    () => (payload ? presetsOfType(payload.result, tab) : []),
    [payload, tab],
  );
  const problemCount = useMemo(
    () => tabRows.filter((p) => isProblem(p, byPath)).length,
    [tabRows, byPath],
  );
  const typeTabs = useMemo(() => {
    if (!payload) return [];
    const counts = countByType(payload.result);
    const problems = problemsByType(payload.result, byPath);
    return presetTabs(payload.result).map((t) => ({
      type: t,
      count: counts[t],
      problems: problems[t],
    }));
  }, [payload, byPath]);
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
  const otherNote = payload ? notForSelectionFinding(payload.result) : undefined;
  const copiesNote = payload ? familyCopiesFinding(payload.result) : undefined;
  const offers = useMemo(() => (payload ? nozzleOffers(payload.result) : []), [payload]);
  // The scan's slicer; before a scan, the slicer whose default folder is shown (desktop).
  const rootSlicer = slicerOfRoot(config?.slicers ?? [], root);
  const slicer = SLICER_TEXT[payload?.result.slicer ?? rootSlicer ?? 'bambu'];
  /** False while `slicer` is only the Bambu Studio fallback (no scan, not a default folder). */
  const slicerKnown = payload !== null || rootSlicer !== undefined;
  const slicerName = slicer.name;
  const unreadTypes = payload ? unreadIndexTypes(payload.result) : [];
  const partialIndex = partialIndexText(unreadTypes, slicer.name);
  /** "Show them" on a grouped note: every row it counts, on a tab that has some. */
  const showRows = (query: string, rows: (r: ScanResult) => PresetSummary[]): void => {
    if (!payload) return;
    const types = rows(payload.result).map(typeOf);
    setFilter('all');
    setSearch(query);
    if (types.length > 0 && !types.includes(tab)) {
      setTab(types[0]!);
      setSelectedPath(null);
    }
  };
  const busy = scanning || applying;

  /** Shows and scans another folder (a picked one, or the other slicer's). */
  const openFolder = async (dir: string): Promise<void> => {
    setRoot(dir);
    setPayload(null);
    // The account and the "Studio is closed" confirmation were about the previous folder.
    setUserId(undefined);
    setStudioConfirmed(false);
    setNotice(null);
    setCopyBack(null);
    setSelectedPath(null);
    await runScan(dir, undefined);
  };

  const changeFolder = async (): Promise<void> => {
    try {
      const picked = await call(api.pickFolder());
      if (picked === null) return;
      await openFolder(picked);
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
    setSelection((s) => {
      let picks = s.picks;
      if (on && picks[path] === undefined) {
        const findings = byPath.get(path) ?? [];
        const fixes = fixesFor(findings);
        if (fixes.candidates && fixes.candidates.length > 0) {
          const best = fixes.candidates.find((c) => c.confidence === 'high') ?? fixes.candidates[0];
          if (best) {
            picks = { ...picks, [path]: best.name };
          }
        }
      }
      return {
        picks,
        checked: { ...s.checked, [path]: on },
      };
    });
  };

  const planReview = async (
    baseId: boolean,
    list: FixChoice[] = choices,
    kind: ReviewState['kind'] = 'repair',
  ): Promise<void> => {
    const id = ++reviewSeq.current;
    const base = { kind, choices: list };
    setReview({ ...base, plan: null, loading: true, error: null });
    try {
      const plan = await call(api.plan(list, { updateBaseId: baseId }));
      if (id === reviewSeq.current) setReview({ ...base, plan, loading: false, error: null });
    } catch (e) {
      if (id === reviewSeq.current) {
        setReview({ ...base, plan: null, loading: false, error: messageOf(e) });
      }
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
      const ctx = {
        web,
        cloud: cloud !== undefined,
        backupsDir: config?.backupsDir ?? '',
        slicer: slicer.id,
      };
      setNotice({
        kind: 'success',
        backupId: r.backup.id,
        ...(review.kind === 'nozzles' ? nozzleNotice(r, ctx) : repairNotice(r, ctx)),
      });
      await runScan(root, userId);
    } catch (e) {
      if (e instanceof AppError && e.code === 'partial') {
        closeReview();
        noteWritten(e.written ?? []);
        setNotice({
          kind: 'error',
          title:
            review.kind === 'nozzles'
              ? 'The change stopped part-way.'
              : 'The repair stopped part-way.',
          lines: [e.message],
        });
        await runScan(root, userId);
      } else {
        setReview((r) => (r ? { ...r, error: messageOf(e) } : r));
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <SlicerContext.Provider value={slicer}>
      <div className="app">
        <Header
          platform={config?.platform ?? 'desktop'}
          root={root}
          slicers={config?.slicers ?? []}
          accounts={payload?.result.accounts ?? []}
          userId={userId}
          studio={studio}
          busy={busy}
          onChangeFolder={() => void changeFolder()}
          onChangeAccount={(id) => void runScan(root, id)}
          onSwitchSlicer={(dir) => void openFolder(dir)}
        />

        {config?.testMode && (
          <div className="banner warning" role="status" data-testid="test-mode-banner">
            <span>
              <strong>Test mode.</strong> Started with PRESET_DOCTOR_ROOT, so the {slicer.name}{' '}
              check may be simulated for the folder it names.
            </span>
          </div>
        )}
        {payload && (unreadTypes.length > 0 || !payload.result.systemIndexRead) && (
          <div className="banner warning" role="alert" data-testid="no-system-banner">
            <span>
              <strong>These results are incomplete.</strong>{' '}
              {partialIndex ?? (
                <>
                  {slicer.name}'s system presets (<code>{slicer.index}</code>) could not be read, so
                  Preset Doctor couldn't check whether the presets yours are based on still exist.
                </>
              )}{' '}
              {web
                ? 'Copy the "system" folder into your copy again, then scan again.'
                : `Open ${slicer.name} once, close it, then scan again.`}
            </span>
          </div>
        )}
        {cloud && (
          <div className="banner info" role="note" data-testid="cloud-banner">
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
              {counts.unsupported > 0 && (
                <span className="count unsupported">{counts.unsupported} unsupported</span>
              )}
              <span className="count info">{counts.info} with notes</span>
              <span className="count ok">{counts.ok} OK</span>
              {payload?.result.systemVersion && (
                <span className="muted">
                  · {slicer.short} presets version {payload.result.systemVersion}
                </span>
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
                    Preset Doctor reads your {slicer.name} presets and lists the ones {slicer.short}{' '}
                    can no longer show, usually because an update renamed the preset they were based
                    on. Scanning only reads files; nothing changes until you review a repair and
                    click to apply it.
                  </p>
                </>
              ) : (
                <>
                  <h2>No Bambu Studio or OrcaSlicer data folder was found</h2>
                  <p>
                    Bambu Studio keeps it at <code>{SLICER_TEXT.bambu.folder}</code>, OrcaSlicer at{' '}
                    <code>{SLICER_TEXT.orca.folder}</code>. Open your slicer once, or use{' '}
                    <strong>Change folder…</strong> to pick its folder.
                  </p>
                </>
              )}
            </div>
          )}
          {payload && (
            <PrintersStrip
              compat={payload.result.compat}
              slicer={slicerName}
              notes={
                [
                  ...(otherNote
                    ? [
                        {
                          finding: otherNote,
                          onShow: () => showRows(COMPAT_OTHER_QUERY, forOtherSelection),
                          testId: 'other-printer-note',
                        },
                      ]
                    : []),
                  ...(copiesNote
                    ? [
                        {
                          finding: copiesNote,
                          onShow: () => showRows(COMPAT_COPIES_QUERY, familyCopies),
                          testId: 'family-copies-note',
                        },
                      ]
                    : []),
                  ...(offers.length > 0
                    ? [
                        {
                          finding: {
                            title: 'Some presets are offered for only some of your nozzle sizes',
                            explanation:
                              `${offers.length} filament preset${offers.length === 1 ? ' is' : 's are'} ` +
                              `offered in ${slicer.name} for some of the nozzle sizes you've added, ` +
                              'not all. Preset Doctor can add the others.',
                          },
                          onShow: () => setNozzlesFor([]),
                          testId: 'nozzles-note',
                          action: 'Choose presets…',
                        },
                      ]
                    : []),
                ] satisfies StripNote[]
              }
            />
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
                totalCount={tabRows.length}
                tab={tab}
                tabs={typeTabs}
                onTab={(t) => {
                  setTab(t);
                  // The detail panel would otherwise show a row of another tab.
                  setSelectedPath(null);
                }}
                onFilter={setFilter}
                onSearch={setSearch}
                onSelect={setSelectedPath}
                onToggle={toggle}
                onToggleMany={(paths, on) =>
                  setSelection((s) => {
                    let picks = s.picks;
                    if (on) {
                      for (const p of paths) {
                        if (picks[p] === undefined) {
                          const findings = byPath.get(p) ?? [];
                          const fixes = fixesFor(findings);
                          if (fixes.candidates && fixes.candidates.length > 0) {
                            const best =
                              fixes.candidates.find((c) => c.confidence === 'high') ??
                              fixes.candidates[0];
                            if (best) {
                              picks = { ...picks, [p]: best.name };
                            }
                          }
                        }
                      }
                    }
                    return setChecked({ ...s, picks }, paths, on);
                  })
                }
              />
              <DetailPanel
                preset={selectedPreset}
                findings={selectedFindings}
                fixes={selectedFixes}
                selection={selection}
                preview={preview}
                slicer={slicerName}
                onPick={pick}
                onToggle={toggle}
                onMoreNozzles={(path) => setNozzlesFor([path])}
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
            kind={review.kind}
            onToggleBaseId={(on) => {
              setUpdateBaseId(on);
              void planReview(on, review.choices, review.kind);
            }}
            onApply={() => void apply()}
            onClose={closeReview}
          />
        )}
        {nozzlesFor && (
          <NozzlesDialog
            offers={offers}
            initial={nozzlesFor}
            onClose={() => setNozzlesFor(null)}
            onReview={(list) => {
              setNozzlesFor(null);
              void planReview(updateBaseId, list, 'nozzles');
            }}
          />
        )}
        {backupsOpen && (
          <BackupsDialog
            platform={config?.platform ?? 'desktop'}
            root={root}
            backupsDir={config?.backupsDir ?? ''}
            slicerKnown={slicerKnown}
            studio={studio}
            studioGate={studioGate}
            onClose={() => setBackupsOpen(false)}
            onRestored={(id, count, skipped) => {
              setBackupsOpen(false);
              noteWritten([], true);
              setStudioConfirmed(false);
              setNotice({ kind: 'success', ...restoreNotice(id, count, web, slicer.id, skipped) });
              void runScan(root, userId);
            }}
            onRestoreStopped={(message, written) => {
              // Some files were put back, some not: say which backup undoes it, show the real state.
              setBackupsOpen(false);
              noteWritten(written);
              setNotice({
                kind: 'error',
                title: 'The restore stopped part-way.',
                lines: [message],
              });
              void runScan(root, userId);
            }}
          />
        )}
      </div>
    </SlicerContext.Provider>
  );
}

/**
 * Polls whether the slicer is running while `enabled`. The next check is scheduled only once
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
