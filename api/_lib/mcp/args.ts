import { ToolInputError } from './protocol.js';

// Hand-rolled argument validation for MCP tools (the repo carries no schema
// library on purpose). Failures throw ToolInputError, which the dispatcher
// turns into an isError tool result — visible to the model, never a crash.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function requireDate(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new ToolInputError(`${key} must be a YYYY-MM-DD date string.`);
  }
  return value;
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolInputError(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

export function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ToolInputError(`${key} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ToolInputError(`${key} must be a boolean.`);
  return value;
}

export function optionalInt(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolInputError(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

const DAY_MS = 86_400_000;

/** Validates start ≤ end and the inclusive span in days ≤ maxDays. */
export function requireDateRange(
  args: Record<string, unknown>,
  maxDays: number,
): { startDate: string; endDate: string } {
  const startDate = requireDate(args, 'start_date');
  const endDate = requireDate(args, 'end_date');
  if (endDate < startDate) throw new ToolInputError('end_date must be on or after start_date.');
  const span = (Date.parse(endDate) - Date.parse(startDate)) / DAY_MS + 1;
  if (span > maxDays) {
    throw new ToolInputError(`Date range too wide: ${span} days requested, maximum is ${maxDays}. Narrow the range.`);
  }
  return { startDate, endDate };
}
