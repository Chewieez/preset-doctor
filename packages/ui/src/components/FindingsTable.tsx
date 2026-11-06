import type { Finding, PresetSummary } from '@preset-doctor/core';
import { choiceFor, displayName, fixesFor, hasFix, type Filter, type Selection } from '../model';
import { StatusBadge } from './Badges';

interface Props {
  rows: PresetSummary[];
  byPath: Map<string, Finding[]>;
  selection: Selection;
  selectedPath: string | null;
  filter: Filter;
  problemCount: number;
  totalCount: number;
  search: string;
  onFilter: (f: Filter) => void;
  onSearch: (q: string) => void;
  onSelect: (path: string) => void;
  onToggle: (path: string, checked: boolean) => void;
}

export function FindingsTable(props: Props) {
  const { rows, byPath, selection, selectedPath } = props;
  return (
    <section className="table-card" aria-label="Presets">
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
              ? 'This account has no filament presets. If you expected some, check that this is ' +
                'the right folder and account.'
              : props.filter === 'problems' && props.search === ''
                ? `Nothing needs attention. All ${props.totalCount} presets can be shown by Bambu Studio.`
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
                    aria-selected={p.path === selectedPath}
                  >
                    <td className="col-check" onClick={(e) => e.stopPropagation()}>
                      {fixable && (
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={choice === null}
                          title={
                            choice === null
                              ? 'Pick a replacement in the details first'
                              : 'Include in "Fix selected"'
                          }
                          aria-label={`Repair ${displayName(p)}`}
                          onChange={(e) => props.onToggle(p.path, e.target.checked)}
                        />
                      )}
                    </td>
                    <td className="col-name">
                      <span className="name">{displayName(p)}</span>
                      {p.isBase && <span className="tag">custom filament</span>}
                    </td>
                    <td className="col-status">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="col-reason">
                      <span>{p.reason}</span>
                      {checked && choice?.candidateName && (
                        <span className="fix-hint">Fix: use “{choice.candidateName}”</span>
                      )}
                      {checked && choice?.rename && fixes.rename && (
                        <span className="fix-hint">Fix: rename to “{fixes.rename}”</span>
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
