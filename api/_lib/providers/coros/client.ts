import { McpHttpClient, McpToolError, type McpToolInfo } from '../mcpHttp.js';
import { COROS_MCP_ENDPOINT } from './oauth.js';
import { fetchAndExtract, firstUrlIn, type FitStreams } from './fit.js';

// COROS activity access over the official remote MCP. Tool names and
// schemas were captured live on 2026-08-10 (fixtures/coros/tools-list.json):
// the activity list is `querySportRecords` (yyyyMMdd string dates, every
// filter listed in `required` but nullable) and per-activity detail is
// `getActivityDetail` (REQUIRES labelId AND sportType). Exact names are
// pinned first with shape-based resolution kept as a fallback for server
// updates — the fallback alone is NOT safe (queryActivityLapData matches
// "activity" patterns before querySportRecords does).
//
// Payload reality (fixtures/coros/sport-records.json, captured 2026-08-11):
// querySportRecords answers with FORMATTED TEXT — a numbered human-readable
// report ("1. Trail Run — 2026-07-17 … Distance: 23.40 km … LabelId: … |
// SportType: 102"), not structured JSON. parseSportRecordsText handles it;
// the key-shape normalization below stays for a future structured payload.
// Distances are kilometers. Everything COROS-payload-specific is contained
// HERE — sync.ts and the matcher consume only the normalized
// ProviderActivity.

export interface ProviderActivity {
  provider: 'coros';
  activityId: string;
  sport: string | number;
  /** ISO UTC instant of the activity start. */
  startUtc: string;
  durationSec: number;
  distanceMeters?: number;
  elevationGainMeters?: number;
  avgHr?: number;
  maxHr?: number;
  calories?: number;
  /** Everything else the payload carried (hrZones, hrv, trainingLoad, fileUrls…). */
  summaryExtras: Record<string, unknown>;
  streams?: {
    hr?: [number, number][];
    gps?: [number, number, number, number?][];
  };
}

export const SPORT_RECORDS_TOOL = 'querySportRecords';
export const ACTIVITY_DETAIL_TOOL = 'getActivityDetail';
export const FIT_URLS_TOOL = 'queryActivityFitFileDownloadUrls';

function adaptiveFind(tools: McpToolInfo[], patterns: RegExp[]): McpToolInfo | null {
  // Names first, descriptions second — descriptions cross-reference OTHER
  // tools by name (queryCustomActivityLapData's says "use querySportRecords
  // first"), so a description match must never outrank a name match.
  for (const pattern of patterns) {
    const hit = tools.find(t => pattern.test(t.name));
    if (hit) return hit;
  }
  for (const pattern of patterns) {
    const hit = tools.find(t => pattern.test(`${t.name} ${t.description ?? ''}`));
    if (hit) return hit;
  }
  return null;
}

/** The activity-list tool: exact name first, shape fallback second. */
export function pickListTool(tools: McpToolInfo[]): McpToolInfo | null {
  return tools.find(t => t.name === SPORT_RECORDS_TOOL)
    ?? adaptiveFind(tools, [
      /(workout|sport).{0,20}records/is,
      /activit\w*.{0,40}(list|recent|history|range)/is,
      /(list|recent|history).{0,40}activit/is,
    ]);
}

/** The per-activity detail tool: exact name first, shape fallback second. */
export function pickDetailTool(tools: McpToolInfo[]): McpToolInfo | null {
  return tools.find(t => t.name === ACTIVITY_DETAIL_TOOL)
    ?? adaptiveFind(tools, [
      /activit\w*.{0,40}detail/is,
      /detail.{0,40}activit/is,
    ]);
}

/**
 * Pinned args for querySportRecords: dates are yyyyMMdd STRINGS, and the
 * schema lists every optional filter in `required` (nullable in practice —
 * "or null for all sports" per its own description), so each one is passed
 * explicitly. limit raised from the default 20 to cover a 30-day backfill.
 */
export function sportRecordsArgs(sinceIso: string, untilIso: string): Record<string, unknown> {
  const yyyymmdd = (iso: string) => iso.slice(0, 10).replaceAll('-', '');
  return {
    startDate: yyyymmdd(sinceIso),
    endDate: yyyymmdd(untilIso),
    sportTypeCodes: null,
    minDistanceKm: null,
    maxDistanceKm: null,
    minDurationMinutes: null,
    maxDurationMinutes: null,
    maxAveragePace: null,
    locationKeyword: null,
    limit: 100,
  };
}

