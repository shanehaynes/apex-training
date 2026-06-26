# Apex Training — Product Requirements Document

**Version:** 1.0  
**Date:** 2026-06-25  
**Status:** Draft  

---

## 1. Product Overview

### 1.1 Vision

Apex Training is a premium personal workout scheduling and tracking web application. It presents an athlete's training week in a visually rich calendar interface — beautiful enough to demo to potential employers, functional enough to use daily. The visual language draws from the environments athletes train in: the deep navy of night skies during evening stretching, the warm glow of a sunrise morning routine, the blood intensity of a heavy lifting session, the cool granite of a climbing wall.

### 1.2 Guiding Principles

- **Visually elite.** Every pixel should look like it belongs on a design portfolio. No component is an afterthought.
- **Data-first.** The workout data model is rich and forward-compatible. The MVP reads from static data; the schema anticipates a future backend.
- **Performance.** Animations are purposeful and buttery. No jank, no layout shift.
- **Employer-legible.** A non-technical viewer looking at this site for 30 seconds should feel impressed by its craft.

### 1.3 MVP Scope

The MVP delivers one core user value: **see what workouts are coming up and understand exactly what each one involves.**

Out of scope for MVP (but designed-for in data model): completing/logging workouts, user authentication, backend persistence, social features.

---

## 2. Design System

### 2.1 Color Palette

#### Workout Type Colors
These colors are the heart of the visual identity. They are used for calendar event chips, modal accents, sidebar labels, and chart fills.

| Workout Type        | Color Name      | Hex       | Usage |
|---------------------|-----------------|-----------|-------|
| Nightly Stretches   | Midnight Navy   | `#0f2744` | Deep, calm, restorative |
| Morning Routine     | Sunrise Orange  | `#f97316` | Energetic gradient anchor |
| Weights / Strength  | Blood Red       | `#8b1a1a` | Intense, powerful |
| Climbing            | Granite Grey    | `#5c5c5c` | Textured, earthy |
| Cardio / Running    | Trail Green     | `#2d6a4f` | Outdoors, endurance |
| Yoga / Mobility     | Slate Teal      | `#2a7d7d` | Fluid, balanced |
| Rest Day            | Dusk Purple     | `#4a3f6b` | Recovery, low-key |

Each workout type also has a `light` variant (10% opacity fill for calendar chip backgrounds) and a `glow` variant (used for hover/focus states with box-shadow).

#### Application Palette
| Token                | Value      | Role |
|----------------------|------------|------|
| `--bg-primary`       | `#0a0e17`  | Page background |
| `--bg-surface`       | `#111827`  | Cards, modal backdrop content |
| `--bg-elevated`      | `#1a2236`  | Sidebar, calendar header |
| `--border-subtle`    | `#1f2d45`  | Grid lines, dividers |
| `--text-primary`     | `#f1f5f9`  | Headings, primary labels |
| `--text-secondary`   | `#94a3b8`  | Dates, metadata |
| `--text-muted`       | `#475569`  | Placeholder, helper text |
| `--accent-primary`   | `#3b82f6`  | Links, focus rings, CTA |

The application is dark-mode only for the MVP. The dark background makes the saturated workout-type colors vibrate with energy.

### 2.2 Typography

