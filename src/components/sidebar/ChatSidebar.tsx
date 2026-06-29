import { useRef, useState, useMemo, useEffect } from 'react';
import { format, parseISO, startOfWeek, endOfWeek, subWeeks, isWithinInterval } from 'date-fns';
import { useSchedule } from '../../context/ScheduleContext';
import type { CreateEventInput, UpdateEventInput } from '../../context/ScheduleContext';
import { useChat } from '../../hooks/useChat';
import type { WorkoutType } from '../../types/workout';
import { Send, Square, NotebookPen, Check, X } from 'lucide-react';

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  todayEvents: ReturnType<ReturnType<typeof useSchedule>['getEventsForDate']>,
  allEvents: ReturnType<typeof useSchedule>['events'],
  today: Date,
): string {
  const dayName = format(today, 'EEEE, MMMM d, yyyy');

  // Include IDs so Claude can reference them in tool calls
  const todayStr = todayEvents.length === 0
    ? 'No workouts scheduled.'
    : todayEvents.map(e => {
        const time = e.startTime ? ` at ${e.startTime}` : '';
        const done = e.isCompleted ? ' ✓' : '';
        return `• [${e.id}] ${e.title} (${e.estimatedDuration} min)${time}${done}`;
      }).join('\n');

  const weekStart = startOfWeek(today, { weekStartsOn: 1 });
  const weekEnd   = endOfWeek(today,   { weekStartsOn: 1 });
  const thisWeek  = allEvents.filter(e => {
    const d = parseISO(e.date);
    return isWithinInterval(d, { start: weekStart, end: weekEnd });
  });

  const weekStr = thisWeek.length === 0
    ? 'No workouts this week.'
    : thisWeek.map(e => {
        const dayLabel = format(parseISO(e.date), 'EEE MMM d');
        const done = e.isCompleted ? '✓' : '○';
        return `${done} [${e.id}] ${dayLabel} — ${e.title} (${e.estimatedDuration} min)`;
      }).join('\n');

  const pastEvents: typeof allEvents = [];
  for (let i = 1; i <= 4; i++) {
    const ref = subWeeks(today, i);
    const s  = startOfWeek(ref, { weekStartsOn: 1 });
    const en = endOfWeek(ref,   { weekStartsOn: 1 });
    pastEvents.push(...allEvents.filter(e => {
      const d = parseISO(e.date);
      return isWithinInterval(d, { start: s, end: en });
    }));
  }
  const completedPast  = pastEvents.filter(e => e.isCompleted).length;
  const completionRate = pastEvents.length > 0
    ? Math.round((completedPast / pastEvents.length) * 100)
    : 0;

  return `You are a terse, high-signal fitness coach in the user's training app. You have live schedule access and can create, update, or delete events via tools.

Today: ${dayName}

TODAY (IDs in brackets):
${todayStr}

THIS WEEK (IDs in brackets):
${weekStr}

LAST 4 WEEKS: ${completedPast}/${pastEvents.length} completed (${completionRate}%)

STYLE:
- Maximum information per word. No filler, no affirmations, no "Great question!", no restating what the user said.
- Skip pleasantries. Lead with the answer or the action.
- Numbers and specifics over vague encouragement.
- Short sentences. Fragments fine.
- Daily briefing: 2–3 tight sentences max.
- Use tools with the exact bracketed IDs. For recurring events (IDs with "__"): confirm scope (one instance vs. full series) before calling delete_event.`;
}

// ─── Confirmation card ────────────────────────────────────────────────────────

interface ConfirmCardProps {
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled: boolean;
}

