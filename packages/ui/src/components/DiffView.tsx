import type { PlannedChange } from '../contract';

/** One planned file edit as a coloured unified diff. */
export function DiffView({ change }: { change: PlannedChange }) {
  const lines = change.diff
    .split('\n')
    .filter((l) => !l.startsWith('--- ') && !l.startsWith('+++ '));
  return (
    <figure className="diff" data-testid="diff">
      <figcaption>
        <span>{change.description}</span>
        <code className="diff-path">{change.path}</code>
      </figcaption>
      <pre>
        {lines.map((line, i) => {
          const kind = line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'del'
              : line.startsWith('@@')
                ? 'hunk'
                : 'ctx';
          return (
            <span key={i} className={`diff-line ${kind}`}>
              {line === '' ? ' ' : line}
              {'\n'}
            </span>
          );
        })}
      </pre>
    </figure>
  );
}
