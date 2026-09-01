import { describe, it, expect } from 'vitest';
import {
  COACH_MODELS,
  DEFAULT_COACH_MODEL,
  defaultCoachModel,
  isCoachModelId,
  priceLabel,
  resolveCoachModel,
} from '../models';
import { COACH_MODEL, COACH_MODEL_DISPLAY } from '../model';

describe('coach model catalog', () => {
  it('has a unique id for every entry', () => {
    const ids = COACH_MODELS.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('contains the default, so defaultCoachModel() can never throw', () => {
    expect(COACH_MODELS.map(m => m.id)).toContain(DEFAULT_COACH_MODEL);
    expect(defaultCoachModel().id).toBe(DEFAULT_COACH_MODEL);
  });

  it('prices every entry — the picker sells the saving, so a zero is a bug', () => {
    for (const model of COACH_MODELS) {
      expect(model.inputPerMTok).toBeGreaterThan(0);
      expect(model.outputPerMTok).toBeGreaterThan(0);
      expect(model.label).not.toBe('');
      expect(model.badge).not.toBe('');
      expect(model.blurb).not.toBe('');
    }
  });

  it('keeps model.ts in step with the catalog', () => {
    expect(COACH_MODEL).toBe(DEFAULT_COACH_MODEL);
    expect(COACH_MODEL_DISPLAY).toBe(defaultCoachModel().badge);
  });

  it('omits thinking only where the model predates adaptive thinking', () => {
    // Guards the one request-shape difference that fails at the API and
    // nowhere else: adaptive thinking 400s on pre-4.6 models.
    const haiku = COACH_MODELS.find(m => m.id === 'claude-haiku-4-5-20251001');
    expect(haiku?.params).toEqual({});
    for (const model of COACH_MODELS.filter(m => m.id !== 'claude-haiku-4-5-20251001')) {
      expect(model.params.thinking).toEqual({ type: 'adaptive' });
    }
  });
});

describe('resolveCoachModel', () => {
  it('resolves every catalog id to itself', () => {
    for (const model of COACH_MODELS) {
      expect(resolveCoachModel(model.id)).toBe(model);
    }
  });

  it('falls back to the default for a null column (user never chose)', () => {
    expect(resolveCoachModel(null).id).toBe(DEFAULT_COACH_MODEL);
    expect(resolveCoachModel(undefined).id).toBe(DEFAULT_COACH_MODEL);
  });

  it('falls back rather than throwing on a retired or forged id', () => {
    // This is what makes dropping a model from the catalog safe while users
    // still have it saved in profiles.coach_model.
    for (const bad of ['claude-opus-4-1', 'gpt-4o', '', 0, 42, {}, []]) {
      expect(resolveCoachModel(bad).id).toBe(DEFAULT_COACH_MODEL);
    }
  });
});

describe('isCoachModelId', () => {
  it('accepts catalog ids and rejects everything else', () => {
    expect(isCoachModelId(DEFAULT_COACH_MODEL)).toBe(true);
    for (const bad of [null, undefined, '', 'claude-opus-4-1', 7, {}]) {
      expect(isCoachModelId(bad)).toBe(false);
    }
  });
});

describe('priceLabel', () => {
  it('renders the $/MTok pair shown in the picker', () => {
    expect(priceLabel({ ...defaultCoachModel(), inputPerMTok: 3, outputPerMTok: 15 }))
      .toBe('$3/$15 per Mtok');
  });
});
