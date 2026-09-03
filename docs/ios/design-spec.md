# Native design spec

Source of truth for every value here is the web's `src/styles/tokens.css`,
`src/utils/workoutColors.ts` and `src/lib/analytics/palette.ts` — **not** `PRD.md`, whose
design section still documents the retired cold-navy palette. `ios/scripts/gen-tokens.mjs`
turns those three files into `ApexUI/Tokens.swift` and CI fails when they drift, so this
document explains the system; the generator carries the numbers.

## 1. Palette — "warm charcoal", dark only (D-010)

| Token | Hex | Role | Swift |
|---|---|---|---|
| `--bg-primary` | `#0d0c0b` | screen background | `Color.apex.bgPrimary` |
| `--bg-surface` | `#161412` | cards, sheet bodies, inputs | `.bgSurface` |
| `--bg-elevated` | `#201e1b` | nav bars, menus, toasts, chat header | `.bgElevated` |
| `--border-subtle` | `#2e2a25` | dividers, grid lines, input borders | `.borderSubtle` |
| *(untokenised)* | `#3d3530` | strong/hover border | `.borderStrong` — promote to a token |
| `--text-primary` | `#f1f5f9` | headings, values | `.textPrimary` |
| `--text-secondary` | `#a09590` | body copy, metadata | `.textSecondary` |
| `--text-muted` | `#8a7f7c` | labels, placeholders, helper text | `.textMuted` |
| `--accent-primary` | `#e8e2d9` | warm off-white: today bubble, active segment, focus ring, FAB, send button | `.accent` |
| *(untokenised)* | `#f97316` | the de-facto "done / positive" colour (completion ticks, today headings, overflow links); also `morning-routine` solid | `.positive` — promote |
| *(untokenised)* | `#ef4444` / `#f87171` / `#b91c1c` | now-line; danger text; destructive button | `.danger`, `.dangerText`, `.destructive` |
| *(untokenised)* | `#1e3a5f` bg / `#2a5080` border | user chat bubble | `.userBubble` |

Translucent chrome: top nav `rgba(20,18,16,0.92)` + blur 12; tab bar `rgba(16,14,13,0.96)` +
blur 16 + saturate 180% → use `.ultraThinMaterial` tinted with `bgElevated` for both. Modal
backdrop `rgba(0,0,0,0.72)` + blur 4 → system sheet dimming is close enough.

Attainment semantics (blocks): met `#2eb82e`, close `#f97316`, under `textMuted`.

### Workout-type colours (`src/utils/workoutColors.ts` is canonical; `tokens.css` lags it)

| Type | Label | solid | border | light (fill) | glow |
|---|---|---|---|---|---|
| `stretching` | Stretching | `#4a3f6b` | `#6d5fad` | 20% | `0 0 20px rgba(74,63,107,0.35)` |
| `morning-routine` | Morning Routine | `#f97316` | `#f97316` | 15% | `0 0 20px rgba(249,115,22,0.4)` |
| `weights` | Strength | `#8b1a1a` | `#b91c1c` | 20% | `0 0 20px rgba(139,26,26,0.5)` |
| `climbing` | Indoor Climbing | `#228b22` | `#2eb82e` | 20% | `0 0 20px rgba(34,139,34,0.45)` |
| `outdoor-climbing` | Outdoor Climbing | `#2c5f8a` | `#4a86b8` | 20% | `0 0 20px rgba(44,95,138,0.45)` |
| `cardio` | Cardio | `#2d6a4f` | `#40916c` | 20% | `0 0 20px rgba(45,106,79,0.4)` |
| `yoga` | Yoga & Mobility | `#2a7d7d` | `#2a9d8f` | 20% | `0 0 20px rgba(42,125,125,0.35)` |

Usage: the event chip / day-card left rail = `border`; chip fill = `light`; glow only on
emphasis (selected chip, PR trophy tint). Swift: `WorkoutType.palette` with `solid`, `border`,
`fill`, `glow` (shadow radius 10, opacity as above).

