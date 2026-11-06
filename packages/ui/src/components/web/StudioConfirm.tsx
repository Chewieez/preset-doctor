interface Props {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * Web only. A browser can't see whether Bambu Studio is running, so the user confirms it.
 * Fix and Restore stay off until this is ticked.
 */
export function StudioConfirm({ checked, disabled = false, onChange }: Props) {
  return (
    <label className="option studio-confirm" data-testid="studio-confirm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <strong>I've closed Bambu Studio</strong>
        <span className="muted">
          {' '}
          (and made the copy after closing it; keep it closed until you've copied the files back)
        </span>
      </span>
    </label>
  );
}
