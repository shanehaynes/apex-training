import type { TargetAttainment } from '../../lib/blocks/progress';

// Attainment bars. Deliberately plain CSS rather than Recharts: these are
// single-value meters, not a chart, and a bar per target reads better at the
// width the overlay gives them.

function pctLabel(a: TargetAttainment): string {
  return a.pct === null ? '—' : `${Math.round(a.pct * 100)}%`;
}

function format(value: number): string {
  return (Math.round(value * 10) / 10).toLocaleString('en-US');
}

export default function BlockProgressBars({
  attainment,
  emptyLabel = 'No targets set for this block.',
}: {
  attainment: TargetAttainment[];
  emptyLabel?: string;
}) {
  if (attainment.length === 0) {
    return <p className="block-empty">{emptyLabel}</p>;
  }

  return (
    <ul className="block-bars">
      {attainment.map(a => {
        // Bars cap at 100% width; over-attainment is shown by the number and
        // a modifier class, so a 300% week doesn't blow out the layout.
        const shown = a.pct === null ? 0 : Math.round(a.pct * 100);
        const width = Math.min(100, shown);
        // Keyed off the ROUNDED percentage so the colour never contradicts the
        // label — 1,195/1,200 reads "100%" and must not be styled as a miss.
        const state = shown >= 100 ? 'met' : shown >= 85 ? 'close' : 'under';
        return (
          <li key={a.key} className="block-bar">
            <div className="block-bar__head">
              <span className="block-bar__label">
                {a.label}
                {a.source === 'derived' && (
                  <span className="block-bar__derived" title="No target set — derived from what's on the calendar">
                    calendar
                  </span>
                )}
              </span>
              <span className="block-bar__value">
                {format(a.actual)} / {format(a.targetForWindow)}
                {a.unit ? ` ${a.unit}` : ''}
                <span className={`block-bar__pct block-bar__pct--${state}`}>{pctLabel(a)}</span>
              </span>
            </div>
            <div className="block-bar__track">
              <div className={`block-bar__fill block-bar__fill--${state}`} style={{ width: `${width}%` }} />
            </div>
            {a.unmatchedUnits && (
              // Never silently converted — the repo does not convert units.
              <p className="block-bar__note">
                Also logged:{' '}
                {Object.entries(a.unmatchedUnits).map(([unit, value]) => `${format(value)} ${unit}`).join(', ')}
                {' '}— not counted, different unit.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
