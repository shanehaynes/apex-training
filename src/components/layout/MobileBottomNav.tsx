import { CalendarDays, BarChart2 } from 'lucide-react';

export type MobileTab = 'calendar' | 'analytics';

interface Props {
  activeTab: MobileTab;
  onChange: (tab: MobileTab) => void;
}

export default function MobileBottomNav({ activeTab, onChange }: Props) {
  return (
    <nav className="mobile-nav" aria-label="Main navigation">
      <button
        className={`mobile-nav__tab${activeTab === 'calendar' ? ' mobile-nav__tab--active' : ''}`}
        onClick={() => onChange('calendar')}
        aria-selected={activeTab === 'calendar'}
      >
        <CalendarDays size={22} strokeWidth={1.5} />
        <span>Calendar</span>
      </button>
      <button
        className={`mobile-nav__tab${activeTab === 'analytics' ? ' mobile-nav__tab--active' : ''}`}
        onClick={() => onChange('analytics')}
        aria-selected={activeTab === 'analytics'}
      >
        <BarChart2 size={22} strokeWidth={1.5} />
        <span>Analytics</span>
      </button>
    </nav>
  );
}
