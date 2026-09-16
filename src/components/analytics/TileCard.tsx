import { useState } from 'react';
import { Copy, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import type { TileView } from '../../context/analytics';
import type { TileResult } from '../../lib/analytics/engine';
import TileRenderer from './TileRenderer';

// One dashboard tile: header (the drag handle), chart body, and the
// excluded-entries footnote. The kebab is a two-step delete — a dashboard
// tile is cheap to rebuild, but not cheap enough for a one-tap destroy.
//
// Since #152 the card does not compute anything: the grid asks the server
// for every tile at once (useTileResults) and hands each card its result.

interface Props {
  tile: TileView;
  /** undefined = this tile's compute call is still in flight. */
  result: TileResult | undefined;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export default function TileCard({ tile, result, onEdit, onDuplicate, onDelete }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const excluded = result?.ok ? result.data.excluded : null;
  const excludedCount = (excluded?.otherUnit ?? 0) + (excluded?.unparseable ?? 0);
  // A tile whose stored spec no longer validates is never sent to compute —
  // it renders its error tile immediately rather than waiting for a result.
  const pending = tile.spec !== null && result === undefined;

  const closeMenu = () => {
    setMenuOpen(false);
    setConfirmingDelete(false);
  };

  return (
    <div className="tile-card" data-testid={`tile-${tile.id}`}>
      <header className="tile-card__header">
        <span className="tile-card__title">{tile.title}</span>
        <div className="tile-card__menu-wrap">
          <button
            className="tile-card__menu-btn"
            aria-label={`Tile options: ${tile.title}`}
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          >
            <MoreVertical size={14} strokeWidth={1.5} />
          </button>
          {menuOpen && (
            <div className="tile-card__menu" role="menu">
              <button role="menuitem" onClick={() => { closeMenu(); onEdit(); }}>
                <Pencil size={13} strokeWidth={1.5} /> Edit
              </button>
              <button role="menuitem" onClick={() => { closeMenu(); onDuplicate(); }}>
                <Copy size={13} strokeWidth={1.5} /> Duplicate
              </button>
              <button
                role="menuitem"
                className="tile-card__menu-danger"
                onClick={() => {
                  if (!confirmingDelete) { setConfirmingDelete(true); return; }
                  closeMenu();
                  onDelete();
                }}
              >
                <Trash2 size={13} strokeWidth={1.5} /> {confirmingDelete ? 'Confirm delete' : 'Delete'}
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="tile-card__body">
        {pending
          ? <div className="an-loading" data-testid="tile-loading">Loading…</div>
          : <TileRenderer spec={tile.spec} result={result ?? null} />}
      </div>
      {excludedCount > 0 && (
        <div className="tile-card__foot" title="Entries whose units could not join this chart — mixed units or unparseable text.">
          {excludedCount} entr{excludedCount === 1 ? 'y' : 'ies'} excluded
        </div>
      )}
    </div>
  );
}
