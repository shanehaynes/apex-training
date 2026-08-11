import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVITY_DETAIL_TOOL,
  SPORT_RECORDS_TOOL,
  buildDateArgs,
  downsample,
  normalizeActivity,
  parseDetailText,
  parseSportRecordsText,
  pickDetailTool,
  pickListTool,
  sportRecordsArgs,
  toIsoInstant,
  type ProviderActivity,
} from '../_lib/providers/coros/client';
import { mapSport } from '../_lib/providers/coros/mapSport';
import type { McpToolInfo } from '../_lib/providers/mcpHttp';

// The tool list and schemas in fixtures/coros/tools-list.json were captured
// live from the official COROS MCP on 2026-08-10 — these tests pin the
// client's tool resolution and argument building against that reality,
// plus the adaptive fallbacks for shapes a server update might introduce.

const TOOLS_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/coros/tools-list.json'), 'utf8'),
) as { tools: McpToolInfo[] };

describe('tool resolution against the live fixture', () => {
  it('picks querySportRecords for the list — NOT queryActivityLapData', () => {
    expect(pickListTool(TOOLS_FIXTURE.tools)?.name).toBe(SPORT_RECORDS_TOOL);
  });

  it('picks getActivityDetail for detail — NOT analyzeActivityDetail', () => {
    expect(pickDetailTool(TOOLS_FIXTURE.tools)?.name).toBe(ACTIVITY_DETAIL_TOOL);
  });

  it('falls back to shape matching when the pinned names are absent', () => {
    const renamed = TOOLS_FIXTURE.tools.map(t => ({
      ...t,
      name: t.name === SPORT_RECORDS_TOOL ? 'queryWorkoutRecordsV2' : t.name,
    }));
    expect(pickListTool(renamed)?.name).toBe('queryWorkoutRecordsV2');
  });
});

describe('sportRecordsArgs', () => {
  it('emits yyyyMMdd strings and explicit nulls for every required filter', () => {
    const args = sportRecordsArgs('2026-07-11T00:00:00.000Z', '2026-08-10T12:00:00.000Z');
    expect(args).toEqual({
      startDate: '20260711',
      endDate: '20260810',
      sportTypeCodes: null,
      minDistanceKm: null,
      maxDistanceKm: null,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      maxAveragePace: null,
      locationKeyword: null,
      limit: 100,
    });
    // Every key the live schema requires is present.
    const schema = TOOLS_FIXTURE.tools.find(t => t.name === SPORT_RECORDS_TOOL)!.inputSchema as {
      required: string[];
    };
    for (const key of schema.required) expect(args).toHaveProperty(key);
  });
});

describe('buildDateArgs', () => {
  const since = '2026-07-11T00:00:00.000Z';
  const until = '2026-08-10T12:00:00.000Z';

  it('fills string date-range params as YYYY-MM-DD', () => {
    const schema = { properties: { startDate: { type: 'string' }, endDate: { type: 'string' } } };
    expect(buildDateArgs(schema, since, until)).toEqual({ startDate: '2026-07-11', endDate: '2026-08-10' });
  });

  it('fills integer date params as YYYYMMDD (the COROS convention)', () => {
    const schema = { properties: { startDay: { type: 'integer' }, endDay: { type: 'integer' } } };
    expect(buildDateArgs(schema, since, until)).toEqual({ startDay: 20260711, endDay: 20260810 });
  });

  it('falls back to a days window when no range params exist', () => {
    const schema = { properties: { days: { type: 'integer' } } };
    expect(buildDateArgs(schema, since, until)).toEqual({ days: 31 });
  });

  it('sets a limit when the schema offers one', () => {
    const schema = { properties: { from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'integer' } } };
    expect(buildDateArgs(schema, since, until)).toMatchObject({ limit: 100 });
  });

  it('returns empty args for a schema with no recognizable params', () => {
    expect(buildDateArgs({ properties: {} }, since, until)).toEqual({});
    expect(buildDateArgs(undefined, since, until)).toEqual({});
  });
});

describe('toIsoInstant', () => {
  it('passes through ISO strings', () => {
    expect(toIsoInstant('2026-08-10T13:32:00Z')).toBe('2026-08-10T13:32:00.000Z');
  });
  it('converts epoch seconds and milliseconds', () => {
    expect(toIsoInstant(1786367520)).toBe('2026-08-10T13:12:00.000Z');
    expect(toIsoInstant(1786367520000)).toBe('2026-08-10T13:12:00.000Z');
  });
  it('converts YYYYMMDD ints to midnight UTC', () => {
    expect(toIsoInstant(20260810)).toBe('2026-08-10T00:00:00.000Z');
  });
  it('rejects garbage', () => {
    expect(toIsoInstant('not a date')).toBeNull();
    expect(toIsoInstant(42)).toBeNull();
    expect(toIsoInstant(null)).toBeNull();
  });
});