**Font stack:**
- **Display / Headings:** `Inter` (variable font, weights 300–800)
- **Monospace / Stats:** `JetBrains Mono` (for numbers in analytics — looks technical and intentional)
- **System fallback:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`

**Type Scale (rem, base 16px):**
| Token        | Size  | Weight | Usage |
|--------------|-------|--------|-------|
| `--text-xs`  | 0.75  | 400    | Labels, tags |
| `--text-sm`  | 0.875 | 400/500| Calendar chips, meta |
| `--text-base`| 1.0   | 400    | Body |
| `--text-lg`  | 1.125 | 500    | Subheadings |
| `--text-xl`  | 1.25  | 600    | Section headers |
| `--text-2xl` | 1.5   | 700    | Modal title, page title |
| `--text-3xl` | 1.875 | 800    | Hero stat numbers |

### 2.3 Spacing & Layout

- Base unit: `4px`
- Grid: 12-column CSS Grid on the outer shell
- Calendar occupies 9 columns; sidebar occupies 3 columns
- On tablet (< 1024px): sidebar collapses to a drawer triggered by a button
- On mobile (< 768px): calendar switches to a vertical list/agenda view

### 2.4 Motion & Animation

All animations use `cubic-bezier(0.16, 1, 0.3, 1)` (an ease-out spring) unless otherwise specified.

| Interaction             | Animation | Duration |
|-------------------------|-----------|----------|
| Calendar event hover    | Scale 1.02 + glow shadow | 150ms |
| Modal open              | Scale from 0.95 + fade in | 250ms |
| Modal close             | Scale to 0.97 + fade out | 180ms |
| Sidebar stat count      | Number count-up on mount | 800ms |
| Month transition        | Slide left/right + crossfade | 300ms |
| Day cell hover          | Background fill | 100ms |

Use `prefers-reduced-motion` media query to disable all transitions for accessibility.

### 2.5 Iconography

Use `lucide-react` icon set throughout. Icons are always `20px` in UI elements, `24px` in modal headers. Stroke width: 1.5px. Never fill icons — strokes only for the athletic, precise aesthetic.

### 2.6 Shadows & Depth

```
--shadow-sm:  0 1px 3px rgba(0,0,0,0.4);
--shadow-md:  0 4px 16px rgba(0,0,0,0.5);
--shadow-lg:  0 12px 40px rgba(0,0,0,0.6);
--shadow-glow-red:    0 0 20px rgba(139,26,26,0.4);
--shadow-glow-orange: 0 0 20px rgba(249,115,22,0.4);
--shadow-glow-navy:   0 0 20px rgba(15,39,68,0.5);
```

---

## 3. Data Model

### 3.1 Workout Type Enum

```typescript
type WorkoutType =
  | 'stretching'       // Nightly stretches
  | 'morning-routine'  // Morning routine
  | 'weights'          // Strength / lifting
  | 'climbing'         // Rock climbing
  | 'cardio'           // Running, cycling, rowing
  | 'yoga'             // Yoga / mobility
  | 'rest';            // Active rest / recovery day