export class CorosClient {
  private readonly mcp: McpHttpClient;
  private tools: McpToolInfo[] | null = null;

  constructor(accessToken: string, endpoint = COROS_MCP_ENDPOINT) {
    this.mcp = new McpHttpClient(endpoint, accessToken);
  }

  private async loadTools(): Promise<McpToolInfo[]> {
    this.tools ??= await this.mcp.toolsList();
    return this.tools;
  }

  async fetchRecentActivities(sinceIso: string, untilIso: string): Promise<ProviderActivity[]> {
    const tools = await this.loadTools();
    const tool = pickListTool(tools);
    if (!tool) {
      throw new McpToolError('no_tool', `no activity-list tool found among: ${tools.map(t => t.name).join(', ')}`);
    }
    const args = tool.name === SPORT_RECORDS_TOOL
      ? sportRecordsArgs(sinceIso, untilIso)
      : buildDateArgs(tool.inputSchema, sinceIso, untilIso);
    const payload = await this.mcp.toolCall(tool.name, args);
    const activities = typeof payload === 'string'
      ? parseSportRecordsText(payload)
      : extractActivityArray(payload)
          .map(item => normalizeActivity(item))
          .filter((a): a is ProviderActivity => a !== null);
    // The date window may over-fetch (yyyyMMdd is coarser than an instant);
    // enforce it here so the caller's contract holds regardless.
    return activities.filter(a => a.startUtc >= sinceIso && a.startUtc <= untilIso);
  }

  /** Per-activity detail enrichment; null when unavailable (the list payload
   *  is then all we get — still enough for scalars). getActivityDetail
   *  requires BOTH labelId and the numeric sportType from the records list.
   *  Returns a PARTIAL: only the fields the detail payload actually carried. */
  async fetchActivityDetail(activityId: string, sportType?: number): Promise<Partial<ProviderActivity> | null> {
    const tools = await this.loadTools();
    const tool = pickDetailTool(tools);
    if (!tool) return null;

    let args: Record<string, unknown>;
    if (tool.name === ACTIVITY_DETAIL_TOOL) {
      if (sportType === undefined) return null;
      args = { labelId: activityId, sportType };
    } else {
      const idKey = firstSchemaKey(tool.inputSchema, [/activity.?id/i, /^id$/i, /label.?id/i]) ?? 'labelId';
      args = { [idKey]: activityId, ...(sportType !== undefined ? { sportType } : {}) };
    }
    const payload = await this.mcp.toolCall(tool.name, args);
    if (typeof payload === 'string') return parseDetailText(payload);
    const item = extractActivityArray(payload)[0] ?? (isRecord(payload) ? payload : null);
    return item ? normalizeActivity(item, activityId) : null;
  }

  /** HR/GPS/altitude time-series via the FIT-URL tool (the text summaries
   *  carry no series). One file per call against COROS's daily FIT limit;
   *  null when the tool, URL, or records are missing. */
  async fetchFitStreams(activityId: string, sportType?: number): Promise<FitStreams | null> {
    if (sportType === undefined) return null;
    const tools = await this.loadTools();
    const tool = tools.find(t => t.name === FIT_URLS_TOOL)
      ?? adaptiveFind(tools, [/fit.{0,20}(url|download)/is]);
    if (!tool) return null;

    const payload = await this.mcp.toolCall(tool.name, { labelId: activityId, sportType, limit: 1 });
    const url = typeof payload === 'string' ? firstUrlIn(payload) : null;
    if (!url) return null;
    return fetchAndExtract(url);
  }
}

// ─── Formatted-text payload parsing ──────────────────────────────────────────

function parseClockDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.split(':').map(Number);
  if (parts.some(Number.isNaN)) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return undefined;
}

function parseDistanceMeters(value: string | undefined, unit: string | undefined): number | undefined {
  const n = value ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  switch ((unit ?? '').toLowerCase()) {
    case 'km': return n * 1000;
    case 'mi': return n * 1609.344;
    case 'm': return n;
    default: return undefined;
  }
}