describe('normalizeActivity', () => {
  it('normalizes a camelCase list item', () => {
    const a = normalizeActivity({
      activityId: '449021',
      sportType: 102,
      startTime: 1786367520,
      totalTime: 2820,
      distance: 8368.6,
      elevationGain: 250,
      avgHeartRate: 152,
      maxHeartRate: 176,
      calories: 512,
      trainingLoad: 87,
    });
    expect(a).toMatchObject({
      provider: 'coros',
      activityId: '449021',
      sport: 102,
      startUtc: '2026-08-10T13:12:00.000Z',
      durationSec: 2820,
      distanceMeters: 8368.6,
      elevationGainMeters: 250,
      avgHr: 152,
      maxHr: 176,
      calories: 512,
    });
    expect(a?.summaryExtras).toMatchObject({ trainingLoad: 87 });
  });

  it('returns null without an id or start time', () => {
    expect(normalizeActivity({ sportType: 100 })).toBeNull();
    expect(normalizeActivity({ activityId: 'x' })).toBeNull();
  });

  it('normalizes a querySportRecords-shaped entry, deriving duration from the timestamps', () => {
    const a = normalizeActivity({
      labelId: '449021123456',
      sportType: 102,
      startTimestamp: 1786367520,
      endTimestamp: 1786370340,
      distance: 8368.6,
      avgPace: '5:38',
      location: 'Tiger Mountain',
    }) as ProviderActivity;
    expect(a.activityId).toBe('449021123456');
    expect(a.sport).toBe(102);
    expect(a.startUtc).toBe('2026-08-10T13:12:00.000Z');
    expect(a.durationSec).toBe(2820);
    expect(a.summaryExtras).toMatchObject({ avgPace: '5:38', location: 'Tiger Mountain' });
  });

  it('extracts an hr series from value objects and keeps it out of extras', () => {
    const hrList = Array.from({ length: 120 }, (_, i) => ({ offset: i * 30, bpm: 120 + (i % 40) }));
    const a = normalizeActivity({
      id: '1',
      startTime: '2026-08-10T06:30:00Z',
      duration: 3600,
      heartRateList: hrList,
    });
    expect(a?.streams?.hr?.length).toBe(120);
    expect(a?.streams?.hr?.[0]).toEqual([0, 120]);
    expect(a?.summaryExtras.heartRateList).toBeUndefined();
  });

  it('extracts gps points with lat/lon objects', () => {
    const track = Array.from({ length: 80 }, (_, i) => ({ latitude: 47 + i * 1e-4, longitude: -122, elevation: 100 + i }));
    const a = normalizeActivity({
      id: '2',
      startTime: '2026-08-10T06:30:00Z',
      duration: 3600,
      gpsTrack: track,
    });
    expect(a?.streams?.gps?.length).toBe(80);
    expect(a?.streams?.gps?.[0]).toEqual([0, 47, -122, 100]);
  });
});

describe('downsample', () => {
  it('keeps short series intact', () => {
    const points = [1, 2, 3];
    expect(downsample(points, 2000)).toBe(points);
  });
  it('thins long series to the cap, keeping the endpoints', () => {
    const points = Array.from({ length: 10_000 }, (_, i) => i);
    const out = downsample(points, 2000);
    expect(out.length).toBe(2000);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(9999);
  });
});