```

### 3.2 Exercise

```typescript
interface Exercise {
  id: string;
  name: string;
  category: 'strength' | 'stretch' | 'cardio' | 'skill' | 'mobility';
  sets?: number;
  reps?: string;         // e.g. "8-12" or "AMRAP"
  duration?: string;     // e.g. "45s", "3 min"
  weight?: string;       // e.g. "BW", "135 lbs", "60% 1RM"
  restPeriod?: string;   // e.g. "90s"
  notes?: string;        // Coaching cues, form notes
  imageUrl?: string;     // Demonstration photo or illustration
  videoUrl?: string;     // Future: embedded demo video
  muscleGroups?: string[];
}
```

### 3.3 Workout Event

```typescript
interface WorkoutEvent {
  id: string;
  type: WorkoutType;
  title: string;                    // e.g. "Upper Body Strength"
  subtitle?: string;                // e.g. "Push Focus — Chest & Shoulders"
  date: string;                     // ISO 8601 date: "2026-06-25"
  startTime?: string;               // "06:30"
  endTime?: string;                 // "07:45"
  estimatedDuration: number;        // minutes
  description: string;              // Markdown-compatible prose description
  warmup?: Exercise[];
  exercises: Exercise[];
  cooldown?: Exercise[];
  difficulty: 1 | 2 | 3 | 4 | 5;  // 1=easy, 5=maximal
  location?: string;                // "Garage Gym", "Movement Lab", "Red Rock Canyon"
  coverImageUrl?: string;           // Hero image for modal header
  tags: string[];                   // e.g. ["upper body", "hypertrophy", "push"]
  equipment?: string[];             // e.g. ["barbell", "bench", "dumbbells"]
  isCompleted: boolean;             // false for MVP; toggled in tracking phase
  completedAt?: string;             // ISO timestamp, set when marked complete
  notes?: string;                   // Post-workout notes (future)
  isRecurring: boolean;
  recurringPattern?: {
    frequency: 'daily' | 'weekly' | 'custom';
    daysOfWeek?: number[];           // 0=Sun, 6=Sat
    endDate?: string;
  };
}
```

### 3.4 Schedule

```typescript
interface Schedule {
  version: string;
  lastUpdated: string;
  events: WorkoutEvent[];
}
```

### 3.5 Static Data File

For the MVP, all data lives in `src/data/schedule.json` conforming to the `Schedule` interface. This file contains at minimum 4 weeks of forward-looking workout events covering all workout types, so all calendar views are populated and all analytics have meaningful numbers.

The data file should contain a realistic, real training week for an athlete who climbs, lifts, does morning mobility, and stretches nightly — because this will be viewed by employers and should feel authentic, not placeholder.

---

## 4. Application Architecture

### 4.1 Tech Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Framework | React 18 + TypeScript | Industry standard, strong ecosystem, portfolio-appropriate |
| Build tool | Vite | Fast dev server, clean config |
| Styling | Tailwind CSS v3 + CSS custom properties | Utility classes for layout, CSS vars for the design token system |
| Animation | Framer Motion | Best-in-class React animation, declarative |
| Date handling | date-fns | Lightweight, tree-shakeable, no moment.js |
| Charts | Recharts | React-native charts, customizable to design system |
| Icons | lucide-react | Clean stroke icons, consistent style |
| State | React Context + useReducer | Appropriate scale for MVP; no Redux overhead |
| Fonts | Google Fonts (Inter + JetBrains Mono) | Self-hosted via Vite for performance |

### 4.2 Directory Structure

```
apex-training/
├── public/
│   ├── images/
│   │   └── workouts/           # Workout exercise photos
│   └── favicon.svg
├── src/
│   ├── components/
│   │   ├── calendar/
│   │   │   ├── Calendar.tsx         # Root calendar shell
│   │   │   ├── CalendarHeader.tsx   # Month/week/day toggle + nav arrows
│   │   │   ├── MonthView.tsx        # 5-6 week grid
│   │   │   ├── WeekView.tsx         # 7-column time grid
│   │   │   ├── DayCell.tsx          # Single day in month view
│   │   │   ├── EventChip.tsx        # Colored event pill on calendar
│   │   │   └── TimeSlot.tsx         # Hour row in week view
│   │   ├── modal/
│   │   │   ├── WorkoutModal.tsx     # Animated overlay container
│   │   │   ├── ModalHeader.tsx      # Cover image + title + type badge
│   │   │   ├── ExerciseCard.tsx     # Individual exercise with optional image
│   │   │   └── DifficultyRating.tsx # Visual 1-5 difficulty indicator
│   │   ├── sidebar/
│   │   │   ├── Sidebar.tsx          # Container + scroll
│   │   │   ├── StatCard.tsx         # Single metric card
│   │   │   ├── WorkoutTypeChart.tsx # Donut chart by type
│   │   │   ├── WeeklyVolumeChart.tsx# Bar chart: sessions per week
│   │   │   └── DateRangeFilter.tsx  # This week / this month / all time toggle
│   │   ├── layout/
│   │   │   ├── AppShell.tsx         # Outer grid: calendar + sidebar
│   │   │   ├── TopNav.tsx           # App name + today button + view toggle
│   │   │   └── MobileSidebarDrawer.tsx
│   │   └── ui/
│   │       ├── Badge.tsx            # Workout type badge/tag
│   │       ├── Button.tsx
│   │       ├── Tag.tsx
│   │       └── Tooltip.tsx
│   ├── context/
│   │   ├── CalendarContext.tsx      # currentDate, selectedView, selectedEvent
│   │   └── ScheduleContext.tsx      # events data, filtering helpers
│   ├── data/
│   │   └── schedule.json           # Static workout data
│   ├── hooks/
│   │   ├── useCalendar.ts          # Calendar navigation logic
│   │   ├── useWorkoutEvents.ts     # Filter/query events by date range
│   │   └── useAnimatedNumber.ts    # Count-up animation for stats
│   ├── types/
│   │   └── workout.ts              # All TypeScript interfaces
│   ├── utils/
│   │   ├── workoutColors.ts        # Type → color/style mappings
│   │   ├── dateHelpers.ts          # Build calendar grid, format dates
│   │   └── analytics.ts            # Compute sidebar stats from event array
│   ├── styles/
│   │   ├── tokens.css              # CSS custom properties (design tokens)
│   │   └── global.css              # Reset, base styles, font imports
│   ├── App.tsx
│   └── main.tsx
├── index.html
├── tailwind.config.ts
├── tsconfig.json
└── vite.config.ts
```

---

## 5. Feature Specifications

---

### Chunk A: Design System & Project Scaffold

**Deliverable:** A running Vite + React + TypeScript project with all dependencies installed, design tokens defined, global styles applied, and the outer AppShell layout rendering with correct proportions.

#### A.1 Vite Project Initialization
- `npm create vite@latest apex-training -- --template react-ts`
- Install: `tailwindcss`, `framer-motion`, `date-fns`, `recharts`, `lucide-react`
- Configure Tailwind to extend with design token colors and font families

#### A.2 CSS Design Tokens (`tokens.css`)
- Define all CSS custom properties listed in Section 2.1 and 2.6
- Define workout-type color map as CSS variables: `--color-stretching`, `--color-weights`, etc.
- Import Inter and JetBrains Mono from Google Fonts

#### A.3 Global Styles (`global.css`)
- CSS reset (box-sizing, margin reset)
- `body` background: `var(--bg-primary)`
- Custom scrollbar styling (thin, dark, matching surface color)
- Focus ring: `var(--accent-primary)` 2px outline
- Selection color

#### A.4 AppShell Layout (`AppShell.tsx`)
```
┌─────────────────────────────────────────────────────────────────┐
│  TopNav (full width, ~56px tall, sticky)                        │
├─────────────────────────────────────────────┬───────────────────┤
│                                             │                   │
│  Calendar (flex-1, scrollable vertically)   │  Sidebar (320px)  │
│                                             │  sticky, overflow │
│                                             │  -y: auto         │
│                                             │                   │
└─────────────────────────────────────────────┴───────────────────┘
```
- CSS Grid: `grid-template-columns: 1fr 320px`
- TopNav: app name "APEX" in tracking letter-spacing, "Today" button, view switcher (Month / Week)
- Sidebar: fixed width, `overflow-y: auto`, subtle left border

#### A.5 Tailwind Configuration
Extend Tailwind config with:
- Custom colors mapped to CSS vars (so Tailwind utilities can reference tokens)
- Custom font families: `display: ['Inter', ...]`, `mono: ['JetBrains Mono', ...]`
- Custom animation keyframes for the modal entrance

---

### Chunk B: Data Layer

**Deliverable:** TypeScript types, static schedule data, and utility functions. No UI — this is the data foundation everything else consumes.

#### B.1 Types (`src/types/workout.ts`)
Define all interfaces from Section 3 exactly as specified.

#### B.2 Static Schedule Data (`src/data/schedule.json`)
Populate with **6 weeks of events** starting from the current week. Must include:
- At least 3 instances of each workout type
- Realistic exercise lists per workout type:
  - **Weights (Upper Body):** Bench Press, Overhead Press, Pull-ups, Barbell Row, Tricep Dips, Face Pulls
  - **Weights (Lower Body):** Back Squat, Romanian Deadlift, Bulgarian Split Squat, Leg Press, Calf Raises
  - **Climbing:** Warm-up traversing, 5.10 routes × 3, 5.11 project attempts, finger strength hangboard, cool-down
  - **Morning Routine:** Sun salutations, hip openers, thoracic rotations, neck rolls, box breathing
  - **Nightly Stretches:** Hamstring stretch, pigeon pose, chest opener, shoulder cross-body, spinal twist
  - **Cardio:** Zone 2 run with pace/distance targets
- Each event has: title, subtitle, date, time, duration, description, difficulty, tags, equipment
- Recurring events (e.g., nightly stretches every day at 9:30pm) generated out for 6 weeks

#### B.3 Color Utilities (`src/utils/workoutColors.ts`)
```typescript
const WORKOUT_COLORS: Record<WorkoutType, {
  bg: string;           // Solid hex for chips
  bgLight: string;      // 15% opacity version for chip background
  border: string;       // Border color for modal
  glow: string;         // Box shadow glow string
  label: string;        // Human-readable label
}> = { ... }

