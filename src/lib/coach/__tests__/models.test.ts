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
  it('pins effort to high exactly where the model defaults to medium', () => {
    // Opus 5.5 and Haiku 5.5 default to `medium`; every other entry runs at
    // its own default, `high`, the level the coach is tuned at.
    const pinned = COACH_MODELS.filter(m => m.params.output_config).map(m => m.id);
    expect(pinned).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    for (const id of pinned) {
      expect(COACH_MODELS.find(m => m.id === id)?.params.output_config).toEqual({ effort: 'high' });
    }
  });

  it('prices the long-prompt rate only where the model charges one, above its base rate', () => {
    const tiered = COACH_MODELS.filter(m => m.longPrompt);
    expect(tiered.map(m => m.id)).toEqual(['claude-haiku-5-5']);
    for (const model of tiered) {
      expect(model.longPrompt!.overTokens).toBeGreaterThan(0);
      expect(model.longPrompt!.inputPerMTok).toBeGreaterThan(model.inputPerMTok);
      expect(model.longPrompt!.outputPerMTok).toBeGreaterThan(model.outputPerMTok);
    }
  });

  it('claims mid-turn system messages only where a live call has confirmed them', () => {
    // A wrong `true` is a 400 on every chat turn, so the flag is opt-in per
    // model. Opus 5.5 — the default — Sonnet 5.5 and Haiku 5.5 stay false
    // until a live call verifies them; Sonnet 5 and Haiku 4.5 reject the role.
    const byId = Object.fromEntries(COACH_MODELS.map(m => [m.id, m.midTurnSystem]));
    expect(byId).toEqual({
      'claude-opus-5-5': false,
      'claude-opus-5': true,
      'claude-opus-4-8': true,
      'claude-sonnet-5-5': false,
      'claude-sonnet-5': false,
      'claude-haiku-5-5': false,
      'claude-haiku-4-5-20251001': false,
    });
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

  it('shows the long-prompt rate beside the base rate', () => {
    const haiku55 = COACH_MODELS.find(m => m.id === 'claude-haiku-5-5')!;
    expect(priceLabel(haiku55)).toBe('$0.1/$0.5 per Mtok, $0.5/$2.5 over 100K-token prompts');
  });
});
