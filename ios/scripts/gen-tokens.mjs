#!/usr/bin/env node
// Generates ApexUI/Generated/Tokens.swift from the web's design sources.
//
// The brand has one definition (docs/ios/design-spec.md): src/styles/tokens.css,
// src/utils/workoutColors.ts and src/lib/analytics/palette.ts. Copying hexes into
// Swift by hand is how two clients drift apart, so this is the only writer of
// Tokens.swift and `--check` runs in scripts/ci-guards.sh.
//
//   node ios/scripts/gen-tokens.mjs           write
//   node ios/scripts/gen-tokens.mjs --check   fail if the committed file is stale
//
// Deliberately dependency-free: it must run in a worktree created with
// `git-new.sh --no-install`, before `npm ci`.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'ios/Packages/ApexKit/Sources/ApexUI/Generated/Tokens.swift');
const CSS = join(ROOT, 'src/styles/tokens.css');
const WORKOUT = join(ROOT, 'src/utils/workoutColors.ts');
const PALETTE = join(ROOT, 'src/lib/analytics/palette.ts');

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

// ── 1. tokens.css — regex over the :root block ──────────────────────────────
// Note `--text-secondary:#a09590;` has no space after the colon.
const css = readFileSync(CSS, 'utf8');
const rootAt = css.indexOf(':root');
if (rootAt === -1) fail(`no :root block in ${CSS}`);
const vars = new Map(
  [...css.slice(rootAt).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
);

const need = (name) => {
  const v = vars.get(name);
  if (v === undefined) fail(`--${name} is missing from src/styles/tokens.css`);
  return v;
};
const hex = (name) => {
  const v = need(name);
  const m = /^#([0-9a-fA-F]{6})$/.exec(v);
  if (!m) fail(`--${name} is "${v}", expected a 6-digit hex`);
  return m[1].toUpperCase();
};
const px = (name) => {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(need(name));
  if (!m) fail(`--${name} is not a px value`);
  return Number(m[1]);
};
const ms = (name) => {
  const m = /^(\d+(?:\.\d+)?)ms$/.exec(need(name));
  if (!m) fail(`--${name} is not a ms value`);
  return Number(m[1]) / 1000;
};
// Web root font-size is 16px (design-spec §2); rem → pt one-to-one at that root.
const rem = (name) => {
  const m = /^(\d+(?:\.\d+)?)rem$/.exec(need(name));
  if (!m) fail(`--${name} is not a rem value`);
  return Number(m[1]) * 16;
};

// ── 2. workoutColors.ts — dynamic import ────────────────────────────────────
// Node strips the types natively; its only import is `import type`, which is
// erased at load, so the module loads with no build step.
let WORKOUT_COLORS;
try {
  ({ WORKOUT_COLORS } = await import(pathToFileURL(WORKOUT).href));
} catch (e) {
  fail(`could not import ${WORKOUT}: ${e.message}`);
}
if (!WORKOUT_COLORS) fail(`${WORKOUT} no longer exports WORKOUT_COLORS`);

// ── 3. palette.ts — textual extraction ──────────────────────────────────────
// SERIES_RAMP is not exported, and the module cannot be imported by node anyway
// (it has an extensionless relative import). Parsed as text on purpose.
const pal = readFileSync(PALETTE, 'utf8');
const rampBlock = /const SERIES_RAMP\s*=\s*\[([\s\S]*?)\]\s*as const;/.exec(pal);
if (!rampBlock) {
  fail(
    `SERIES_RAMP literal not found in ${PALETTE}. It is parsed textually because it is not ` +
      `exported. If it moved or changed shape, update ios/scripts/gen-tokens.mjs.`,
  );
}
const ramp = [...rampBlock[1].matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1].slice(1).toUpperCase());
if (ramp.length !== 8) fail(`SERIES_RAMP has ${ramp.length} colours, expected 8`);

