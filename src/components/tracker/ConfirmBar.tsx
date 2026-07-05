interface Props {
  message: string;
  confirmLabel: string;
  keepLabel?: string;
  /** Red confirm button (destructive action) instead of the accent color. */
  danger?: boolean;
  accentColor?: string;
  disabled?: boolean;
  onKeep: () => void;
  onConfirm: () => void;
}

export default function ConfirmBar({
  message,
  confirmLabel,
  keepLabel = 'Keep going',
  danger,
  accentColor,
  disabled,
  onKeep,
  onConfirm,
}: Props) {
  return (
    <div className="tracker-confirm">
      <span className="tracker-confirm__msg">{message}</span>
      <button className="tracker-confirm__cancel" onClick={onKeep} disabled={disabled}>
        {keepLabel}
      </button>
      <button
        className={`tracker-confirm__go${danger ? ' tracker-confirm__go--danger' : ''}`}
        style={danger ? undefined : { background: accentColor }}
        onClick={onConfirm}
        disabled={disabled}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
