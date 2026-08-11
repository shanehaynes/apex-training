import { downsample } from './client.js';

// FIT-file stream extraction: heart rate, GPS track, and altitude from the
// binary activity files COROS exposes through its FIT download tools —
// the only place time-series exist (querySportRecords/getActivityDetail
// answer with text summaries).
//
// @garmin/fitsdk is loaded via dynamic import so the catch-all lambda's
// cold start never pays for it (chat.ts import-surface rule): the module
// only loads inside an apply that actually downloads a FIT file. Decoder
// shapes verified against the SDK's own Encoder in coros-fit.test.ts:
// recordMesgs carry camelCase fields, positions in semicircles, altitude
// already scaled to meters.

export interface FitStreams {
  /** [secondsFromStart, bpm] */
  hr?: [number, number][];
  /** [secondsFromStart, latDeg, lonDeg, elevationM?] */
  gps?: [number, number, number, number?][];
}

const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;

interface RecordMesg {
  timestamp?: string | Date;
  heartRate?: number;
  positionLat?: number;
  positionLong?: number;
  altitude?: number;
  enhancedAltitude?: number;
}

function toMillis(ts: string | Date | undefined): number | null {
  if (ts === undefined) return null;
  const ms = ts instanceof Date ? ts.getTime() : Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** Decode a FIT file's record messages into downsampled streams. Returns
 *  null when the bytes aren't FIT or carry no usable records. */
export async function extractFitStreams(bytes: Uint8Array): Promise<FitStreams | null> {
  const { Decoder, Stream } = await import('@garmin/fitsdk');
  const stream = Stream.fromByteArray(bytes);
  const decoder = new Decoder(stream);
  if (!decoder.isFIT()) return null;

  // Decode errors are per-message; whatever records survived still count.
  const { messages } = decoder.read();
  const records = (messages.recordMesgs ?? []) as RecordMesg[];
  if (records.length === 0) return null;

  const t0 = toMillis(records[0].timestamp);
  if (t0 === null) return null;

  const hr: [number, number][] = [];
  const gps: [number, number, number, number?][] = [];
  for (const rec of records) {
    const ms = toMillis(rec.timestamp);
    if (ms === null) continue;
    const sec = Math.round((ms - t0) / 1000);

    if (typeof rec.heartRate === 'number') hr.push([sec, rec.heartRate]);

    if (typeof rec.positionLat === 'number' && typeof rec.positionLong === 'number') {
      const lat = rec.positionLat / SEMICIRCLES_PER_DEGREE;
      const lon = rec.positionLong / SEMICIRCLES_PER_DEGREE;
      const ele = rec.enhancedAltitude ?? rec.altitude;
      gps.push(typeof ele === 'number'
        ? [sec, round6(lat), round6(lon), Math.round(ele)]
        : [sec, round6(lat), round6(lon)]);
    }
  }

  const streams: FitStreams = {};
  if (hr.length) streams.hr = downsample(hr);
  if (gps.length) streams.gps = downsample(gps);
  return Object.keys(streams).length ? streams : null;
}

/** ~11 cm of precision; keeps the stored track compact. */
function round6(deg: number): number {
  return Math.round(deg * 1e6) / 1e6;
}

const MAX_FIT_BYTES = 25 * 1024 * 1024;

/** Extract the first https URL from the FIT-URL tool's text answer. */
export function firstUrlIn(text: string): string | null {
  return /https:\/\/[^\s"'<>)\]]+/.exec(text)?.[0] ?? null;
}

/** Download a FIT file (size-capped) and extract its streams. */
export async function fetchAndExtract(url: string): Promise<FitStreams | null> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FIT download failed: http ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_FIT_BYTES) throw new Error(`FIT file too large: ${length} bytes`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_FIT_BYTES) throw new Error(`FIT file too large: ${buf.byteLength} bytes`);
  return extractFitStreams(buf);
}
