import { describe, it, expect } from 'vitest';
import { COACH_MODEL } from '../../src/lib/coach/model';
import { DEFAULT_MODEL, MODEL_CONFIGS, PRODUCTION_MODEL, modelConfig } from '../src/models';

// The eval arm tracks production (PRODUCTION_MODEL === COACH_MODEL), but
// pricing cannot be derived from an id — it has to be looked up. These guard
// the seam between the two.

describe('MODEL_CONFIGS', () => {
  it('prices the production arm', () => {
    expect(PRODUCTION_MODEL).toBe(COACH_MODEL);
    // A production bump onto an unpriced id fails loudly here rather than
    // silently reporting the wrong cost.
    expect(() => modelConfig(PRODUCTION_MODEL)).not.toThrow();
    expect(modelConfig(PRODUCTION_MODEL).id).toBe(COACH_MODEL);
  });

  it('keeps every configured model on its own pricing', () => {
    // Regression guard: a computed [COACH_MODEL] key would collapse these two
    // entries the moment the coach moved down a tier, stamping Opus pricing
    // onto Sonnet with no type or runtime error.
    const ids = Object.keys(MODEL_CONFIGS);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const [key, config] of Object.entries(MODEL_CONFIGS)) {
      expect(config.id).toBe(key);
    }
    expect(modelConfig(DEFAULT_MODEL)).toEqual({
      id: 'claude-sonnet-5', inputPerMTok: 3, outputPerMTok: 15,
    });
  });

  it('names the missing pricing when a model is unknown', () => {
    expect(() => modelConfig('claude-not-real')).toThrow(/add its \$\/MTok pricing/);
  });
});
