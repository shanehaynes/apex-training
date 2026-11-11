// QuarterPrTicker's clock, apart from the component so it can be tested
// without a DOM.

/** How long each field stays readable, and each fade out or in. */
export const DWELL_MS = 4000;
export const FADE_MS = 500;

/** Where the line is: which field, and whether it is showing or faded out. */
export interface TickerState {
  index: number;
  shown: boolean;
}

/** How long the line stays in `state` before tickerAdvance moves it on: a
 *  shown field fades in first, so it waits out the fade and then DWELL_MS. */
export function tickerDelay(state: TickerState): number {
  return state.shown ? FADE_MS + DWELL_MS : FADE_MS;
}

/** A showing field fades out; a faded one gives way to the next field, fading in. */
export function tickerAdvance(state: TickerState, count: number): TickerState {
  return state.shown
    ? { index: state.index, shown: false }
    : { index: (state.index + 1) % count, shown: true };
}