export function getWorkoutStyle(type: WorkoutType) { ... }
```

#### B.4 Date Helpers (`src/utils/dateHelpers.ts`)
- `buildMonthGrid(year, month)` → returns 5-6 week array of date arrays for calendar rendering
- `buildWeekDays(date)` → returns 7 dates for week view
- `isSameDay(a, b)`, `isToday(date)`, `isPast(date)`, `isCurrentMonth(date, month)`
- `formatEventTime(startTime, endTime)` → "6:30 – 7:45 AM"
- `formatDuration(minutes)` → "1h 15m"

#### B.5 Analytics Utilities (`src/utils/analytics.ts`)
```typescript
function getEventsByDateRange(events: WorkoutEvent[], range: DateRange): WorkoutEvent[]
function countByType(events: WorkoutEvent[]): Record<WorkoutType, number>
function getWeeklyVolume(events: WorkoutEvent[], weeksBack: number): WeekVolume[]
function getTotalDuration(events: WorkoutEvent[]): number
function getLongestStreak(events: WorkoutEvent[]): number  // future: needs isCompleted
```

#### B.6 Schedule Context (`src/context/ScheduleContext.tsx`)
- Loads and provides `schedule.json` data
- Exposes: `events`, `getEventsForDate(date)`, `getEventsForRange(start, end)`

---

### Chunk C: Calendar — Month View

**Deliverable:** A fully functional, visually polished month-view calendar displaying workout events as color-coded chips.

#### C.1 CalendarContext (`src/context/CalendarContext.tsx`)
State:
- `currentDate: Date` — the month/week currently in view
- `selectedView: 'month' | 'week'`
- `selectedEvent: WorkoutEvent | null`
- `hoveredDate: string | null`

Actions: `NEXT_PERIOD`, `PREV_PERIOD`, `GO_TO_TODAY`, `SET_VIEW`, `SELECT_EVENT`, `CLEAR_EVENT`

#### C.2 CalendarHeader (`CalendarHeader.tsx`)
Layout:
```
← [Month Year] →          [Month] [Week]
```
- Left arrow: previous month
- Right arrow: next month
- "Month Year" text: e.g., "June 2026" — `--text-2xl`, bold
- View toggle: pill-style button group, active state highlighted with `--accent-primary`
- Animate month label: when changing months, text slides up/fades out then new text slides up/fades in

#### C.3 Day-of-Week Headers
```
Sun  Mon  Tue  Wed  Thu  Fri  Sat
```
- `--text-xs`, `--text-muted`, letter-spacing: 0.1em, uppercase
- Sticky below calendar header during scroll

#### C.4 DayCell (`DayCell.tsx`)
Each cell in the 7-column grid:
- Date number: top-right, `--text-sm`
  - Today: filled circle background using `--accent-primary`, white text
  - Current month: `--text-primary`
  - Adjacent month: `--text-muted`
  - Past dates: 60% opacity
- Minimum height: 120px (month view)
- Max 3 event chips visible; if more, show "+N more" link in `--accent-primary`
- Hover: subtle background fill `--bg-elevated`
- Cell border: `1px solid var(--border-subtle)`

#### C.5 EventChip (`EventChip.tsx`)
The workout event pill displayed on the calendar:
```
[● Title text              ]
```
- Height: 22px, border-radius: 4px
- Background: `bgLight` color (15% opacity solid color)
- Left border: 3px solid `bg` color (full saturation)
- Text: workout title, `--text-xs`, single line, overflow ellipsis
- Colored dot: 6px circle, `bg` color, left of text
- Hover: scale 1.02, glow shadow, cursor pointer
- Shows time if `startTime` is defined: "6:30 AM · Upper Body"

#### C.6 Month Transition Animation
When navigating months:
- Current grid slides out left (next) or right (prev) while fading
- New grid slides in from opposite direction
- Duration: 300ms, easing: ease-out
- Implement with Framer Motion `AnimatePresence` + `motion.div`

---

### Chunk D: Workout Detail Modal

**Deliverable:** A polished, information-rich overlay that appears when a calendar event chip is clicked. This is the showcase piece of the UI.

#### D.1 Modal Architecture
- Rendered via React Portal (`document.body`) so it sits above everything
- Backdrop: `rgba(0,0,0,0.7)` with `backdrop-filter: blur(4px)`
- Modal container: max-width 680px, `max-height: 85vh`, `overflow-y: auto`
- Centered with `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%)`
- Close on: backdrop click, Escape key, close button
- Trap focus inside modal while open (accessibility)

#### D.2 Entrance/Exit Animation
```
Enter: opacity 0→1, scale 0.94→1, translateY 8px→0, duration 250ms
Exit:  opacity 1→0, scale 1→0.97, duration 180ms
```
Use Framer Motion `AnimatePresence`.

#### D.3 ModalHeader (`ModalHeader.tsx`)
When `coverImageUrl` is present:
```
┌──────────────────────────────────────────────────┐
│                                                  │
│   [Cover image, 240px tall, object-fit: cover]  │
│   Gradient overlay: transparent → bg-surface    │
│                                                  │
│   [TYPE BADGE]                                   │
│   Workout Title                                  │
│   Subtitle · Duration · Difficulty ●●●○○         │
└──────────────────────────────────────────────────┘
```
When no `coverImageUrl`:
```
┌──────────────────────────────────────────────────┐
│  [Colored left border, 4px, workout type color]  │
│  [TYPE BADGE]    [Close ×]                       │
│  Workout Title                                    │
│  Subtitle · Duration · Difficulty ●●●○○          │
└──────────────────────────────────────────────────┘
```

Type badge: pill with workout type color background, type label in small caps.
Difficulty rating: 5 filled/empty circles in workout type color.

#### D.4 Modal Metadata Strip
```
📅 Thursday, June 25    ⏱ 6:30 – 7:45 AM    📍 Garage Gym
```
- Icon + text pairs, separated by vertical dividers
- Icons: `lucide-react` Calendar, Clock, MapPin
- `--text-sm`, `--text-secondary`

#### D.5 Description Section
- Rendered as styled prose
- `--text-base`, `--text-secondary`, line-height 1.7
- Subtle top border: `1px solid var(--border-subtle)`

#### D.6 Exercise Sections
Three sections if data present: **Warm-up**, **Main Work**, **Cool-down**

Section header style:
```
──── WARM-UP ────
```
Small caps, `--text-muted`, with lines on either side.

#### D.7 ExerciseCard (`ExerciseCard.tsx`)
```
┌──────────────────────────────────────────────────────┐
│  [Image 80×80, border-radius 8px]  Exercise Name     │
│   (if imageUrl)                    3 × 8-12 reps     │
│                                    Rest: 90s          │
│                                    135 lbs            │
│                                    Notes text here... │
└──────────────────────────────────────────────────────┘
```
- Image: if present, shown left; if absent, layout adjusts (text full-width)
- Exercise name: `--text-base`, `--text-primary`, semi-bold
- Sets × reps / duration: `--text-sm`, workout type color
- Weight: `--text-sm`, `--text-secondary`
- Notes: `--text-sm`, `--text-muted`, italic
- Muscle groups: small tags below
- Subtle bottom border between cards

#### D.8 Tags Footer
```
Tags: [upper body] [push] [hypertrophy] [barbell]
```
Small pill tags in `--bg-elevated` with `--text-muted` text.

---

### Chunk E: Week View

**Deliverable:** A time-grid week view as an alternative to month view, toggled from the calendar header.

#### E.1 Layout
```
         Sun    Mon    Tue    Wed    Thu    Fri    Sat
 6 AM  |       |      |      |      |      |      |
 7 AM  |       |  ██  |      |      |  ██  |      |
 8 AM  |       |  ██  |      |      |  ██  |      |
       ...
 9 PM  |  ██   |      |      |  ██  |      |      |  ██
