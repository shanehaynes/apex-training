import { useMemo, useRef, useState } from 'react';
import { formatElapsed } from '../../lib/time';

// Time-series charts for a synced activity: heart-rate line, elevation
// profile, and the GPS route drawn as an equirectangular outline — no tile
// server, so coordinates never leave the app. Single series per chart, so
// the chart title carries identity (no legends). All ink uses text tokens;
// the one mark color (#ea690b) is validated against the modal surface for
// lightness band + 3:1 contrast (see PR notes) — a shade darker than the
// sync-badge accent for exactly that reason.

export interface Streams {
  hr?: [number, number][];
  gps?: [number, number, number, number?][];
}

const MARK = '#ea690b';
const W = 560;
const H = 96;
const PAD = { top: 14, right: 8, bottom: 16, left: 34 };

interface XYSeries {
  points: { x: number; y: number; sec: number; value: number }[];
  min: number;
  max: number;
  minIdx: number;
  maxIdx: number;
  path: string;
}

function buildSeries(data: [number, number][]): XYSeries | null {
  if (data.length < 2) return null;
  const secs = data.map(d => d[0]);
  const values = data.map(d => d[1]);
  const secMax = secs[secs.length - 1] || 1;
  let min = Infinity, max = -Infinity, minIdx = 0, maxIdx = 0;
  values.forEach((v, i) => {
    if (v < min) { min = v; minIdx = i; }
    if (v > max) { max = v; maxIdx = i; }
  });
  const span = max - min || 1;
  const points = data.map(([sec, value]) => ({
    sec,
    value,
    x: PAD.left + (sec / secMax) * (W - PAD.left - PAD.right),
    y: PAD.top + (1 - (value - min) / span) * (H - PAD.top - PAD.bottom),
  }));
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
  return { points, min, max, minIdx, maxIdx, path };
}

/** Line chart with a crosshair + tooltip hover layer and min/max direct
 *  labels (selective — never a number on every point). */
function TimeChart({ title, unit, data, area }: {
  title: string;
  unit: string;
  data: [number, number][];
  /** Fill under the line (elevation profile). */
  area?: boolean;
}) {
  const series = useMemo(() => buildSeries(data), [data]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!series) return null;
  const { points, min, max, minIdx, maxIdx, path } = series;

  const onMove = (e: React.PointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * W;
    // Points are time-ordered; nearest-x is fine at ≤2000 points.
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].x - x);
      if (d < bestDist) { best = i; bestDist = d; }
    }
    setHoverIdx(best);
  };

  const hover = hoverIdx !== null ? points[hoverIdx] : null;
  const baseline = H - PAD.bottom;

  return (
    <figure className="stream-chart">
      <figcaption className="stream-chart__title">{title}</figcaption>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="stream-chart__svg"
        role="img"
        aria-label={`${title}: ${min}–${max} ${unit} over ${formatElapsed(points[points.length - 1].sec)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        {/* Recessive grid: min/max gridlines only. */}
        {[points[maxIdx].y, points[minIdx].y].map((y, i) => (
          <line key={i} x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} className="stream-chart__grid" />
        ))}
        {area && (
          <path
            d={`${path}L${points[points.length - 1].x.toFixed(1)},${baseline}L${points[0].x.toFixed(1)},${baseline}Z`}
            fill={MARK}
            opacity={0.16}
          />
        )}
        <path d={path} fill="none" stroke={MARK} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />

        {/* Selective direct labels: the extremes, in text ink. */}
        <text x={PAD.left - 4} y={points[maxIdx].y + 3} className="stream-chart__label" textAnchor="end">{Math.round(max)}</text>
        <text x={PAD.left - 4} y={points[minIdx].y + 3} className="stream-chart__label" textAnchor="end">{Math.round(min)}</text>

        {hover && (
          <g>
            <line x1={hover.x} x2={hover.x} y1={PAD.top} y2={baseline} className="stream-chart__crosshair" />
            <circle cx={hover.x} cy={hover.y} r={3.5} fill={MARK} stroke="var(--bg-elevated)" strokeWidth={2} />
          </g>
        )}
      </svg>
      <div className="stream-chart__readout" aria-live="off">
        {hover
          ? `${formatElapsed(hover.sec)} · ${Math.round(hover.value)} ${unit}`
          : `${Math.round(min)}–${Math.round(max)} ${unit}`}
      </div>
    </figure>
  );
}

/** The GPS track as a shape: equirectangular projection with latitude
 *  aspect correction, fitted into a square. Start dot in the mark color;
 *  the path itself is neutral ink. */
function RouteOutline({ gps }: { gps: [number, number, number, number?][] }) {
  const geometry = useMemo(() => {
    if (gps.length < 2) return null;
    const lats = gps.map(p => p[1]);
    const lons = gps.map(p => p[2]);
    const latMid = (Math.min(...lats) + Math.max(...lats)) / 2;
    const kx = Math.cos((latMid * Math.PI) / 180);
    const xs = lons.map(lon => lon * kx);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...lats), yMax = Math.max(...lats);
    const size = 108, pad = 6;
    const scale = (size - 2 * pad) / Math.max(xMax - xMin, yMax - yMin, 1e-9);
    const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
    const pts = gps.map((p, i) => ({
      x: size / 2 + (xs[i] - cx) * scale,
      y: size / 2 - (p[1] - cy) * scale,
    }));
    return { size, path: pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(''), start: pts[0] };
  }, [gps]);

  if (!geometry) return null;
  return (
    <figure className="stream-chart stream-chart--route">
      <figcaption className="stream-chart__title">Route</figcaption>
      <svg viewBox={`0 0 ${geometry.size} ${geometry.size}`} className="stream-chart__route-svg" role="img" aria-label="GPS route outline">
        <path d={geometry.path} fill="none" stroke="var(--text-secondary)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={geometry.start.x} cy={geometry.start.y} r={3.5} fill={MARK} stroke="var(--bg-elevated)" strokeWidth={1.5} />
      </svg>
    </figure>
  );
}

export default function StreamCharts({ streams }: { streams: Streams }) {
  const hr = streams.hr ?? [];
  const elevation = useMemo(
    () => (streams.gps ?? [])
      .filter((p): p is [number, number, number, number] => typeof p[3] === 'number')
      .map(p => [p[0], p[3]] as [number, number]),
    [streams.gps],
  );

  const hasAny = hr.length > 1 || elevation.length > 1 || (streams.gps?.length ?? 0) > 1;
  if (!hasAny) return null;

  return (
    <div className="stream-charts">
      {hr.length > 1 && <TimeChart title="Heart rate" unit="bpm" data={hr} />}
      <div className="stream-charts__row">
        {streams.gps && streams.gps.length > 1 && <RouteOutline gps={streams.gps} />}
        {elevation.length > 1 && <TimeChart title="Elevation" unit="ft" data={elevation.map(([s, m]) => [s, m * 3.28084])} area />}
      </div>
    </div>
  );
}
