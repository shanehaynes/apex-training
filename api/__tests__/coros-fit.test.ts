import { describe, it, expect } from 'vitest';
import { Encoder, Profile } from '@garmin/fitsdk';
import { extractFitStreams, firstUrlIn } from '../_lib/providers/coros/fit';

// The FIT decoder is exercised against files built with the SDK's own
// Encoder — a real binary round trip, no hand-maintained byte fixtures.

const START = new Date('2026-08-10T13:12:00Z');
const SEMI = 2 ** 31 / 180;

// The SDK's Mesg type doesn't model per-message fields; runtime accepts
// any camelCase profile field names.
const writeMesg = (encoder: Encoder, num: number, mesg: Record<string, unknown>) =>
  (encoder as unknown as { onMesg(n: number, m: Record<string, unknown>): void }).onMesg(num, mesg);

function buildFit(records: Array<{
  offsetSec: number;
  hr?: number;
  lat?: number;
  lon?: number;
  ele?: number;
}>): Uint8Array {
  const encoder = new Encoder();
  writeMesg(encoder, Profile.MesgNum.FILE_ID, {
    type: 'activity',
    manufacturer: 'coros',
    timeCreated: START,
  });
  for (const r of records) {
    writeMesg(encoder, Profile.MesgNum.RECORD, {
      timestamp: new Date(START.getTime() + r.offsetSec * 1000),
      ...(r.hr !== undefined ? { heartRate: r.hr } : {}),
      ...(r.lat !== undefined && r.lon !== undefined
        ? {
            positionLat: Math.round(r.lat * SEMI),
            positionLong: Math.round(r.lon * SEMI),
            ...(r.ele !== undefined ? { altitude: r.ele } : {}),
          }
        : {}),
    });
  }
  return encoder.close();
}

describe('extractFitStreams', () => {
  it('extracts hr and gps series with relative seconds and degree coordinates', async () => {
    const bytes = buildFit([
      { offsetSec: 0, hr: 120, lat: 40.431, lon: -111.639, ele: 1400 },
      { offsetSec: 30, hr: 141, lat: 40.4312, lon: -111.6388, ele: 1410 },
      { offsetSec: 60, hr: 152, lat: 40.4315, lon: -111.6385, ele: 1425 },
    ]);
    const streams = await extractFitStreams(bytes);
    expect(streams?.hr).toEqual([[0, 120], [30, 141], [60, 152]]);
    expect(streams?.gps).toHaveLength(3);
    const [sec, lat, lon, ele] = streams!.gps![0];
    expect(sec).toBe(0);
    expect(lat).toBeCloseTo(40.431, 5);
    expect(lon).toBeCloseTo(-111.639, 5);
    expect(ele).toBe(1400);
  });

  it('handles hr-only files (no GPS lock) and gps-only records', async () => {
    const hrOnly = await extractFitStreams(buildFit([
      { offsetSec: 0, hr: 100 },
      { offsetSec: 10, hr: 110 },
    ]));
    expect(hrOnly?.hr).toHaveLength(2);
    expect(hrOnly?.gps).toBeUndefined();

    const gpsOnly = await extractFitStreams(buildFit([
      { offsetSec: 0, lat: 41.568, lon: -71.444 },
      { offsetSec: 5, lat: 41.5681, lon: -71.4441 },
    ]));
    expect(gpsOnly?.gps).toHaveLength(2);
    expect(gpsOnly?.gps![0]).toHaveLength(3);
    expect(gpsOnly?.hr).toBeUndefined();
  });

  it('downsamples long recordings to the cap', async () => {
    const bytes = buildFit(Array.from({ length: 4000 }, (_, i) => ({
      offsetSec: i, hr: 100 + (i % 60),
    })));
    const streams = await extractFitStreams(bytes);
    expect(streams!.hr!.length).toBe(2000);
    expect(streams!.hr![0]).toEqual([0, 100]);
    expect(streams!.hr![1999][0]).toBe(3999);
  });

  it('returns null for non-FIT bytes and empty files', async () => {
    expect(await extractFitStreams(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    const noRecords = new Encoder();
    writeMesg(noRecords, Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'coros', timeCreated: START });
    expect(await extractFitStreams(noRecords.close())).toBeNull();
  });
});

describe('firstUrlIn', () => {
  it('pulls the first https URL out of the tool text', () => {
    expect(firstUrlIn('Download: https://files.coros.com/fit/abc.fit?sig=x expires soon'))
      .toBe('https://files.coros.com/fit/abc.fit?sig=x');
    expect(firstUrlIn('no urls here')).toBeNull();
  });
});
