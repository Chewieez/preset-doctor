import type { Finding, PresetSummary, PresetType } from '@preset-doctor/core';
import {
  choiceFor,
  displayName,
  fixesFor,
  hasFix,
  typeOf,
  TYPE_TERMS,
  type Filter,
  type Selection,
} from '../model';
import { useSlicer } from '../slicerContext';
import { StatusBadge } from './Badges';

/** One preset-type tab: its type, how many presets it has, and how many need attention. */
export interface TypeTab {
  type: PresetType;
  count: number;
  problems: number;
}

interface Props {
  rows: PresetSummary[];
  byPath: Map<string, Finding[]>;
  selection: Selection;
  selectedPath: string | null;
  filter: Filter;
  /** Counts within the current tab. */
  problemCount: number;
  totalCount: number;
  search: string;
  /** The current preset type; its words are used for the empty text. */
  tab: PresetType;
  /** Shown as tabs only when there are two or more. */
  tabs: TypeTab[];
  onTab: (t: PresetType) => void;
  onFilter: (f: Filter) => void;
  onSearch: (q: string) => void;
  onSelect: (path: string) => void;
  onToggle: (path: string, checked: boolean) => void;
  /** Ticks (true) or unticks (false) these rows' repair boxes. */
  onToggleMany: (paths: string[], checked: boolean) => void;
}