function ConfirmCard({ label, onConfirm, onCancel, disabled }: ConfirmCardProps) {
  return (
    <div className="chat-confirm-card">
      <p className="chat-confirm-card__label">{label}</p>
      <div className="chat-confirm-card__actions">
        <button
          className="chat-confirm-card__btn chat-confirm-card__btn--cancel"
          onClick={onCancel}
          disabled={disabled}
        >
          <X size={12} /> Cancel
        </button>
        <button
          className="chat-confirm-card__btn chat-confirm-card__btn--confirm"
          onClick={onConfirm}
          disabled={disabled}
        >
          <Check size={12} /> Confirm
        </button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ChatSidebar() {
  const { events, getEventsForDate, createEvent, updateEvent, deleteEvent, deleteEventInstance } = useSchedule();
  const {
    messages, isLoading, streamingContent,
    pendingAction, sendMessage, confirmAction, cancelAction, triggerInitial, abort,
  } = useChat();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const today = useMemo(() => new Date(), []);
  const todayEvents = useMemo(() => getEventsForDate(today), [getEventsForDate, today]);
  const systemPrompt = useMemo(
    () => buildSystemPrompt(todayEvents, events, today),
    [todayEvents, events, today],
  );

  const isEmpty = messages.length === 0 && !isLoading && !pendingAction;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent, pendingAction]);

  // ── Mutation executor (called on Confirm) ──────────────────────────────────

  const buildExecutor = () => async (): Promise<string> => {
    if (!pendingAction) return 'No action.';
    const { toolName, input: toolInput } = pendingAction;

    if (toolName === 'delete_event') {
      const { event_id, scope, date } = toolInput as {
        event_id: string; scope: 'instance' | 'all'; date?: string;
      };
      // Recurring instances have synthetic IDs like `base__date`; the base ID is before `__`
      const baseId = event_id.includes('__') ? event_id.split('__')[0] : event_id;

      if (scope === 'instance' && date) {
        const ok = await deleteEventInstance(baseId, date);
        return ok ? 'Deleted that instance successfully.' : 'Failed to delete the instance.';
      } else {
        const ok = await deleteEvent(event_id);
        return ok ? 'Deleted the event successfully.' : 'Failed to delete the event.';
      }
    }

    if (toolName === 'create_event') {
      const { type, title, date, estimated_duration, start_time, difficulty, description, location, tags, equipment } =
        toolInput as {
          type: WorkoutType; title: string; date: string; estimated_duration: number;
          start_time?: string; difficulty?: number; description?: string;
          location?: string; tags?: string[]; equipment?: string[];
        };
      const input: CreateEventInput = {
        type, title, date,
        estimatedDuration: estimated_duration,
        startTime:   start_time,
        difficulty:  difficulty as 1 | 2 | 3 | 4 | 5 | undefined,
        description, location, tags, equipment,
      };
      const result = await createEvent(input);
      return result ? `Created "${title}" on ${date}.` : 'Failed to create the event.';
    }

    if (toolName === 'update_event') {
      const { event_id, changes } = toolInput as {
        event_id: string;
        changes: {
          title?: string; date?: string; start_time?: string; end_time?: string;
          estimated_duration?: number; description?: string; location?: string; difficulty?: number;
        };
      };
      const fields: UpdateEventInput['fields'] = {
        ...(changes.title              !== undefined && { title: changes.title }),
        ...(changes.date               !== undefined && { date: changes.date }),
        ...(changes.start_time         !== undefined && { startTime: changes.start_time }),
        ...(changes.end_time           !== undefined && { endTime: changes.end_time }),
        ...(changes.estimated_duration !== undefined && { estimatedDuration: changes.estimated_duration }),
        ...(changes.description        !== undefined && { description: changes.description }),
        ...(changes.location           !== undefined && { location: changes.location }),
        ...(changes.difficulty         !== undefined && { difficulty: changes.difficulty as 1|2|3|4|5 }),
      };
      const ok = await updateEvent({ id: event_id, fields });
      return ok ? 'Updated the event successfully.' : 'Failed to update the event.';
    }

    return 'Unknown action.';
  };

  // ── Input handlers ─────────────────────────────────────────────────────────

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading || pendingAction) return;
    setInput('');
    sendMessage(text, systemPrompt);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isStreaming = isLoading && streamingContent;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar__header">
        <span className="chat-sidebar__title">Coach</span>
        <span className="chat-sidebar__model">claude opus</span>
      </div>

      <div className="chat-sidebar__messages">
        {isEmpty && (
          <div className="chat-empty">
            <p className="chat-empty__hint">Ask anything, or get your daily briefing below.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg chat-msg--${msg.role}`}>
            <p className="chat-msg__text">{msg.content}</p>
          </div>
        ))}

        {isStreaming && (
          <div className="chat-msg chat-msg--assistant">
            <p className="chat-msg__text">{streamingContent}<span className="chat-cursor" /></p>
          </div>
        )}

        {isLoading && !streamingContent && (
          <div className="chat-msg chat-msg--assistant">
            <span className="chat-typing"><span /><span /><span /></span>
          </div>
        )}

        {pendingAction && (
          <ConfirmCard
            label={pendingAction.displayLabel}
            disabled={isLoading}
            onConfirm={() => confirmAction(buildExecutor(), systemPrompt)}
            onCancel={() => cancelAction(systemPrompt)}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-sidebar__actions">
        <button
          className="chat-notes-btn"
          onClick={() => triggerInitial(systemPrompt)}
          disabled={isLoading || !!pendingAction}
        >
          <NotebookPen size={13} />
          Coach's Notes
        </button>
      </div>

      <div className="chat-sidebar__input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={pendingAction ? 'Confirm or cancel above first…' : 'Ask your coach…'}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={isLoading || !!pendingAction}
        />
        <button
          className="chat-send-btn"
          onClick={isLoading ? abort : handleSend}
          disabled={!!pendingAction && !isLoading}
          aria-label={isLoading ? 'Stop' : 'Send'}
        >
          {isLoading ? <Square size={14} /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}