### Chart ramp (`src/lib/analytics/palette.ts`)
`#f97316` orange · `#38bdf8` sky · `#4ade80` green · `#facc15` yellow · `#c084fc` violet ·
`#fb7185` rose · `#2dd4bf` teal · `#a3a3a3` neutral — assigned by series position; workout-type
groups override with their `border` colour so "weights" is the same red everywhere. All clear
3:1 on `#161412` and stay distinguishable under deuteranopia.

## 2. Typography

| Role | Face | Where |
|---|---|---|
| Display / body | **Inter** 300–800 | everything |
| Numeric / label | **JetBrains Mono** 400/500 | all numbers, timers, times, KPI values, uppercase micro-labels, table cells — with `tabular-nums` |
| Wordmark | **Barlow Condensed** 700 | the `APEX` wordmark only: 1.4rem, tracking 0.22em |

All three are SIL OFL; bundle the TTFs in `ApexUI` and register via `UIAppFonts`.

Scale (web root 16px): xs 12 · sm 14 · base 16 · lg 18 · xl 20 · 2xl 24 · 3xl 30, plus
micro sizes 9–11 used for chip labels, DOW headers, ticks and badges — **on iOS clamp micro text
to 11pt minimum** and let Dynamic Type scale everything via `relativeTo:`.

Recurring patterns to port as `TextStyle`s:
- **Section eyebrow**: 10→11pt, weight 700, tracking 0.14em, uppercase, `textMuted`.
- **Field label**: mono, 12pt, uppercase, tracking 0.06em, `textMuted`.
- **Big date numeral** (day view): 42pt, weight 800, tracking −0.04em, line-height 1.
- **Sheet title**: 24pt, 700, tracking −0.02em.
- **Stat value**: 24pt, 700, tracking −0.03em, mono variant for numbers.

## 3. Spacing, radii, shadows, motion

- Spacing: no tokens on the web; the rhythm is a 4pt grid (2/4/6/8/12/16/20/24/32). Swift:
  `Spacing.xs=4, sm=8, md=12, lg=16, xl=24, xxl=32`. Screen padding 16; card padding 12–16.
- Radii: sm 4 · md 8 · lg 12 · xl 16; pills 999; circles for avatars/day bubbles/FAB. Sheets
  use the system corner radius.
- Shadows: sm `0 1 3 rgba(0,0,0,.4)` · md `0 4 16 .5` · lg `0 12 40 .6` — on a dark UI prefer
  borders and elevation colours; use shadows only for floating elements (FAB, toasts).
- Motion: ease `cubic-bezier(0.16, 1, 0.3, 1)` (≈ `.spring(response: 0.35, dampingFraction: 0.85)`),
  durations 150 / 250 / 300 ms. Web conventions: month slide `x: ±40, 0.28s`; day fade
  `y: 8, 0.18s`; modal `scale 0.94 → 1, y 10 → 0, 0.25s`; chip press `scale 1.02`; FAB rotates
  45° when its menu opens; typing indicator 1.2s bounce; chat cursor 0.9s blink. Respect
  `accessibilityReduceMotion`.

## 4. Chrome and layout

| Web | iOS |
|---|---|
| 56px top nav (avatar · wordmark · period controls · actions) | Navigation bar per tab; wordmark as the Schedule title view; period controls as a toolbar; avatar in You |
| 60px bottom nav: Calendar · FAB(+) · Coach · Analytics | 4-tab `TabView` (Schedule · Coach · Analytics · You); the FAB becomes a toolbar "+" on Schedule with a menu (Workout / Meal) |
| 300px chat sidebar | the Coach tab |
| z-index ladder (modal 100 → tracker 110 → summary 120 → overlays 130 → editors 140 → toasts 200) | presentation policy: sheets for detail/composer/builder, `fullScreenCover` for the tracker, summary as an overlay inside the tracker cover, toasts in a top-level `ZStack` above the tab bar |
| Content max-widths (tracker 640, forms 720, profile 520) | `readableContentGuide`-style max width on iPad; full width on iPhone |
| Safe-area: only 5 places use `env(safe-area-inset-bottom)` and `viewport-fit=cover` is missing | free with SwiftUI; keep bottom bars above the home indicator |

## 5. Component map (web CSS primitive → `ApexUI`)

