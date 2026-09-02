import { useCallback, useMemo, useRef, useState } from 'react';
import { GridLayout, type Layout, type LayoutItem } from 'react-grid-layout';
import { Plus, X } from 'lucide-react';
import 'react-grid-layout/css/styles.css';
import { useCalendar } from '../../context/calendar';
import { useAnalytics } from '../../context/analytics';
import { useAnalyticsData } from '../../hooks/useAnalyticsData';
import { useModalChrome } from '../../hooks/useModalChrome';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { mintTileId, type AnalyticsTile } from '../../lib/analytics/tiles';
import type { ChartSpec } from '../../lib/analytics/spec';
import TileCard from './TileCard';
import TileBuilder from './TileBuilder';

// The analytics dashboard: a full-screen overlay (the library-view shell)
// holding a drag-and-resize grid of saved chart tiles. Desktop gets the real
// grid (react-grid-layout, 12 columns); phones get the tiles as a stacked
// list ordered by grid position — drag/resize is a pointer-and-space
// affordance. Internal mode union, the BlocksView pattern:
//   { kind: 'grid' } | { kind: 'edit', tile | null }
// Layout commits are debounced after the last drag/resize settles and write
// only the tiles that moved.

type Mode = { kind: 'grid' } | { kind: 'edit'; tile: AnalyticsTile | null };

const GRID_CONFIG = { cols: 12, rowHeight: 56, margin: [12, 12] as [number, number] };
const LAYOUT_COMMIT_MS = 600;

/**
 * Container width via a CALLBACK ref, not the library's useContainerWidth:
 * that hook observes only the node present at mount, and this view swaps its
 * whole body out for the tile builder — on the way back the new container
 * was never observed and the grid rendered at width 0. A callback ref
 * re-observes every attach; 0-width readings from detached nodes are noise
 * and ignored.
 */
function useMeasuredWidth(): [number, (node: HTMLDivElement | null) => void] {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    setWidth(Math.round(node.getBoundingClientRect().width));
    const observer = new ResizeObserver(entries => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);
  return [width, ref];
}

export default function AnalyticsView() {
  const { dispatch } = useCalendar();
  const { tiles, isLoading, saveTile, saveLayouts, removeTile } = useAnalytics();
  const [mode, setMode] = useState<Mode>({ kind: 'grid' });
  const isMobile = useMediaQuery('(max-width: 768px)');

  const close = useCallback(() => dispatch({ type: 'CLOSE_ANALYTICS' }), [dispatch]);
  useModalChrome(() => {
    if (mode.kind === 'edit') setMode({ kind: 'grid' });
    else close();
  });

  const specs = useMemo(
    () => tiles.map(t => t.spec).filter((s): s is ChartSpec => s !== null),
    [tiles],
  );
  const data = useAnalyticsData(specs);

  const [width, measureRef] = useMeasuredWidth();

  const layout: Layout = useMemo(
    () => tiles.map(t => ({ i: t.id, ...t.layout, minW: 2, minH: 2, maxH: 24 })),
    [tiles],
  );

  // Commit the layout only after the user lets go — onLayoutChange also
  // fires for programmatic reflows, so the pending flag scopes writes to
  // real drags/resizes.
  const pendingLayout = useRef<Layout | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLayoutChange = useCallback((next: Layout) => {
    pendingLayout.current = next;
  }, []);
  const commitLayout = useCallback(() => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      const next = pendingLayout.current;
      if (!next) return;
      const changed = next.filter((item: LayoutItem) => {
        const tile = tiles.find(t => t.id === item.i);
        return tile && (
          tile.layout.x !== item.x || tile.layout.y !== item.y ||
          tile.layout.w !== item.w || tile.layout.h !== item.h
        );
      });
      if (changed.length) {
        saveLayouts(changed.map(item => ({ id: item.i, x: item.x, y: item.y, w: item.w, h: item.h })));
      }
      pendingLayout.current = null;
    }, LAYOUT_COMMIT_MS);
  }, [tiles, saveLayouts]);

  const duplicate = useCallback((tile: AnalyticsTile) => {
    if (!tile.spec) return;
    const spec: ChartSpec = { ...tile.spec, title: `${tile.spec.title} (copy)` };
    const y = tiles.reduce((max, t) => Math.max(max, t.layout.y + t.layout.h), 0);
    saveTile(mintTileId(), spec, { ...tile.layout, x: 0, y });
  }, [tiles, saveTile]);

  const sortedForMobile = useMemo(
    () => [...tiles].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x),
    [tiles],
  );

  if (mode.kind === 'edit') {
    return (
      <div className="analytics-view" data-testid="analytics-view">
        <TileBuilder tile={mode.tile} onClose={() => setMode({ kind: 'grid' })} />
      </div>
    );
  }

  return (
    <div className="analytics-view" data-testid="analytics-view">
      <header className="library-header">
        <div className="library-header__titles">
          <h1 className="library-header__title">Analytics</h1>
          <span className="library-header__count">{tiles.length} tile{tiles.length === 1 ? '' : 's'}</span>
        </div>
        <div className="library-header__actions">
          <button
            className="library-edit-btn"
            data-testid="analytics-new-tile"
            onClick={() => setMode({ kind: 'edit', tile: null })}
          >
            <Plus size={13} strokeWidth={1.5} /> New tile
          </button>
          <button className="library-close" onClick={close} aria-label="Close analytics">
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="analytics-body" ref={measureRef}>
        {tiles.length === 0 ? (
          <div className="library-empty analytics-empty" data-testid="analytics-empty">
            {isLoading ? 'Loading tiles…' : 'No tiles yet — build your first chart with “New tile”.'}
          </div>
        ) : isMobile ? (
          <div className="analytics-stack">
            {sortedForMobile.map(tile => (
              <div key={tile.id} className="analytics-stack__item">
                <TileCard
                  tile={tile}
                  data={data}
                  onEdit={() => setMode({ kind: 'edit', tile })}
                  onDuplicate={() => duplicate(tile)}
                  onDelete={() => removeTile(tile.id)}
                />
              </div>
            ))}
          </div>
        ) : width > 0 ? (
          <GridLayout
            width={width}
            layout={layout}
            gridConfig={GRID_CONFIG}
            dragConfig={{ handle: '.tile-card__header' }}
            onLayoutChange={onLayoutChange}
            onDragStop={commitLayout}
            onResizeStop={commitLayout}
            className="analytics-grid"
          >
            {tiles.map(tile => (
              <div key={tile.id}>
                <TileCard
                  tile={tile}
                  data={data}
                  onEdit={() => setMode({ kind: 'edit', tile })}
                  onDuplicate={() => duplicate(tile)}
                  onDelete={() => removeTile(tile.id)}
                />
              </div>
            ))}
          </GridLayout>
        ) : null}
      </div>
    </div>
  );
}
