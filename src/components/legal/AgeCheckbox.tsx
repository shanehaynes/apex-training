// The 18+ attestation on open sign-up (docs/specs/open-signup.md M1). The
// terms already require it (legal/terms-v1.md §2); this makes it an act of
// its own rather than a clause inside "I agree". Same rules as
// AcceptanceCheckbox: unchecked by default, never pre-ticked. It reuses that
// control's classes so it sits as its twin without a stylesheet change.

export default function AgeCheckbox({
  checked,
  onChange,
  disabled,
  id = 'confirm-age',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <div className="legal-accept">
      <input
        id={id}
        type="checkbox"
        className="legal-accept__box"
        data-testid="age-confirm"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
      <label className="legal-accept__label" htmlFor={id}>
        I am 18 or older (or the age of majority where I live).
      </label>
    </div>
  );
}
