import { createPortal } from 'react-dom';
import { useModalChrome } from '../../hooks/useModalChrome';
import { motion } from 'framer-motion';
import { X, Plus, CheckCircle2, Clock, UtensilsCrossed, Trash2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import { useMeals } from '../../context/MealsContext';
import { getWorkoutColor } from '../../utils/workoutColors';
import { formatEventTime, formatDuration } from '../../utils/dateHelpers';
import { mealCalories, sumDayMacros } from '../../lib/nutrition/mapping';
import { notify } from '../../lib/notify';
import type { Meal } from '../../types/nutrition';

/** "620 kcal · P 42 / C 55 / F 24" from whichever values the meal has. */
function mealSummary(meal: Meal): string {
  const parts: string[] = [];
  const kcal = mealCalories(meal);
  if (kcal !== null) parts.push(`${kcal} kcal`);
  const macros = [
    meal.proteinG !== undefined ? `P ${meal.proteinG}` : null,
    meal.carbsG !== undefined ? `C ${meal.carbsG}` : null,
    meal.fatTotalG !== undefined ? `F ${meal.fatTotalG}` : null,
  ].filter(Boolean);
  if (macros.length) parts.push(macros.join(' / '));
  return parts.join(' · ');
}

/**
 * Day overview modal: opened by clicking a day number in the month grid.
 * Lists the day's events; selecting one swaps in the WorkoutModal (the
 * SELECT_EVENT reducer arm clears selectedDay).
 */
export default function DayModal() {
  const { state, dispatch } = useCalendar();
  const { getEventsForDate } = useSchedule();
  const { getMealsForDate, deleteMeal } = useMeals();
  const day = state.selectedDay;
  const close = () => dispatch({ type: 'CLEAR_DAY' });

  useModalChrome(close);

  if (!day) return null;

  const date = parseISO(day);
  const events = getEventsForDate(date);
  const meals = getMealsForDate(date);
  const totals = sumDayMacros(meals);

  const countText = [
    events.length > 0 ? `${events.length} workout${events.length === 1 ? '' : 's'}` : null,
    meals.length > 0 ? `${meals.length} meal${meals.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ') || 'No workouts';

  const removeMeal = async (meal: Meal) => {
    const ok = await deleteMeal(meal.id);
    notify(ok ? 'Meal deleted' : 'Failed to delete — try again');
  };

  // No AnimatePresence: AppShell unmounts this component outright on close,
  // so exit animations never ran — only the entry animation is real.
  return createPortal(
    <motion.div
        className="modal-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        onClick={close}
      >
        <motion.div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="day-modal-title"
          initial={{ opacity: 0, scale: 0.94, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          onClick={e => e.stopPropagation()}
        >
          <div className="day-modal__header">
            <div className="day-modal__header-info">
              <span className="day-modal__weekday">{format(date, 'EEEE')}</span>
              <h2 id="day-modal-title" className="day-modal__date">{format(date, 'MMMM d, yyyy')}</h2>
              <span className="day-modal__count">{countText}</span>
            </div>
            <div className="day-modal__header-actions">
              <button
                className="day-modal__add"
                onClick={() => dispatch({ type: 'OPEN_COMPOSER', payload: day })}
              >
                <Plus size={15} strokeWidth={2} /> Add event
              </button>
              <button
                className="day-modal__add day-modal__add--meal"
                onClick={() => dispatch({ type: 'OPEN_MEAL_COMPOSER', payload: day })}
              >
                <UtensilsCrossed size={15} strokeWidth={2} /> Add meal
              </button>
              <button className="modal-close" onClick={close} aria-label="Close">
                <X size={18} strokeWidth={1.5} />
              </button>
            </div>
          </div>

          <div className="day-modal__list">
            {events.length === 0 && meals.length === 0 && (
              <p className="day-modal__empty">Nothing scheduled — a rest day, or room for something new.</p>
            )}
            {events.map(event => {
              const color = getWorkoutColor(event.type);
              return (
                <button
                  key={event.id}
                  className={`day-modal__event${event.isCompleted ? ' day-modal__event--done' : ''}`}
                  style={{ borderLeft: `3px solid ${color.solid}` }}
                  onClick={() => dispatch({ type: 'SELECT_EVENT', payload: event })}
                >
                  <div className="day-modal__event-main">
                    <span className="day-modal__event-badge" style={{ background: color.solid }}>
                      {color.label}
                    </span>
                    <span className="day-modal__event-title">{event.title}</span>
                    {event.subtitle && <span className="day-modal__event-subtitle">{event.subtitle}</span>}
                  </div>
                  <div className="day-modal__event-side">
                    <span className="day-modal__event-time">
                      <Clock size={12} strokeWidth={1.5} />
                      {event.startTime ? formatEventTime(event.startTime, event.endTime) : formatDuration(event.estimatedDuration)}
                    </span>
                    {event.isCompleted && (
                      <span className="day-modal__event-check" style={{ color: color.solid }}>
                        <CheckCircle2 size={15} strokeWidth={2} />
                      </span>
                    )}
                  </div>
                </button>
              );
            })}

            {meals.length > 0 && (
              <div className="day-modal__meals">
                <div className="day-modal__macros">
                  <span className="day-modal__macros-item"><strong>{totals.calories}</strong> kcal</span>
                  <span className="day-modal__macros-item"><strong>{totals.proteinG}</strong> g protein</span>
                  <span className="day-modal__macros-item"><strong>{totals.carbsG}</strong> g carbs</span>
                  <span className="day-modal__macros-item"><strong>{totals.fatTotalG}</strong> g fat</span>
                </div>
                {meals.map(meal => (
                  <div key={meal.id} className="day-modal__meal">
                    <button
                      className="day-modal__meal-main"
                      onClick={() => dispatch({ type: 'OPEN_MEAL_EDITOR', payload: meal })}
                      aria-label={`Edit ${meal.title}`}
                    >
                      {meal.mealType && (
                        <span className="day-modal__meal-badge">{meal.mealType}</span>
                      )}
                      <span className="day-modal__meal-title">{meal.title}</span>
                      {mealSummary(meal) && (
                        <span className="day-modal__meal-macros">{mealSummary(meal)}</span>
                      )}
                    </button>
                    <div className="day-modal__meal-side">
                      {meal.time && (
                        <span className="day-modal__meal-time">
                          <Clock size={12} strokeWidth={1.5} />
                          {meal.time}
                        </span>
                      )}
                      <button
                        className="day-modal__meal-delete"
                        onClick={() => removeMeal(meal)}
                        aria-label={`Delete ${meal.title}`}
                      >
                        <Trash2 size={14} strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>,
    document.body
  );
}