export function FindingsTable(props: Props) {
  const { rows, byPath, selection, selectedPath } = props;
  const slicer = useSlicer();
  // Only the rows listed now: a search or filter narrows what "Select all" ticks.
  const fixablePaths = rows
    .filter((p) => hasFix(fixesFor(byPath.get(p.path) ?? [])))
    .map((p) => p.path);
  const ticked = fixablePaths.filter((p) => {
    const choice = choiceFor(p, fixesFor(byPath.get(p) ?? []), selection.picks);
    return Boolean(selection.checked[p]) && choice !== null;
  }).length;
  return (
    <section className="table-card" aria-label="Presets">
      {props.tabs.length > 1 && (
        <div className="type-tabs" role="group" aria-label="Preset type" data-testid="type-tabs">
          <div className="segmented">
            {props.tabs.map((t) => (
              <button
                key={t.type}
                type="button"
                aria-pressed={props.tab === t.type}
                onClick={() => props.onTab(t.type)}
                data-testid={`type-tab-${t.type}`}
              >
                {TYPE_TERMS[t.type].tab} ({t.count})
                {t.problems > 0 && (
                  <span
                    className="tab-badge"
                    title={`${t.problems} need${t.problems === 1 ? 's' : ''} attention`}
                  >
                    {t.problems}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="table-tools">
        <div className="segmented" role="group" aria-label="Show">
          <button
            type="button"
            aria-pressed={props.filter === 'problems'}
            onClick={() => props.onFilter('problems')}
          >
            Needs attention ({props.problemCount})
          </button>
          <button
            type="button"
            aria-pressed={props.filter === 'all'}
            onClick={() => props.onFilter('all')}
          >
            All presets ({props.totalCount})
          </button>
        </div>
        {fixablePaths.length > 0 && (
          <div className="select-tools" role="group" aria-label="Select for repair">
            <button
              type="button"
              className="btn small"
              disabled={ticked === fixablePaths.length}
              title="Tick every repair in the list below"
              onClick={() => props.onToggleMany(fixablePaths, true)}
              data-testid="select-all"
            >
              Select all
            </button>
            <button
              type="button"
              className="btn small"
              disabled={ticked === 0}
              title="Untick every repair in the list below"
              onClick={() => props.onToggleMany(fixablePaths, false)}
              data-testid="select-none"
            >
              Select none
            </button>
          </div>
        )}
        <input
          type="search"
          className="search"
          placeholder="Find a preset…"
          value={props.search}
          onChange={(e) => props.onSearch(e.target.value)}
          aria-label="Find a preset by name"
        />
      </div>
      <div className="table-scroll">
        {rows.length === 0 ? (
          <p className="empty" data-testid="table-empty">
            {props.totalCount === 0
              ? `This account has no ${TYPE_TERMS[props.tab].noun}s. If you expected some, check ` +
                'that this is the right folder and account.'
              : props.filter === 'problems' && props.search === ''
                ? props.totalCount === 1
                  ? `Nothing needs attention. This preset can be shown by ${slicer.name}.`
                  : `Nothing needs attention. All ${props.totalCount} presets can be shown by ${slicer.name}.`
                : 'No presets match.'}
          </p>
        ) : (
          <table className="table" data-testid="findings-table">
            <thead>
              <tr>
                <th className="col-check">
                  <span className="sr-only">Repair</span>
                </th>
                <th>Preset</th>
                <th className="col-status">Status</th>
                <th>What we found</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const fixes = fixesFor(byPath.get(p.path) ?? []);
                const fixable = hasFix(fixes);
                const choice = choiceFor(p.path, fixes, selection.picks);
                const checked = Boolean(selection.checked[p.path]) && choice !== null;
                const distinctModels = new Set(
                  fixes.candidates?.map((c) => c.printerModel).filter(Boolean),
                );
                const printerSummary =
                  distinctModels.size > 1
                    ? `${distinctModels.size} printers`
                    : (fixes.candidates?.[0]?.printerModel ?? 'installed printer');
                return (
                  <tr
                    key={p.path}
                    className={p.path === selectedPath ? 'selected' : undefined}
                    onClick={() => props.onSelect(p.path)}
                    onKeyDown={(e) => {
                      // Keys on the row's checkbox (or any other control in it) keep their
                      // normal meaning: Space ticks the box instead of selecting the row.
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        props.onSelect(p.path);
                      }
                    }}
                    tabIndex={0}
                    data-testid="preset-row"
                    data-status={p.status}
                    aria-current={p.path === selectedPath ? 'true' : undefined}
                  >
                    <td className="col-check" onClick={(e) => e.stopPropagation()}>
                      {fixable && (
                        <input
                          type="checkbox"
                          checked={checked}
                          title={
                            checked
                              ? 'Include in "Fix selected"'
                              : choice === null
                                ? 'Click to select recommended repair'
                                : 'Include in "Fix selected"'
                          }
                          aria-label={`Repair ${displayName(p)}`}
                          onChange={(e) => props.onToggle(p.path, e.target.checked)}
                        />
                      )}
                    </td>
                    <td className="col-name">
                      <span className="name">{displayName(p)}</span>
                      {p.isBase && <span className="tag">{TYPE_TERMS[typeOf(p)].baseTag}</span>}
                    </td>
                    <td className="col-status">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="col-reason">
                      <span>{p.reason}</span>
                      {checked && choice?.candidateName && (
                        <span className="fix-hint">
                          {p.status === 'unsupported' ? (
                            <>
                              Retarget: “{choice.candidateName}”
                              {fixes.candidates && fixes.candidates.length > 1 && (
                                <span className="fix-options-hint">
                                  {' '}
                                  (+{fixes.candidates.length - 1} other option
                                  {fixes.candidates.length > 2 ? 's' : ''} · click row to change)
                                </span>
                              )}
                            </>
                          ) : (
                            `Fix: use “${choice.candidateName}”`
                          )}
                        </span>
                      )}
                      {checked && choice?.rename && fixes.rename && (
                        <span className="fix-hint">Fix: rename to “{fixes.rename}”</span>
                      )}
                      {!checked && fixable && (
                        <span className="fix-hint fix-available">
                          {p.status === 'unsupported' &&
                          fixes.candidates &&
                          fixes.candidates.length > 0 ? (
                            <>
                              Retarget available: {printerSummary}
                              {fixes.candidates.length > 1 && (
                                <span className="fix-options-hint">
                                  {` (${fixes.candidates.length} options · click to choose)`}
                                </span>
                              )}
                            </>
                          ) : (
                            'Repair available'
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
