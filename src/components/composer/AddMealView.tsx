import { useState } from 'react';
import { useModalChrome } from '../../hooks/useModalChrome';
import { createPortal } from 'react-dom';
import { Star, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useCalendar } from '../../context/calendar';
import { useMeals } from '../../context/meals';
import { toDisplayTime, toInputTime } from '../../lib/time';
import { now } from '../../lib/clock';
import { notify } from '../../lib/notify';
import { derivedCalories, validateFatSplit } from '../../lib/nutrition/mapping';
import { MEAL_TYPES, type CreateMealInput, type MealFavorite, type MealType } from '../../types/nutrition';

const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
};

const numStr = (n?: number) => (n === undefined ? '' : String(n));

/**
 * Full-screen add/edit-meal flow (same overlay pattern as the add-event
 * composer, minus its type-picker phase — meal type is just a field, it
 * doesn't branch the form). Opened with state.editingMeal set, it edits that
 * meal in place. Fat total is independent of the sat/trans split; calories
 * derive 4/4/9/7 from the macros (incl. alcohol) unless typed over.
 */
export default function AddMealView() {
  const { state, dispatch } = useCalendar();
  const { createMeal, updateMeal, favorites, saveFavorite, deleteFavorite } = useMeals();
  const close = () => dispatch({ type: 'CLOSE_MEAL_COMPOSER' });

  // Snapshot, not live state: the meal being edited never changes while the
  // overlay is open (opening it cleared every other surface).
  const editing = state.editingMeal;

  const [title, setTitle] = useState(editing?.title ?? '');
  const [date, setDate] = useState(editing?.date ?? state.mealComposerDate ?? format(now(), 'yyyy-MM-dd'));
  const [time, setTime] = useState(editing?.time ? toInputTime(editing.time) : '');
  const [mealType, setMealType] = useState<MealType | null>(editing?.mealType ?? null);
  // Strings, not numbers: parseFloat-on-change can't represent an empty
  // field, which made the input impossible to clear. Parsed on save.
  const [calories, setCalories] = useState(numStr(editing?.calories));
  const [protein, setProtein] = useState(numStr(editing?.proteinG));
  const [carbs, setCarbs] = useState(numStr(editing?.carbsG));
  const [fiber, setFiber] = useState(numStr(editing?.fiberG));
  const [sugar, setSugar] = useState(numStr(editing?.sugarG));
  const [fatTotal, setFatTotal] = useState(numStr(editing?.fatTotalG));
  const [fatSaturated, setFatSaturated] = useState(numStr(editing?.fatSaturatedG));
  const [fatTrans, setFatTrans] = useState(numStr(editing?.fatTransG));
  const [alcohol, setAlcohol] = useState(numStr(editing?.alcoholG));
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [saving, setSaving] = useState(false);

  useModalChrome(close);

  /** Blank → undefined; otherwise a finite number ≥ 0, or NaN to flag invalid. */
  const parseGrams = (value: string): number | undefined => {
    if (!value.trim()) return undefined;
    const n = parseFloat(value);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };

  /** Validate + parse the whole form; null (with a toast) on any violation. */
  const parseForm = () => {
    if (!title.trim()) { notify('Give the meal a title'); return null; }

    const fields: [string, number | undefined][] = [
      ['Calories', parseGrams(calories)],
      ['Protein', parseGrams(protein)],
      ['Carbs', parseGrams(carbs)],
      ['Fiber', parseGrams(fiber)],
      ['Sugar', parseGrams(sugar)],
      ['Total fat', parseGrams(fatTotal)],
      ['Saturated fat', parseGrams(fatSaturated)],
      ['Trans fat', parseGrams(fatTrans)],
      ['Alcohol', parseGrams(alcohol)],
    ];
    const invalid = fields.find(([, v]) => v !== undefined && Number.isNaN(v));
    if (invalid) { notify(`${invalid[0]} must be a number of at least 0`); return null; }

    const [cal, proteinG, carbsG, fiberG, sugarG, fatTotalG, fatSaturatedG, fatTransG, alcoholG] =
      fields.map(([, v]) => v);

    if (!validateFatSplit(fatTotalG, fatSaturatedG, fatTransG)) {
      notify("Total fat can't be less than saturated + trans");
      return null;
    }

    return {
      title: title.trim(),
      mealType: mealType ?? undefined,
      calories: cal,
      proteinG, carbsG, fiberG, sugarG,
      fatTotalG, fatSaturatedG, fatTransG, alcoholG,
      notes: notes.trim(),
    };
  };

  const save = async () => {
    const parsed = parseForm();
    if (!parsed) return;

    // Every key present on purpose: in edit mode a blanked field must CLEAR
    // its column (mealFieldsToRow nulls present-but-undefined keys).
    const input: CreateMealInput = {
      ...parsed,
      date,
      time: time ? toDisplayTime(time) ?? undefined : undefined,
    };

    setSaving(true);
    const result = editing
      ? await updateMeal({ id: editing.id, fields: input })
      : await createMeal(input);
    setSaving(false);
    if (result) {
      notify(editing ? 'Meal updated' : 'Meal added');
      close();
    } else {
      notify('Failed to save — try again');
    }
  };

  // ── Favorites (meal library) ───────────────────────────────────────────────

  /** Fill the form from a template — everything but the calendar placement. */
  const applyFavorite = (f: MealFavorite) => {
    setTitle(f.title);
    setMealType(f.mealType ?? null);
    setCalories(numStr(f.calories));
    setProtein(numStr(f.proteinG));
    setCarbs(numStr(f.carbsG));
    setFiber(numStr(f.fiberG));
    setSugar(numStr(f.sugarG));
    setFatTotal(numStr(f.fatTotalG));
    setFatSaturated(numStr(f.fatSaturatedG));
    setFatTrans(numStr(f.fatTransG));
    setAlcohol(numStr(f.alcoholG));
    setNotes(f.notes);
  };

  const saveToLibrary = async () => {
    const parsed = parseForm();
    if (!parsed) return;
    // Same title (case-insensitive) overwrites the existing favorite instead
    // of accumulating near-duplicates.
    const existing = favorites.find(f => f.title.toLowerCase() === parsed.title.toLowerCase());
    setSaving(true);
    const result = await saveFavorite({ ...parsed, id: existing?.id });
    setSaving(false);
    notify(result
      ? existing ? 'Library favorite updated' : 'Saved to library'
      : 'Failed to save — try again');
  };

  const removeFavorite = async (f: MealFavorite) => {
    const ok = await deleteFavorite(f.id);
    notify(ok ? 'Removed from library' : 'Failed to remove — try again');
  };

  const derived = derivedCalories({
    proteinG: parseGrams(protein),
    carbsG: parseGrams(carbs),
    fatTotalG: parseGrams(fatTotal),
    alcoholG: parseGrams(alcohol),
  });

  return createPortal(
    <div className="composer-view">
      <header className="library-header">
        <div className="library-header__titles">
          <h1 className="library-header__title">{editing ? 'Edit Meal' : 'Add Meal'}</h1>
          <span className="library-header__count">{format(parseISO(date), 'EEEE, MMM d')}</span>
        </div>
        <div className="library-header__actions">
          <button className="library-close" onClick={close} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="composer-form meal-form">
        <div className="composer-fields">
          {favorites.length > 0 && (
            <div className="library-field composer-field--wide">
              <span className="library-field__label">From library <em>tap to fill</em></span>
              <div className="meal-fav-row">
                {favorites.map(f => (
                  <div key={f.id} className="meal-fav-chip">
                    <button
                      type="button"
                      className="meal-fav-chip__apply"
                      onClick={() => applyFavorite(f)}
                    >
                      {f.title}
                    </button>
                    <button
                      type="button"
                      className="meal-fav-chip__remove"
                      aria-label={`Remove ${f.title} from library`}
                      onClick={() => removeFavorite(f)}
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <label className="library-field composer-field--wide">
            <span className="library-field__label">Title</span>
            <input className="library-field__input" value={title} onChange={e => setTitle(e.target.value)} />
          </label>
          <label className="library-field">
            <span className="library-field__label">Date</span>
            <input type="date" className="library-field__input" value={date} onChange={e => setDate(e.target.value)} />
          </label>
          <label className="library-field">
            <span className="library-field__label">Time <em>optional</em></span>
            <input type="time" className="library-field__input" value={time} onChange={e => setTime(e.target.value)} />
          </label>
          <div className="library-field composer-field--wide">
            <span className="library-field__label">Meal type <em>optional</em></span>
            <div className="meal-type-row">
              {MEAL_TYPES.map(t => (
                <button
                  key={t}
                  type="button"
                  className={`meal-type-row__btn${mealType === t ? ' meal-type-row__btn--active' : ''}`}
                  onClick={() => setMealType(prev => (prev === t ? null : t))}
                >
                  {MEAL_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          <label className="library-field">
            <span className="library-field__label">Protein (g)</span>
            <input inputMode="decimal" className="library-field__input" value={protein} onChange={e => setProtein(e.target.value)} />
          </label>
          <label className="library-field">
            <span className="library-field__label">Carbs (g)</span>
            <input inputMode="decimal" className="library-field__input" value={carbs} onChange={e => setCarbs(e.target.value)} />
          </label>
          <label className="library-field">
            <span className="library-field__label">Fiber (g) <em>optional</em></span>
            <input inputMode="decimal" className="library-field__input" value={fiber} onChange={e => setFiber(e.target.value)} />
          </label>
          <label className="library-field">
            <span className="library-field__label">Sugar (g) <em>optional</em></span>
            <input inputMode="decimal" className="library-field__input" value={sugar} onChange={e => setSugar(e.target.value)} />
          </label>
          <label className="library-field">
            <span className="library-field__label">Total fat (g) <em>fillable without the split</em></span>
            <input inputMode="decimal" className="library-field__input" value={fatTotal} onChange={e => setFatTotal(e.target.value)} />
          </label>
          <label className="library-field">
            <span className="library-field__label">Saturated fat (g) <em>optional</em></span>
            <input inputMode="decimal" className="library-field__input" value={fatSaturated} onChange={e => setFatSaturated(e.target.value)} />
          </label>
          <label className="library-field">
            <span className="library-field__label">Trans fat (g) <em>optional</em></span>
            <input inputMode="decimal" className="library-field__input" value={fatTrans} onChange={e => setFatTrans(e.target.value)} />
          </label>
          <label className="library-field">
            <span className="library-field__label">Alcohol (g) <em>optional</em></span>
            <input inputMode="decimal" className="library-field__input" value={alcohol} onChange={e => setAlcohol(e.target.value)} />
          </label>
          <label className="library-field">
            <span className="library-field__label">Calories <em>auto from macros</em></span>
            <input
              inputMode="decimal"
              className="library-field__input"
              placeholder={derived === null ? '' : String(derived)}
              value={calories}
              onChange={e => setCalories(e.target.value)}
            />
          </label>
          <label className="library-field composer-field--wide">
            <span className="library-field__label">Notes <em>optional</em></span>
            <textarea
              className="library-field__input library-field__input--textarea"
              rows={3}
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </label>
        </div>

        <div className="exercise-editor__bar composer-actions">
          <button className="meal-fav-save" onClick={saveToLibrary} disabled={saving}>
            <Star size={13} strokeWidth={1.5} /> Save to library
          </button>
          <button className="exercise-editor__cancel" onClick={close} disabled={saving}>Cancel</button>
          <button className="exercise-editor__save" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add meal'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