10 PM  |  ██   |      |      |  ██  |      |      |  ██
```
- Left column: hour labels, `--text-xs`, `--text-muted`
- Hour rows: `48px` tall
- Events placed absolutely within their time column based on start/end time
- Event block width: 90% of column, centered
- Today column: subtle background tint `rgba(59,130,246,0.05)`

#### E.2 Event Block (Week View)
```
┌──────────────┐
│  Upper Body  │
│  6:30 AM     │
│  1h 15m      │
└──────────────┘
```
- Background: `bgLight` with left border in type color
- Height proportional to duration (48px per hour)
- Minimum height: 28px (short events truncate text)
- Hover: glow shadow, scale 1.01

#### E.3 Week Navigation
Same prev/next pattern as month view. Header shows:
```
← June 22 – June 28, 2026 →
```

#### E.4 Current Time Indicator
A horizontal red line at the current time position in today's column:
- `2px solid #ef4444`
- Small circle on left edge (8px)
- Updates every minute via `setInterval`

---

### Chunk F: Analytics Sidebar

**Deliverable:** A persistent right-panel that shows at-a-glance training analytics. Responds to the date range filter.

#### F.1 Sidebar Header
```
ANALYTICS
[This Week ▾] [This Month] [All Time]
```
- "ANALYTICS": `--text-xs`, letter-spacing 0.15em, `--text-muted`, uppercase
- Date range: pill toggle group (same style as view switcher)

