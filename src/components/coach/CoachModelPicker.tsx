import { useAuth } from '../../context/auth';
import { COACH_MODELS, DEFAULT_COACH_MODEL, priceLabel } from '../../lib/coach/models';

// The model badge in the coach header, made selectable. The coach runs on the
// user's own Anthropic key, so this is the one control that changes what they
// pay — hence the $/MTok in every option rather than a bare model name.
//
// Rendered identically by all three coach panels (sidebar, builder,
// analytics); the pick lives on profiles.coach_model, so switching in one
// switches everywhere, including the post-workout summary and the monthly
// review email.

export default function CoachModelPicker() {
  const { profile, updateProfile } = useAuth();
  // A null column means "follow the app default" — show what that resolves to
  // rather than an empty select, but leave the column null so a future
  // default bump still moves this user.
  const selected = profile?.coach_model ?? DEFAULT_COACH_MODEL;

  return (
    <select
      className="chat-sidebar__model-select"
      aria-label="Coach model"
      value={selected}
      onChange={e => { void updateProfile({ coachModel: e.target.value }); }}
      title="Which Claude model the coach runs on — billed to your own Anthropic key"
    >
      {COACH_MODELS.map(model => (
        <option key={model.id} value={model.id}>
          {model.label} · {priceLabel(model)}
        </option>
      ))}
    </select>
  );
}
