import { useEffect, useState } from 'react';

// Cycles a placeholder through example strings: first swap fires at
// periodMs + offsetMs, then every periodMs. Two instances with different
// offsets therefore stagger — they never swap on the same tick.
export function useRotatingPlaceholder(
  examples: readonly string[],
  { periodMs = 8000, offsetMs = 0 }: { periodMs?: number; offsetMs?: number } = {},
): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (examples.length < 2) return;
    const advance = () => setIndex(i => (i + 1) % examples.length);
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      advance();
      interval = setInterval(advance, periodMs);
    }, periodMs + offsetMs);
    return () => {
      clearTimeout(timeout);
      if (interval !== undefined) clearInterval(interval);
    };
  }, [examples, periodMs, offsetMs]);

  return examples[index % examples.length] ?? '';
}
