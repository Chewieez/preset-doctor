import { useEffect, useState } from 'react';

/** A path or snippet the user may want to paste somewhere, with a Copy button next to it. */
export function CopyText({ text }: { text: string }) {
  return (
    <span className="copy-text">
      <code>{text}</code>
      <CopyButton text={text} />
    </span>
  );
}

export function CopyButton({ text, title = 'Copy' }: { text: string; title?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 1800);
    return () => window.clearTimeout(t);
  }, [state]);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <button type="button" className="btn small" onClick={() => void copy()}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it and copy' : title}
    </button>
  );
}
