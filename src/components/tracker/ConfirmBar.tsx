import { useTip } from '../../hooks/useTip';
import type { TipId } from '../../lib/onboarding/tips/index';

interface Props {
  /** One-time tip to offer while this bar is up (the unlogged-sets bar's). */
  tip?: TipId;
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

// A child, so the generic bar offers a tip only when a caller names one: the
// cancel confirm shares this component and must stay silent.
function OfferTip({ id }: { id: TipId }) {
  useTip(id);
  return null;
}

export default function ConfirmBar({
  tip,
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
      {tip && <OfferTip id={tip} />}
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
