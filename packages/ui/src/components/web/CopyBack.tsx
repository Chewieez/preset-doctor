import { windowsPath } from '../../model';
import { useSlicer } from '../../slicerContext';
import { CopyButton, CopyText } from './CopyText';

interface Props {
  /** The picked folder's name (browsers don't reveal the full path). */
  root: string;
  /** Changed files, '/'-joined, relative to the slicer folder. */
  files: string[];
  /** A backup was restored, which rewrites every file in `user`. */
  restored: boolean;
  onDismiss: () => void;
}

/**
 * Web only: the last step, copying the repaired files back into the slicer's folder.
 *
 * The main instruction is to copy only the changed files: the copy may be older than the slicer's
 * own folder, and copying the whole `user` folder back would replace every preset changed in
 * the slicer since the copy was made.
 */
export function CopyBack({ root, files, restored, onDismiss }: Props) {
  const s = useSlicer();
  const list = files.map(windowsPath);
  // After a restore any file may differ, so only the whole folder is a complete copy-back.
  const wholeFolder = restored || list.length === 0;
  return (
    <section className="banner copy-back" role="status" data-testid="copy-back">
      <div>
        <strong>
          Last step: copy the {wholeFolder ? 'user folder' : 'repaired files'} back into {s.name}
        </strong>
        <ol className="steps compact">
          <li>Keep {s.name} closed.</li>
          {wholeFolder ? (
            <li>
              Copy the <code>user</code> folder from <code>{root}</code> into{' '}
              <CopyText text={s.folder} /> and choose{' '}
              <strong>Replace the files in the destination</strong>.
            </li>
          ) : (
            <li>
              Copy each file listed below from <code>{root}</code> to the same place inside{' '}
              <CopyText text={s.folder} /> and choose{' '}
              <strong>Replace the file in the destination</strong>. Copy only these files.
            </li>
          )}
          <li>Open {s.name} and check that your presets are back.</li>
        </ol>
        {restored && <p>A backup was restored, so any file in the user folder may have changed.</p>}
        <p className="warn-text">
          {wholeFolder ? 'Only do this' : 'Copy the whole user folder back only'} if you made the
          copy just before repairing and {s.name} has stayed closed since. Otherwise it would
          replace presets you changed in {s.short} after making the copy: make a fresh copy and
          repair again instead.
        </p>
        {list.length > 0 && (
          <>
            <p>
              Files changed so far ({list.length}), inside <code>{s.dirName}</code>:
            </p>
            <ul className="file-list" data-testid="changed-files">
              {list.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="banner-actions">
        {list.length > 0 && <CopyButton text={list.join('\r\n')} title="Copy list" />}
        <button type="button" className="btn ghost" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
    </section>
  );
}
