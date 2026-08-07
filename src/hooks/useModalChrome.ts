import { useEffect, useRef } from 'react';

/**
 * The shared chrome of every full-screen overlay and modal: Escape invokes
 * the handler, and body scroll is locked while mounted. The handler is read
 * through a ref, so callers can pass an inline closure (with fresh state)
 * without re-running the effect.
 *
 * Note this is the same last-writer-wins body lock the callers each had —
 * refcounting it so stacked overlays unlock correctly is part of the Wave 2
 * router restructuring (#12).
 */
export function useModalChrome(onEscape: () => void) {
  const escapeRef = useRef(onEscape);
  useEffect(() => { escapeRef.current = onEscape; });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') escapeRef.current(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, []);
}