// ── Cross-check the two workout-colour sources ──────────────────────────────
// tokens.css lags workoutColors.ts (design-spec §1). Where both define a type
// they must agree; where only one does, record it in the generated header so
// the divergence is reviewed rather than silently tolerated.
const CSS_KEY = { 'morning-routine': 'morning' }; // the CSS calls it --color-morning-*
const cssTypes = new Set(
  [...vars.keys()].map((k) => /^color-(.+)-solid$/.exec(k)?.[1]).filter(Boolean),
);
const divergence = [];
for (const [type, cfg] of Object.entries(WORKOUT_COLORS)) {
  const key = CSS_KEY[type] ?? type;
  if (!cssTypes.has(key)) {
    divergence.push(`  workoutColors.ts only: ${type}`);
    continue;
  }
  for (const field of ['solid', 'light', 'glow', 'border']) {
    const web = vars.get(`color-${key}-${field}`);
    const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
    if (norm(web) !== norm(cfg[field])) {
      fail(
        `workout colour drift for "${type}".${field}: tokens.css has "${web}", ` +
          `workoutColors.ts has "${cfg[field]}". workoutColors.ts is canonical — fix tokens.css.`,
      );
    }
  }
}
for (const key of cssTypes) {
  const type = Object.keys(CSS_KEY).find((t) => CSS_KEY[t] === key) ?? key;
  if (!(type in WORKOUT_COLORS)) divergence.push(`  tokens.css only: ${key}`);
}

// ── Emit ────────────────────────────────────────────────────────────────────
const rgba = (s, what) => {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(s.trim());
  if (!m) fail(`${what} is "${s}", expected rgba(r, g, b, a)`);
  const h = [m[1], m[2], m[3]]
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return { hex: h, alpha: Number(m[4]) };
};
// "0 0 20px rgba(74, 63, 107, 0.35)" — CSS blur 20 reads as SwiftUI shadow radius 10.
const glowOf = (s, what) => {
  const m = /^0 0 (\d+)px (rgba\([^)]*\))$/.exec(s.trim());
  if (!m) fail(`${what} is "${s}", expected "0 0 <n>px rgba(...)"`);
  const { hex: h, alpha } = rgba(m[2], what);
  return { hex: h, radius: Number(m[1]) / 2, alpha };
};
const swiftKey = (t) => t.replace(/-(\w)/g, (_, c) => c.toUpperCase());

const palettes = Object.entries(WORKOUT_COLORS).map(([type, cfg]) => {
  const light = rgba(cfg.light, `${type}.light`);
  const glow = glowOf(cfg.glow, `${type}.glow`);
  return { type, key: swiftKey(type), cfg, light, glow };
});

const header = [
  '// GENERATED by ios/scripts/gen-tokens.mjs — do not edit.',
  '//',
  '// Sources: src/styles/tokens.css, src/utils/workoutColors.ts,',
  '// src/lib/analytics/palette.ts. Regenerate with `node ios/scripts/gen-tokens.mjs`;',
  '// `npm run ci:guards` fails when this file and the web drift apart.',
  ...(divergence.length
    ? ['//', '// Source divergence at generation time (workoutColors.ts is canonical):', ...divergence.map((d) => `//${d}`)]
    : []),
].join('\n');

