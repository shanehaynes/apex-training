import type { WorkoutType, WorkoutColorConfig } from '../types/workout';

export const WORKOUT_COLORS: Record<WorkoutType, WorkoutColorConfig> = {
  'stretching': {
    solid:  '#4a3f6b',
    light:  'rgba(74, 63, 107, 0.2)',
    glow:   '0 0 20px rgba(74, 63, 107, 0.35)',
    border: '#6d5fad',
    label:  'Stretching',
  },
  'morning-routine': {
    solid:  '#f97316',
    light:  'rgba(249, 115, 22, 0.15)',
    glow:   '0 0 20px rgba(249, 115, 22, 0.4)',
    border: '#f97316',
    label:  'Morning Routine',
  },
  'weights': {
    solid:  '#8b1a1a',
    light:  'rgba(139, 26, 26, 0.2)',
    glow:   '0 0 20px rgba(139, 26, 26, 0.5)',
    border: '#b91c1c',
    label:  'Strength',
  },
  'climbing': {
    solid:  '#228b22',
    light:  'rgba(34, 139, 34, 0.2)',
    glow:   '0 0 20px rgba(34, 139, 34, 0.45)',
    border: '#2eb82e',
    label:  'Climbing',
  },
  'cardio': {
    solid:  '#2d6a4f',
    light:  'rgba(45, 106, 79, 0.2)',
    glow:   '0 0 20px rgba(45, 106, 79, 0.4)',
    border: '#40916c',
    label:  'Cardio',
  },
  'yoga': {
    solid:  '#2a7d7d',
    light:  'rgba(42, 125, 125, 0.2)',
    glow:   '0 0 20px rgba(42, 125, 125, 0.35)',
    border: '#2a9d8f',
    label:  'Yoga & Mobility',
  },
};

export function getWorkoutColor(type: WorkoutType): WorkoutColorConfig {
  return WORKOUT_COLORS[type];
}
