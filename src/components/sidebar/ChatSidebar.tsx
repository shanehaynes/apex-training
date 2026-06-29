import { useRef, useState, useMemo, useEffect } from 'react';
import { format, parseISO, startOfWeek, endOfWeek, subWeeks, isWithinInterval } from 'date-fns';
import { useSchedule } from '../../context/ScheduleContext';
import { useChat } from '../../hooks/useChat';
import { Send, Square, NotebookPen } from 'lucide-react';

function buildSystemPrompt(
  todayEvents: ReturnType<ReturnType<typeof useSchedule>['getEventsForDate']>,
  allEvents: ReturnType<typeof useSchedule>['events'],
  today: Date,
): string {
  const dayName = format(today, 'EEEE, MMMM d, yyyy');

  const todayStr = todayEvents.length === 0
    ? 'No workouts scheduled.'
    : todayEvents.map(e => {
        const time = e.startTime ? ` at ${e.startTime}` : '';
        const done = e.isCompleted ? ' ✓ completed' : '';
        return `• ${e.title} (${e.estimatedDuration} min)${time}${done}`;
      }).join('\n');

  const weekStart = startOfWeek(today, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(today, { weekStartsOn: 1 });
  const thisWeek = allEvents.filter(e => {
    const d = parseISO(e.date);
    return isWithinInterval(d, { start: weekStart, end: weekEnd });
  });

  const weekStr = thisWeek.length === 0
    ? 'No workouts this week.'
    : thisWeek.map(e => {
        const dayLabel = format(parseISO(e.date), 'EEE');
        const done = e.isCompleted ? '✓' : '○';
        return `${done} ${dayLabel} — ${e.title} (${e.estimatedDuration} min)`;
      }).join('\n');

  const pastEvents: typeof allEvents = [];
  for (let i = 1; i <= 4; i++) {
    const ref = subWeeks(today, i);
    const s = startOfWeek(ref, { weekStartsOn: 1 });
    const en = endOfWeek(ref, { weekStartsOn: 1 });
    pastEvents.push(...allEvents.filter(e => {
      const d = parseISO(e.date);
      return isWithinInterval(d, { start: s, end: en });
    }));
  }
  const completedPast = pastEvents.filter(e => e.isCompleted).length;
  const completionRate = pastEvents.length > 0
    ? Math.round((completedPast / pastEvents.length) * 100)
    : 0;

  return `You are a personal fitness coach embedded in the user's training app called Apex Training. You have real-time access to their workout schedule and completion data.

Today is ${dayName}.

TODAY'S WORKOUTS:
${todayStr}

THIS WEEK'S SCHEDULE:
${weekStr}

RECENT PERFORMANCE (last 4 weeks):
• ${completedPast} of ${pastEvents.length} workouts completed (${completionRate}% completion rate)

Your role:
- Give concise, coaching-style responses — conversational, warm, and motivating
- When giving the daily briefing, keep it to 2-3 short paragraphs — no bullet lists, just natural speech
- You can reference their schedule, completion data, and training patterns
- Be direct. Don't pad responses with filler
- For quick questions, give quick answers`;
}

export default function ChatSidebar() {
  const { events, getEventsForDate } = useSchedule();
  const { messages, isLoading, streamingContent, sendMessage, triggerInitial, abort } = useChat();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const today = useMemo(() => new Date(), []);
  const todayEvents = useMemo(() => getEventsForDate(today), [getEventsForDate, today]);
  const systemPrompt = useMemo(
    () => buildSystemPrompt(todayEvents, events, today),
    [todayEvents, events, today],
  );

  const isEmpty = messages.length === 0 && !isLoading;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading) return;
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
            <span className="chat-typing">
              <span /><span /><span />
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-sidebar__actions">
        <button
          className="chat-notes-btn"
          onClick={() => triggerInitial(systemPrompt)}
          disabled={isLoading}
        >
          <NotebookPen size={13} />
          Coach's Notes
        </button>
      </div>

      <div className="chat-sidebar__input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder="Ask your coach…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={isLoading}
        />
        <button
          className="chat-send-btn"
          onClick={isLoading ? abort : handleSend}
          aria-label={isLoading ? 'Stop' : 'Send'}
        >
          {isLoading ? <Square size={14} /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}
