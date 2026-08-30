import { LEGAL_DOCUMENTS } from '../../lib/legal/versions';

// The clickwrap control itself, shared by the sign-up form, the invite
// set-password form, and the re-acceptance modal.
//
// Three properties are load-bearing, and none of them is decoration:
//
//   UNCHECKED BY DEFAULT. A pre-checked box is the single most common reason
//   a clickwrap is held unenforceable — there is no affirmative act to point
//   at. `checked` is driven by caller state that starts false; this
//   component has no defaultChecked and must never grow one.
//
//   LINKS ADJACENT TO THE BOX. Not in a footer, not behind a "learn more".
//   Courts look at whether the terms were reasonably conspicuous at the
//   moment of assent, and a footer link (browsewrap) routinely fails that.
//
//   VERSIONS SHOWN. The user can see which version they are agreeing to, and
//   it matches what the server writes to the ledger.
//
// target="_blank" so opening the documents never discards a half-filled
// form — losing a typed password to read the terms is a good way to teach
// people not to read the terms.

export default function AcceptanceCheckbox({
  checked,
  onChange,
  disabled,
  id = 'accept-legal',
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
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
      <label className="legal-accept__label" htmlFor={id}>
        I have read and agree to the{' '}
        {LEGAL_DOCUMENTS.map((doc, i) => (
          <span key={doc.slug}>
            {i > 0 ? ' and the ' : ''}
            <a href={doc.path} target="_blank" rel="noreferrer">{doc.title}</a>
          </span>
        ))}
        .{' '}
        <span className="legal-accept__versions">
          ({LEGAL_DOCUMENTS.map(d => d.version).join(', ')})
        </span>
      </label>
    </div>
  );
}
