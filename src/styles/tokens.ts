/**
 * The computed value of a tokens.css custom property, read from :root when
 * called. Recharts writes SVG presentation attributes and wants a concrete
 * colour string, so chart marks and tick labels read the token through here
 * instead of carrying a pasted hex that drifts the next time the palette
 * moves. Falls back to `currentColor` — the ink, never a stale value — when
 * there is no stylesheet to read (tests, or before styles apply).
 */
export function cssToken(name: `--${string}`): string {
  if (typeof document === 'undefined') return 'currentColor';
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || 'currentColor';
}