const out = `${header}

import SwiftUI

/// The warm-charcoal palette (design-spec §1). Dark only (D-010).
public enum ApexColor {
    public static let bgPrimary = Color(hex: 0x${hex('bg-primary')})
    public static let bgSurface = Color(hex: 0x${hex('bg-surface')})
    public static let bgElevated = Color(hex: 0x${hex('bg-elevated')})
    public static let borderSubtle = Color(hex: 0x${hex('border-subtle')})
    public static let textPrimary = Color(hex: 0x${hex('text-primary')})
    public static let textSecondary = Color(hex: 0x${hex('text-secondary')})
    public static let textMuted = Color(hex: 0x${hex('text-muted')})
    public static let accent = Color(hex: 0x${hex('accent-primary')})
}

/// One workout type's colours. \`fill\` and \`glow\` carry their own opacity, so
/// they are applied directly rather than composed at the call site.
public struct WorkoutPalette: Sendable, Hashable {
    public let label: String
    public let solid: Color
    public let border: Color
    public let fill: Color
    public let glow: Color
    public let glowRadius: CGFloat

    public init(label: String, solid: Color, border: Color, fill: Color, glow: Color, glowRadius: CGFloat) {
        self.label = label
        self.solid = solid
        self.border = border
        self.fill = fill
        self.glow = glow
        self.glowRadius = glowRadius
    }
}

public enum WorkoutTypeTokens {
${palettes
  .map(
    (p) => `    public static let ${p.key} = WorkoutPalette(
        label: "${p.cfg.label}",
        solid: Color(hex: 0x${p.cfg.solid.slice(1).toUpperCase()}),
        border: Color(hex: 0x${p.cfg.border.slice(1).toUpperCase()}),
        fill: Color(hex: 0x${p.light.hex}).opacity(${p.light.alpha}),
        glow: Color(hex: 0x${p.glow.hex}).opacity(${p.glow.alpha}),
        glowRadius: ${p.glow.radius}
    )`,
  )
  .join('\n\n')}

    /// Keyed by the same strings the API uses for \`workout_type\`.
    public static let byRawValue: [String: WorkoutPalette] = [
${palettes.map((p) => `        "${p.type}": ${p.key},`).join('\n')}
    ]
}

/// Analytics series ramp, assigned by series position (src/lib/analytics/palette.ts).
public enum ChartPalette {
    public static let seriesRamp: [Color] = [
${ramp.map((h) => `        Color(hex: 0x${h}),`).join('\n')}
    ]
}

public enum Radius {
    public static let sm: CGFloat = ${px('radius-sm')}
    public static let md: CGFloat = ${px('radius-md')}
    public static let lg: CGFloat = ${px('radius-lg')}
    public static let xl: CGFloat = ${px('radius-xl')}
    /// Pills and circles.
    public static let full: CGFloat = 999
}

/// Durations in seconds. The web's ease \`cubic-bezier(0.16, 1, 0.3, 1)\` reads as
/// \`.spring(response: 0.35, dampingFraction: 0.85)\` (design-spec §3).
public enum Motion {
    public static let fast: Double = ${ms('duration-fast')}
    public static let base: Double = ${ms('duration-base')}
    public static let slow: Double = ${ms('duration-slow')}
    public static let spring = Animation.spring(response: 0.35, dampingFraction: 0.85)
}

/// Base sizes in points. Views pass these to \`Font.apex(_:size:relativeTo:)\` so
/// Dynamic Type still scales them.
public enum TypeScale {
    public static let xs: CGFloat = ${rem('text-xs')}
    public static let sm: CGFloat = ${rem('text-sm')}
    public static let base: CGFloat = ${rem('text-base')}
    public static let lg: CGFloat = ${rem('text-lg')}
    public static let xl: CGFloat = ${rem('text-xl')}
    public static let xxl: CGFloat = ${rem('text-2xl')}
    public static let xxxl: CGFloat = ${rem('text-3xl')}
    /// Micro text is clamped to 11pt on iOS (design-spec §2).
    public static let micro: CGFloat = 11
}
`;

if (process.argv.includes('--check')) {
  const tmp = join(tmpdir(), `apex-tokens-${process.pid}.swift`);
  writeFileSync(tmp, out);
  const r = spawnSync('diff', ['-u', OUT, tmp], { stdio: 'inherit' });
  rmSync(tmp, { force: true });
  if (r.status !== 0) {
    console.error(
      `::error::ios/Packages/ApexKit/Sources/ApexUI/Generated/Tokens.swift is stale — a design ` +
        `token changed on the web without regenerating the iOS tokens.`,
    );
    console.error(`       Run 'node ios/scripts/gen-tokens.mjs' and commit the result.`);
    process.exit(1);
  }
  console.log('ok: Tokens.swift matches the web design sources');
} else {
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}`);
}