#### F.2 StatCards (`StatCard.tsx`)
Four cards in a 2×2 grid:

| Card | Label | Value display |
|------|-------|---------------|
| Total Sessions | "Sessions" | Large number, count-up animation |
| Total Time | "Hours Trained" | e.g. "14.5", monospace font |
| Most Active Day | "Peak Day" | e.g. "Thursday" |
| Workout Types | "Types" | e.g. "5 of 7" |

Each card:
- `--bg-elevated`, border-radius 12px, `padding: 16px`
- Label: `--text-xs`, `--text-muted`, uppercase
- Value: `--text-3xl`, `JetBrains Mono`, `--text-primary`
- Subtle colored left-border (accent blue)
- Subtle hover lift: `translateY(-2px)`, shadow increase

#### F.3 Workout Type Breakdown (`WorkoutTypeChart.tsx`)
A horizontal stacked bar or set of labeled progress bars — one per workout type:

```
Weights      ████████░░░░  4 sessions
Climbing     ██████░░░░░░  3 sessions
Morning      ████████████  6 sessions
Stretching   ████████████  7 sessions
Cardio       ████░░░░░░░░  2 sessions
```

- Each bar uses the workout type's color
- Bar fills animate from 0 to final width on mount and on date range change
- Sessions count right-aligned in `--text-sm`, `--text-secondary`
- Type label left-aligned with colored dot