/** Shared field extraction for the formatted-text reports. */
function textMetrics(block: string): Partial<ProviderActivity> & { extras: Record<string, unknown> } {
  const grab = (re: RegExp) => re.exec(block)?.slice(1);
  const dist = grab(/Distance:\s*([\d.]+)\s*(km|mi|m)\b/i);
  const elev = grab(/Elev(?:ation)?\.?\s*Gain:\s*([\d.]+)\s*(km|mi|m|ft)?\b/i);
  const elevMeters = elev
    ? (elev[1] === 'ft' ? Number(elev[0]) / 3.28084 : parseDistanceMeters(elev[0], elev[1] ?? 'm'))
    : undefined;

  const extras: Record<string, unknown> = {};
  const location = /Location:\s*(.+?)\s*$/m.exec(block)?.[1];
  const pace = /Average Pace:\s*([^|\n]+)/.exec(block)?.[1]?.trim();
  const coords = /Start Coordinates:\s*([-\d.]+),\s*([-\d.]+)/.exec(block);
  const sets = /Sets:\s*(\d+)/.exec(block)?.[1];
  if (location) extras.location = location;
  if (pace) extras.avgPace = pace;
  if (coords) extras.startCoordinates = [Number(coords[1]), Number(coords[2])];
  if (sets) extras.sets = Number(sets);

  return {
    ...(dist ? { distanceMeters: parseDistanceMeters(dist[0], dist[1]) } : {}),
    ...(elevMeters !== undefined ? { elevationGainMeters: elevMeters } : {}),
    ...(grab(/Avg\.?\s*HR:\s*(\d+)/i) ? { avgHr: Number(grab(/Avg\.?\s*HR:\s*(\d+)/i)![0]) } : {}),
    ...(grab(/Max\.?\s*HR:\s*(\d+)/i) ? { maxHr: Number(grab(/Max\.?\s*HR:\s*(\d+)/i)![0]) } : {}),
    ...(grab(/Calories:\s*(\d+)/i) ? { calories: Number(grab(/Calories:\s*(\d+)/i)![0]) } : {}),
    extras,
  };
}

/**
 * Parse the querySportRecords formatted-text report into activities. Entry
 * shape (fixtures/coros/sport-records.json):
 *
 *   2. Open Water Swim — 2026-08-05
 *      Location: North Kingstown Open Water
 *      Time Window: startTimestamp=1785952378 | endTimestamp=1785955931
 *      Duration: 59:13 | Distance: 1.36 km
 *      Average Pace: 4:21 /km | Avg HR: 120 bpm | Calories: 648 kcal
 *      LabelId: 479414540117770543 | SportType: 301
 */
export function parseSportRecordsText(text: string): ProviderActivity[] {
  const activities: ProviderActivity[] = [];
  for (const block of text.split(/\n(?=\d+\.\s)/)) {
    const header = /^(\d+)\.\s+(.+?)\s+—\s+(\d{4}-\d{2}-\d{2})/.exec(block.trim());
    if (!header) continue;

    const labelId = /LabelId:\s*([\w-]+)/.exec(block)?.[1];
    const sportType = /SportType:\s*(\d+)/.exec(block)?.[1];
    const startTs = /startTimestamp=(\d+)/.exec(block)?.[1];
    const endTs = /endTimestamp=(\d+)/.exec(block)?.[1];
    if (!labelId || !startTs) continue;

    // The explicit Duration (active time) beats the wall-clock window.
    const durationSec = parseClockDuration(/Duration:\s*([\d:]+)/.exec(block)?.[1])
      ?? (endTs ? Number(endTs) - Number(startTs) : 0);

    const metrics = textMetrics(block);
    const { extras, ...scalars } = metrics;
    activities.push({
      provider: 'coros',
      activityId: labelId,
      sport: sportType ? Number(sportType) : header[2],
      startUtc: new Date(Number(startTs) * 1000).toISOString(),
      durationSec,
      ...scalars,
      summaryExtras: { sportLabelText: header[2], corosDate: header[3], ...extras },
    });
  }
  return activities;
}

const DETAIL_TEXT_CAP = 4000;

/**
 * getActivityDetail is expected to answer in the same formatted-text style;
 * its exact layout is uncaptured, so extract the shared scalar labels and
 * keep the (capped) raw text in summaryExtras for the AI coach to read.
 */
export function parseDetailText(text: string): Partial<ProviderActivity> | null {
  const { extras, ...scalars } = textMetrics(text);
  if (Object.keys(scalars).length === 0 && text.trim().length === 0) return null;
  return {
    ...scalars,
    summaryExtras: { ...extras, detailText: text.slice(0, DETAIL_TEXT_CAP) },
  };
}

// ─── Schema-driven argument building ─────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function schemaProperties(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  return isRecord(schema?.properties) ? schema.properties : {};
}