| Web | ApexUI |
|---|---|
| `.btn-library`, `.btn-today` (32px secondary) | `ApexButton(.secondary)` — 44pt min hit area, 32pt visual |
| accent CTAs (`.chat-key-setup-btn`, `.day-modal__add`) | `ApexButton(.primary)` (accent fill, dark text) |
| `.view-toggle`, `.range-toggle`, `.auth-toggle` | `ApexSegmented` (accent pill on elevated track) |
| `.an-chip`, `.builder-type-chip`, `.library-filter`, `.modal-tag` | `Chip(selected:)`, `TypeChip(workoutType:)` |
| `.modal-backdrop` + `.modal` | `.sheet` with `.presentationDetents([.medium, .large])`, `.presentationDragIndicator(.visible)`, `SheetHeader(title:, close:)` |
| `.library-view` etc. full-screen overlays | pushed screens in a `NavigationStack` |
| `.tracker-confirm` sticky bar | `ConfirmBar(message:, primary:, secondary:)` in `safeAreaInset(edge: .bottom)` |
| `.toasts` | `ToastHost` above the tab bar; `ToastBus.post` |
| `.library-field` + `__input` | `ApexField(label:, text:, keyboard:)` — mono label, surface fill, 44pt |
| `.tile-card__menu` kebab | `Menu` with `contextMenu` on the tile |
| `.block-bar__track/__fill`, `.type-bar-row__track` | `AttainmentBar(value:, target:, state:)` |
| `.event-chip`, `.day-event-card` | `EventChip` (month), `EventCard` (day) with a 3pt left rail in the type's `border` colour and a 44pt completion control |
| `.day-strip` (7 cells, dots) | `WeekStrip` — a horizontally paging 7-day strip with up to 3 type dots |
| Avatar picker (24 SVGs, 34/64px) | `AvatarView(key:, size:)` from `Avatars.xcassets` |

## 6. Iconography

Web uses lucide at `strokeWidth 1.5` (2 for emphasis), sizes 12–16 in content, 18 actions, 22
tabs. iOS: SF Symbols with `.weight(.light)` for the 1.5 feel; map the 53 lucide icons
(`Calendar→calendar`, `Dumbbell→dumbbell`, `Trophy→trophy`, `Flame→flame`, `Mountain→mountain.2`,
`HeartPulse→heart`, `Watch→applewatch`, `Sparkles→sparkles`, `Repeat2→arrow.2.squarepath`,
`GripVertical→line.3.horizontal`, `Send→arrow.up.circle.fill`, `Square→stop.fill`, …). Where no
symbol fits (e.g. `Flower2`, `MountainSnow`), bundle the lucide SVG as a template image. Keep the
mapping in `ApexUI/Icons.swift` so a session can find it.

## 7. Charts

Follow `TileRenderer.tsx`: no axis lines, no tick lines, no grid, no animation; ticks 10→11pt
`textMuted`; line width 1.5, points only when ≤ 60; area fill opacity 0.18; legend only when
>1 series (7pt dots, 10→11pt text); `—` for null; ≥1000 rounded with separators, else one
decimal trimmed. Tooltip → a `chartOverlay` scrubber showing a `bgElevated` card with per-series
dots. FIT stream charts (HR, elevation, route): 96pt tall, dashed grid `2 3`, crosshair readout,
drag-to-scrub.

## 8. App icon brief (D-019)

- Ground: `#0d0c0b` → subtle radial lift toward `#161412` at the top-left.
- Mark: a single angular summit / "A" chevron in `#e8e2d9` (the accent), with one thin
  `#f97316` accent line (the "done" orange) — echoing the `og.png` rule above the title. No
  gradients on the mark, no text.
- Deliverables: `ios/Design/app-icon.svg` (1024 master), exported PNG set in
  `Apex/Assets.xcassets/AppIcon.appiconset` (1024 single-size is enough for Xcode 15+), a
  monochrome variant for tinted Home Screens, and a 48px favicon export to offer the web later.
- Avoid: purple/cyan (the current placeholder), photographic dumbbells, more than two colours.

## 9. Haptics and sound

`.impact(.light)` on set logged; `.notification(.success)` on PR and workout completed;
`.selection` on chip and segment changes; `.impact(.medium)` on action confirmed. No sounds.