#### F.4 Weekly Volume Chart (`WeeklyVolumeChart.tsx`)
Mini bar chart: last 6 weeks, x-axis = week label ("Jun 1", "Jun 8"...), y-axis = number of sessions.

- Implemented with Recharts `BarChart`
- Bar color: `--accent-primary`
- Custom tooltip: dark surface, shows week range + session count
- No axis lines, no grid lines — clean minimal look
- Axes use `--text-muted` color

#### F.5 Upcoming This Week
Below analytics, a compact list of upcoming events for the current week:

```
TODAY
  ● 9:30 PM  Nightly Stretches        25 min

TOMORROW
  ● 6:30 AM  Upper Body Strength      75 min

THURSDAY
  ● 7:00 AM  Morning Routine          30 min
  ● 6:00 PM  Climbing Session         120 min
```

- Clicking any item opens the workout modal
- Events in the past are dimmed (opacity 0.5)
- "TODAY" label highlighted in `--accent-primary`

---

### Chunk G: TopNav & Polish

**Deliverable:** Final navigation bar, responsive behavior, accessibility, and final visual polish pass.

#### G.1 TopNav (`TopNav.tsx`)
```
APEX  ·  Training         [Today]     [Month] [Week]        [●] Live
```
- "APEX": bold, letter-spacing 0.2em, gradient text (workout orange to blood red)
- "Training": `--text-muted`, regular weight
- "Today" button: navigates to current date, outlined style
- View toggle: pill group
- Live indicator: pulsing green dot if current week has events (decorative)
- `height: 56px`, `background: var(--bg-elevated)`, `border-bottom: 1px solid var(--border-subtle)`
- `backdrop-filter: blur(12px)` with slight transparency for depth

#### G.2 Responsive Behavior

**Tablet (768px – 1024px):**
- Sidebar hidden, replaced by floating button: "📊 Stats"
- Tapping button opens sidebar as a bottom-sheet drawer
- Calendar expands to full width

**Mobile (< 768px):**
- Month view hidden; replaced by an agenda/list view: chronological list of upcoming events
- TopNav collapses to just "APEX" + hamburger menu
- Modal: full-screen instead of centered overlay

#### G.3 Accessibility
- All interactive elements: keyboard navigable, visible focus rings
- Modal: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on title
- Calendar grid: `role="grid"`, day cells `role="gridcell"`
- Event chips: `role="button"`, `aria-label` with full workout name and date
- Color is never the sole conveyor of information (type label always present alongside color)
- `prefers-reduced-motion`: disable all transitions and animations

#### G.4 Performance
- `schedule.json` loaded once, memoized in context
- Calendar grid memoized with `useMemo`, only recomputes on month change
- Event chips use `React.memo`
- Images: `loading="lazy"`, explicit `width` and `height` to prevent layout shift
- Fonts: `font-display: swap` in `@font-face`

#### G.5 Visual Polish Checklist
- [ ] Empty day cells look intentional, not broken — faint "+" on hover
- [ ] Loading state: skeleton shimmer on first paint
- [ ] No orphaned scrollbars — custom scrollbar on sidebar and modal
- [ ] All transitions feel physical and consistent
- [ ] Typography scale is harmonious at all sizes
- [ ] Color contrast meets WCAG AA for all text

---

## 6. Hosting & Deployment

### 6.1 Platform: Vercel

Apex Training is a fully static SPA (no server-side logic in the MVP). **Vercel** is the deployment target.

Rationale:
- Zero-config support for Vite — detects the framework and sets build command (`vite build`) and output dir (`dist`) automatically
- Free tier is sufficient for the full MVP and beyond
- Automatic **preview deployments** on every GitHub branch/PR — a meaningful signal to technical employers reviewing the repo
- Global CDN edge network — fast load times worldwide
- Custom domain support at no cost