function firstSchemaKey(schema: Record<string, unknown> | undefined, patterns: RegExp[]): string | null {
  const keys = Object.keys(schemaProperties(schema));
  for (const pattern of patterns) {
    const hit = keys.find(k => pattern.test(k));
    if (hit) return hit;
  }
  return null;
}

/** Format a date value the way the parameter's schema suggests: numbers get
 *  YYYYMMDD (the COROS convention), strings get YYYY-MM-DD. */
function dateValue(prop: unknown, iso: string): string | number {
  const day = iso.slice(0, 10);
  const type = isRecord(prop) ? prop.type : undefined;
  if (type === 'integer' || type === 'number') return Number(day.replaceAll('-', ''));
  return day;
}

export function buildDateArgs(
  schema: Record<string, unknown> | undefined,
  sinceIso: string,
  untilIso: string,
): Record<string, unknown> {
  const props = schemaProperties(schema);
  const args: Record<string, unknown> = {};

  const fromKey = firstSchemaKey(schema, [/^(from|since|after)/i, /start.?(date|day|time)/i, /^begin/i]);
  const toKey = firstSchemaKey(schema, [/^(to|until|before)$/i, /end.?(date|day|time)/i]);
  if (fromKey) args[fromKey] = dateValue(props[fromKey], sinceIso);
  if (toKey) args[toKey] = dateValue(props[toKey], untilIso);

  if (!fromKey) {
    const daysKey = firstSchemaKey(schema, [/days|window/i]);
    if (daysKey) {
      args[daysKey] = Math.max(1, Math.ceil(
        (Date.parse(untilIso) - Date.parse(sinceIso)) / 86_400_000,
      ));
    }
  }
  const limitKey = firstSchemaKey(schema, [/limit|count|size|max/i]);
  if (limitKey) args[limitKey] = 100;
  return args;
}

// ─── Payload normalization ───────────────────────────────────────────────────

function extractActivityArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of ['activities', 'dataList', 'items', 'workouts', 'records', 'data', 'list']) {
    const v = payload[key];
    if (Array.isArray(v)) return v.filter(isRecord);
    if (isRecord(v)) {
      const nested = extractActivityArray(v);
      if (nested.length) return nested;
    }
  }
  return [];
}