describe('parseSportRecordsText against the live fixture', () => {
  const RECORDS_FIXTURE = JSON.parse(
    readFileSync(join(__dirname, 'fixtures/coros/sport-records.json'), 'utf8'),
  ) as { content: Array<{ text: string }> };
  // toolCall JSON.parses the content text (it's a JSON-quoted string).
  const report = JSON.parse(RECORDS_FIXTURE.content[0].text) as string;

  it('parses all three activities with ids, sport codes, and start instants', () => {
    const activities = parseSportRecordsText(report);
    expect(activities.map(a => [a.activityId, a.sport])).toEqual([
      ['479485294872133835', 402],
      ['479414540117770543', 301],
      ['478978636903383047', 102],
    ]);
    expect(activities[0].startUtc).toBe(new Date(1786217357 * 1000).toISOString());
  });

  it('prefers the explicit Duration over the wall-clock window and converts km distances', () => {
    const [strength, swim, trail] = parseSportRecordsText(report);
    expect(strength.durationSec).toBe(1 * 3600 + 21 * 60 + 35);
    expect(strength.distanceMeters).toBeUndefined();
    expect(swim.durationSec).toBe(59 * 60 + 13);
    expect(swim.distanceMeters).toBeCloseTo(1360, 0);
    expect(trail.durationSec).toBe(7 * 3600 + 54 * 60 + 6);
    expect(trail.distanceMeters).toBeCloseTo(23400, 0);
  });

  it('captures HR, calories, and the text extras', () => {
    const [strength, swim, trail] = parseSportRecordsText(report);
    expect(strength.avgHr).toBe(125);
    expect(strength.calories).toBe(768);
    expect(strength.summaryExtras).toMatchObject({ sets: 1, corosDate: '2026-08-08' });
    expect(swim.summaryExtras).toMatchObject({
      location: 'North Kingstown Open Water',
      avgPace: '4:21 /km',
      startCoordinates: [41.568001, -71.444],
    });
    expect(trail.avgHr).toBe(109);
    expect(trail.summaryExtras).toMatchObject({ location: 'Provo Trail Run' });
  });

  it('feeds the matcher correctly end to end: sport 102 → cardio Trail Run', () => {
    const trail = parseSportRecordsText(report)[2];
    expect(mapSport(trail.sport)).toEqual({ type: 'cardio', label: 'Trail Run' });
  });

  it('returns [] for text with no numbered entries', () => {
    expect(parseSportRecordsText('No workout records found for this range.')).toEqual([]);
  });
});

describe('parseDetailText', () => {
  it('extracts shared scalar labels and caps the raw text', () => {
    const detail = parseDetailText(
      'Trail Run — 2026-07-17\nDistance: 23.40 km | Elevation Gain: 1250 m\nAvg HR: 109 bpm | Max HR: 165 bpm | Calories: 3165 kcal\n' + 'x'.repeat(5000),
    );
    expect(detail).toMatchObject({
      distanceMeters: 23400,
      elevationGainMeters: 1250,
      avgHr: 109,
      maxHr: 165,
      calories: 3165,
    });
    expect((detail!.summaryExtras!.detailText as string).length).toBe(4000);
  });
});

describe('mapSport (dubbo codes verified against the live tool description)', () => {
  it('maps the verified numeric codes', () => {
    expect(mapSport(100)).toEqual({ type: 'cardio', label: 'Run' });
    expect(mapSport(102)).toEqual({ type: 'cardio', label: 'Trail Run' });
    expect(mapSport(402)).toEqual({ type: 'weights', label: 'Strength' });
    expect(mapSport(800)).toEqual({ type: 'climbing', label: 'Indoor Climb' });
    expect(mapSport(801)).toEqual({ type: 'climbing', label: 'Bouldering' });
    expect(mapSport(802)).toEqual({ type: 'outdoor-climbing', label: 'Outdoor Climb' });
    expect(mapSport(904)).toEqual({ type: 'yoga', label: 'Yoga' });
    expect(mapSport(905)).toEqual({ type: 'stretching', label: 'Pilates' });
    expect(mapSport(10003)).toEqual({ type: 'outdoor-climbing', label: 'Multi-Pitch Climb' });
  });
  it('keeps endurance climb-named modes in cardio', () => {
    expect(mapSport(105)).toEqual({ type: 'cardio', label: 'Mountain Climb' });
    expect(mapSport(902)).toEqual({ type: 'cardio', label: 'Stair Climbing' });
    expect(mapSport(10002)).toEqual({ type: 'cardio', label: 'Climb Ski' });
  });
  it('maps label strings case-insensitively', () => {
    expect(mapSport('trail_run')).toEqual({ type: 'cardio', label: 'Trail Run' });
    expect(mapSport('Indoor Climb')).toEqual({ type: 'climbing', label: 'Indoor Climb' });
    expect(mapSport('strength training')).toEqual({ type: 'weights', label: 'Strength Training' });
  });
  it('defaults unknowns to cardio without losing the label', () => {
    expect(mapSport(9999)).toEqual({ type: 'cardio', label: 'Activity 9999' });
    expect(mapSport('Windsurfing')).toEqual({ type: 'cardio', label: 'Windsurfing' });
    expect(mapSport(undefined)).toEqual({ type: 'cardio', label: 'Activity' });
  });
});