### 6.2 Repository & CI/CD Pipeline

```
GitHub (shanehaynes/apex-training)
        │
        ├── push to main  →  Vercel Production Deployment
        │                    URL: apex-training.vercel.app (or custom domain)
        │
        └── push to branch →  Vercel Preview Deployment
                               URL: apex-training-git-<branch>.vercel.app
```

- Connect the GitHub repo to Vercel via the Vercel dashboard (one-time OAuth)
- Every `git push` to `main` triggers an automatic production deploy
- No manual deploy steps after initial setup

### 6.3 Vercel Configuration (`vercel.json`)

Required to handle SPA client-side routing (prevents 404 on direct URL access):

```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

This file lives at the project root and is committed to the repo.

### 6.4 Vite Build Configuration (`vite.config.ts`)

```typescript
export default defineConfig({
  plugins: [react()],
  base: '/',   // '/' for Vercel (custom domain or .vercel.app)
  build: {
    outDir: 'dist',
    sourcemap: false,   // disable in prod; enable for debugging
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'framer-motion'],
          charts: ['recharts'],
        }
      }
    }
  }
})
```

Manual chunk splitting keeps the initial bundle lean — vendor libs cached separately from app code.

### 6.5 Custom Domain (Optional but Recommended)

If a personal domain is available, configure a subdomain such as:

```
apex.shanehaynes.com   →  Vercel project
```

Set up via Vercel dashboard → Domains → Add. Vercel provisions SSL automatically. A custom domain on a portfolio project is a stronger employer signal than a `.vercel.app` URL.

### 6.6 Environment Variables

No environment variables are required for the MVP (all data is static JSON bundled at build time). This section exists as a placeholder for when a backend is introduced (e.g., `VITE_SUPABASE_URL`). Vercel's dashboard provides a UI for managing env vars per environment (preview vs. production).

### 6.7 Performance Targets (Vercel Analytics)

Enable Vercel Web Analytics (free, one-click) to track real-world performance. Target metrics:

| Metric | Target |
|--------|--------|
| First Contentful Paint | < 1.0s |
| Largest Contentful Paint | < 2.0s |
| Time to Interactive | < 2.5s |
| Lighthouse Performance | ≥ 95 |

With a static JSON data file and code-split vendor chunks, these are achievable on a Vite build with no additional optimization.

### 6.8 Deployment Chunk (Added to Implementation Order)

Deployment setup is handled as **Chunk H** — done last, after all features are complete. It requires:
1. Create GitHub repo `shanehaynes/apex-training`
2. Push codebase
3. Connect repo to Vercel (dashboard, one-time)
4. Add `vercel.json` to project root
5. Verify production URL loads correctly
6. (Optional) Configure custom domain

---

## 7. Implementation Order & Chunk Summary

| Chunk | Name | Depends On | Est. Complexity |
|-------|------|-----------|-----------------|
| A | Design System & Scaffold | — | Low |
| B | Data Layer | A | Medium |
| C | Calendar Month View | A, B | High |
| D | Workout Detail Modal | A, B | High |
| E | Week View | A, B, C | Medium |
| F | Analytics Sidebar | A, B | Medium |
| G | TopNav & Polish | All | Low–Medium |
| H | Hosting & Deployment | All | Low |

Each chunk should be completable and visually reviewable before the next begins. After Chunk D, the product is already demo-able. Chunk H is the final step — the site goes live.

---

## 8. Future Roadmap (Post-MVP)

These are explicitly out of scope but designed-for in the data model:

- **Workout Completion Tracking:** Mark workouts done, log actual weights/reps
- **Progress Photos:** Attach photos to a date
- **Authentication:** Supabase or Firebase for cloud persistence
- **Data Entry UI:** Admin panel or form to add/edit workouts without touching JSON
- **Notifications:** Browser push notifications for upcoming workouts
- **Export:** PDF weekly schedule, shareable link
- **Dark/Light Mode Toggle**
- **Integration:** Apple Health / Google Fit sync

---

## 9. Open Questions

1. Should the "Today" button on TopNav flash/pulse if today has upcoming workouts?
2. Should past events that are `isCompleted: false` in MVP show a subtle "not logged" indicator, or keep the UI clean?
3. What is the athlete's actual current training split? The data file should mirror reality as closely as possible for authenticity.

---

*This document is the single source of truth for the Apex Training MVP. All implementation decisions not covered here should default to the guiding principles in Section 1.2.*