function pick(item: Record<string, unknown>, patterns: RegExp[]): unknown {
  for (const pattern of patterns) {
    const key = Object.keys(item).find(k => pattern.test(k));
    if (key !== undefined && item[key] !== null && item[key] !== undefined) return item[key];
  }
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Epoch seconds/ms, ISO strings, and YYYYMMDD ints all become ISO UTC. */
export function toIsoInstant(v: unknown): string | null {
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const n = asNumber(v);
  if (n === undefined) return null;
  if (n > 10_000_000 && n < 100_000_000) {
    // YYYYMMDD date-only int (e.g. 20260810) — midnight UTC.
    const s = String(n);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00.000Z`;
  }
  if (n > 1e12) return new Date(n).toISOString();          // epoch ms
  if (n > 1e9) return new Date(n * 1000).toISOString();    // epoch seconds
  return null;
}

const SCALAR_PATTERNS: Record<string, RegExp[]> = {
  id: [/^(activity)?.?id$/i, /label.?id/i],
  sport: [/sport.?(type|mode)?/i, /^mode$/i, /activity.?type/i],
  start: [/start.?(time|timestamp|date)/i, /^date$/i, /begin/i],
  end: [/end.?(time|timestamp|date)/i],
  duration: [/total.?(time|duration)/i, /duration/i, /workout.?time/i, /elapsed/i],
  distance: [/distance/i],
  elevation: [/(elev|ascent|climb|vert).*(gain)?/i],
  avgHr: [/avg.*(hr|heart)/i, /(hr|heart).*avg/i, /average.?heart/i],
  maxHr: [/max.*(hr|heart)/i, /(hr|heart).*max/i],
  calories: [/calorie|kcal/i],
};

export function normalizeActivity(
  item: Record<string, unknown>,
  fallbackId?: string,
): ProviderActivity | null {
  const id = pick(item, SCALAR_PATTERNS.id) ?? fallbackId;
  const startUtc = toIsoInstant(pick(item, SCALAR_PATTERNS.start));
  if (id === undefined || id === null || !startUtc) return null;

  // querySportRecords carries startTimestamp/endTimestamp (Unix seconds)
  // rather than an explicit duration — derive it when no duration field
  // parses ("workout time" can arrive as a display string).
  let durationSec = asNumber(pick(item, SCALAR_PATTERNS.duration)) ?? 0;
  if (!durationSec) {
    const endUtc = toIsoInstant(pick(item, SCALAR_PATTERNS.end));
    if (endUtc) durationSec = Math.max(0, (Date.parse(endUtc) - Date.parse(startUtc)) / 1000);
  }
  const sportRaw = pick(item, SCALAR_PATTERNS.sport);
  const distance = asNumber(pick(item, SCALAR_PATTERNS.distance));

  const consumed = new Set<string>();
  for (const patterns of Object.values(SCALAR_PATTERNS)) {
    for (const pattern of patterns) {
      for (const key of Object.keys(item)) if (pattern.test(key)) consumed.add(key);
    }
  }
  const summaryExtras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (!consumed.has(key) && value !== null && !isBulkyValue(value)) summaryExtras[key] = value;
  }

  const streams = extractStreams(item);
  return {
    provider: 'coros',
    activityId: String(id),
    sport: (typeof sportRaw === 'number' || typeof sportRaw === 'string') ? sportRaw : 'Activity',
    startUtc,
    durationSec,
    // COROS distances are meters in every known payload shape.
    distanceMeters: distance,
    elevationGainMeters: asNumber(pick(item, SCALAR_PATTERNS.elevation)),
    avgHr: asNumber(pick(item, SCALAR_PATTERNS.avgHr)),
    maxHr: asNumber(pick(item, SCALAR_PATTERNS.maxHr)),
    calories: asNumber(pick(item, SCALAR_PATTERNS.calories)),
    summaryExtras,
    ...(streams ? { streams } : {}),
  };
}

/** Arrays of hundreds of points don't belong in summaryExtras. */
function isBulkyValue(v: unknown): boolean {
  return Array.isArray(v) && v.length > 50;
}

const MAX_STREAM_POINTS = 2000;

/** Thin a series to ≤ max points, always keeping first and last. */
export function downsample<T>(points: T[], max = MAX_STREAM_POINTS): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

function extractStreams(item: Record<string, unknown>): ProviderActivity['streams'] | null {
  const streams: NonNullable<ProviderActivity['streams']> = {};

  const hrRaw = pick(item, [/heart.?rate.?(list|series|points|stream)/i, /^hr.?(list|series|points|stream)/i]);
  if (Array.isArray(hrRaw) && hrRaw.length > 0) {
    const hr = hrRaw
      .map((p, i): [number, number] | null => {
        if (Array.isArray(p) && p.length >= 2) {
          const [t, bpm] = [asNumber(p[0]), asNumber(p[1])];
          return t !== undefined && bpm !== undefined ? [t, bpm] : null;
        }
        if (isRecord(p)) {
          const bpm = asNumber(pick(p, [/bpm|value|hr|heart/i]));
          const t = asNumber(pick(p, [/time|offset|second/i])) ?? i;
          return bpm !== undefined ? [t, bpm] : null;
        }
        const bpm = asNumber(p);
        return bpm !== undefined ? [i, bpm] : null;
      })
      .filter((p): p is [number, number] => p !== null);
    if (hr.length) streams.hr = downsample(hr);
  }

  const gpsRaw = pick(item, [/gps|track.?points|route|latlng|coordinates/i]);
  if (Array.isArray(gpsRaw) && gpsRaw.length > 0) {
    const gps = gpsRaw
      .map((p, i): [number, number, number, number?] | null => {
        if (isRecord(p)) {
          const lat = asNumber(pick(p, [/^lat/i]));
          const lon = asNumber(pick(p, [/^(lon|lng)/i]));
          if (lat === undefined || lon === undefined) return null;
          const t = asNumber(pick(p, [/time|offset|second/i])) ?? i;
          const ele = asNumber(pick(p, [/ele|alt/i]));
          return ele !== undefined ? [t, lat, lon, ele] : [t, lat, lon];
        }
        if (Array.isArray(p) && p.length >= 2) {
          const [lat, lon] = [asNumber(p[0]), asNumber(p[1])];
          return lat !== undefined && lon !== undefined ? [i, lat, lon] : null;
        }
        return null;
      })
      .filter((p): p is [number, number, number, number?] => p !== null);
    if (gps.length) streams.gps = downsample(gps);
  }

  return Object.keys(streams).length ? streams : null;
}
