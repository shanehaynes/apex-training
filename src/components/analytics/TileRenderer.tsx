import {
  Area, AreaChart, Bar, BarChart, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { RenderedSeries, TileData, TileResult } from '../../lib/analytics/engine';
import { seriesColors } from '../../lib/analytics/palette';
import type { ChartSpec } from '../../lib/analytics/spec';

// Computed tile data → chart, house style throughout (ExerciseDetail's
// recharts conventions: no axis/tick lines, muted 10px ticks, 1.5px strokes,
// no animation, .chart-tooltip). Every number comes from computeTile — the
// caller memoizes that (useMemo over spec + inputs) so the card around the
// chart can also read the excluded counts. Invalid specs and compute
// problems render an error tile — never a crash, never a half-chart.

interface Props {
  spec: ChartSpec | null;
  /** computeTile output; null when the stored spec failed validation. */
  result: TileResult | null;
}

const TICK = { fill: '#8a7f7c', fontSize: 10 } as const;

/** '—' for missing; ≥1000 rounds whole with separators; else one decimal, trimmed. */
function fmt(v: number | null | undefined): string {
  if (v == null) return '—';
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
  return String(Math.round(v * 10) / 10);
}

function seriesUnitLabel(s: RenderedSeries): string {
  return s.unit ? ` ${s.unit}` : '';
}

interface ChartRecord {
  key: string;
  label: string;
  [value: `v${number}`]: number | null;
}

function toRecords(data: TileData): ChartRecord[] {
  return data.buckets.map((b, i) => {
    const record: ChartRecord = { key: b.key, label: b.label };
    data.series.forEach((s, si) => { record[`v${si}`] = s.points[i]; });
    return record;
  });
}

function TileTooltip({ active, payload, data, colors }: {
  active?: boolean;
  payload?: Array<{ payload: ChartRecord }>;
  data: TileData;
  colors: string[];
}) {
  if (!active || !payload?.length) return null;
  const record = payload[0].payload;
  const bucketIndex = data.buckets.findIndex(b => b.key === record.key);
  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip__week">{record.label || data.rangeLabel}</p>
      {data.series.map((s, si) => {
        const gradeLabel = s.gradeLabels?.[bucketIndex];
        return (
          <p key={s.key} className="chart-tooltip__count">
            <span className="tile-tooltip__dot" style={{ background: colors[si] }} />
            {s.label}: {gradeLabel ?? `${fmt(record[`v${si}`])}${seriesUnitLabel(s)}`}
          </p>
        );
      })}
    </div>
  );
}

export default function TileRenderer({ spec, result }: Props) {
  if (!spec || !result) {
    return <div className="tile-problem">This tile's saved configuration is no longer valid. Edit it to rebuild.</div>;
  }
  if (!result.ok) {
    return <div className="tile-problem">{result.problem}</div>;
  }

  const tile = result.data;
  const colors = seriesColors(tile.series);
  const records = toRecords(tile);
  const hasRight = tile.series.some(s => s.axis === 'right');
  const gradeChart = tile.series.some(s => s.unitKind === 'grade');
  const legend = tile.series.length > 1 && (
    <div className="tile-legend">
      {tile.series.map((s, si) => (
        <span key={s.key} className="tile-legend__item">
          <span className="tile-legend__dot" style={{ background: colors[si] }} />
          {s.label}
        </span>
      ))}
    </div>
  );

  if (spec.chartType === 'kpi') {
    return (
      <div className="tile-kpis">
        {tile.series.map((s, si) => (
          <div key={s.key} className="tile-kpi">
            <span className="tile-kpi__label">{s.label}</span>
            <span className="tile-kpi__value" style={{ color: colors[si] }}>
              {s.gradeLabels?.[0] ?? fmt(s.points[0])}
              {!s.gradeLabels?.[0] && s.unit ? <em>{s.unit}</em> : null}
            </span>
            <span className="tile-kpi__sub">{tile.rangeLabel}</span>
          </div>
        ))}
      </div>
    );
  }

  if (spec.chartType === 'table') {
    return (
      <div className="tile-table-wrap">
        <table className="tile-table">
          <thead>
            <tr>
              <th />
              {tile.series.map(s => <th key={s.key}>{s.label}{seriesUnitLabel(s)}</th>)}
            </tr>
          </thead>
          <tbody>
            {records.map((r, i) => (
              <tr key={r.key}>
                <td>{r.label || tile.rangeLabel}</td>
                {tile.series.map((s, si) => (
                  <td key={s.key}>{s.gradeLabels?.[i] ?? fmt(r[`v${si}`])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const axes = (
    <>
      <XAxis dataKey="label" tick={TICK} axisLine={false} tickLine={false} minTickGap={24} />
      <YAxis
        yAxisId="left"
        tick={gradeChart ? false : TICK}
        axisLine={false}
        tickLine={false}
        width={gradeChart ? 8 : 42}
        domain={['auto', 'auto']}
      />
      {hasRight && (
        <YAxis yAxisId="right" orientation="right" tick={TICK} axisLine={false} tickLine={false} width={42} domain={['auto', 'auto']} />
      )}
    </>
  );
  const tooltip = (
    <Tooltip content={<TileTooltip data={tile} colors={colors} />} cursor={{ stroke: 'rgba(255,255,255,0.1)' }} />
  );

  const chart =
    spec.chartType === 'bar' || spec.chartType === 'stacked-bar' ? (
      <BarChart data={records} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {axes}
        {tooltip}
        {tile.series.map((s, si) => (
          <Bar
            key={s.key}
            yAxisId={s.axis}
            dataKey={`v${si}`}
            fill={colors[si]}
            isAnimationActive={false}
            {...(spec.chartType === 'stacked-bar' ? { stackId: 'stack' } : {})}
          />
        ))}
      </BarChart>
    ) : spec.chartType === 'area' ? (
      <AreaChart data={records} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {axes}
        {tooltip}
        {tile.series.map((s, si) => (
          <Area
            key={s.key}
            yAxisId={s.axis}
            dataKey={`v${si}`}
            stroke={colors[si]}
            fill={colors[si]}
            fillOpacity={0.18}
            strokeWidth={1.5}
            isAnimationActive={false}
            connectNulls
          />
        ))}
      </AreaChart>
    ) : (
      <LineChart data={records} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {axes}
        {tooltip}
        {tile.series.map((s, si) => (
          <Line
            key={s.key}
            yAxisId={s.axis}
            type="monotone"
            dataKey={`v${si}`}
            stroke={colors[si]}
            strokeWidth={1.5}
            dot={records.length <= 60 ? { r: 2, fill: colors[si], strokeWidth: 0 } : false}
            activeDot={{ r: 3.5 }}
            isAnimationActive={false}
            connectNulls
          />
        ))}
      </LineChart>
    );

  return (
    <div className="tile-chart">
      {legend}
      <div className="tile-chart__plot">
        <ResponsiveContainer width="100%" height="100%">
          {chart}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
