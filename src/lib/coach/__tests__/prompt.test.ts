import { describe, it, expect } from 'vitest';
import { athleteSection, buildSystemPrompt } from '../prompt';

const TODAY = new Date(2026, 6, 16); // Thu Jul 16 2026

describe('athleteSection', () => {
  it('is empty when both fields are empty, undefined, or whitespace', () => {
    expect(athleteSection()).toBe('');
    expect(athleteSection('', '')).toBe('');
    expect(athleteSection('   ', '\n')).toBe('');
    expect(athleteSection(null, null)).toBe('');
  });

  it('renders goal only', () => {
    const s = athleteSection('Climb 5.13a');
    expect(s).toContain('ABOUT THE ATHLETE:');
    expect(s).toContain('Goal: Climb 5.13a');
    expect(s).not.toContain('Context:');
  });

  it('renders context only', () => {
    const s = athleteSection(undefined, 'I am a sprinter with shin splints');
    expect(s).toContain('Context: I am a sprinter with shin splints');
    expect(s).not.toContain('Goal:');
  });

  it('renders both, trimmed', () => {
    const s = athleteSection('  Summit Everest ', ' Lower back pain history ');
    expect(s).toContain('Goal: Summit Everest');
    expect(s).toContain('Context: Lower back pain history');
    expect(s).toContain('Tailor programming');
  });
});

describe('buildSystemPrompt — athlete section', () => {
  it('omits the section when no athlete info is given', () => {
    const prompt = buildSystemPrompt([], [], TODAY);
    expect(prompt).not.toContain('ABOUT THE ATHLETE');
  });

  it('omits the section when athlete fields are empty strings', () => {
    const prompt = buildSystemPrompt([], [], TODAY, [], { goal: '', context: '  ' });
    expect(prompt).not.toContain('ABOUT THE ATHLETE');
  });

  it('includes the section before the schedule context', () => {
    const prompt = buildSystemPrompt([], [], TODAY, [], {
      goal: 'Run a sub-3-hour marathon',
      context: 'I am 54 with a history of lower back pain',
    });
    expect(prompt).toContain('Goal: Run a sub-3-hour marathon');
    expect(prompt).toContain('Context: I am 54 with a history of lower back pain');
    expect(prompt.indexOf('ABOUT THE ATHLETE')).toBeLessThan(prompt.indexOf('TODAY (IDs in brackets)'));
  });

  it('leaves the schedule sections intact', () => {
    const prompt = buildSystemPrompt([], [], TODAY, [], { goal: 'Climb 5.13a' });
    expect(prompt).toContain('TODAY (IDs in brackets):\nNo workouts scheduled.');
    expect(prompt).toContain('THIS WEEK (IDs in brackets):\nNo workouts this week.');
    expect(prompt).toContain('Today: Thursday, July 16, 2026');
  });
});
