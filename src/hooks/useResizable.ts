/**
 * Drag-resize hook: returns [size, startDrag]. Size persists to localStorage.
 * axis 'x' → horizontal drag changes width; 'y' → vertical drag changes height.
 * `invert` flips drag direction (for handles on the leading edge).
 */
import { useCallback, useRef, useState } from 'react';

export function useResizable(
  storageKey: string,
  initial: number,
  min: number,
  max: number,
  axis: 'x' | 'y' = 'x',
  invert = false,
): [number, (e: React.MouseEvent) => void] {
  const [size, setSize] = useState<number>(() => {
    const raw = Number(localStorage.getItem(storageKey));
    return Number.isFinite(raw) && raw >= min && raw <= max ? raw : initial;
  });
  const sizeRef = useRef(size);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const startSize = sizeRef.current;
    // One state commit per animation frame, holding the latest size (the
    // FastGrid scroll handler's pattern): mousemoves arrive faster than
    // frames, and every commit re-renders the whole workspace — committing
    // per event spends the frame budget several times over for the duration
    // of the drag.
    let raf = 0;
    const onMove = (ev: MouseEvent) => {
      const delta = ((axis === 'x' ? ev.clientX : ev.clientY) - start) * (invert ? -1 : 1);
      const next = Math.min(max, Math.max(min, startSize + delta));
      sizeRef.current = next;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          setSize(sizeRef.current);
        });
      }
    };
    const onUp = () => {
      // The exact final size lands synchronously — a coalesced frame must
      // never be what persists to localStorage.
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      setSize(sizeRef.current);
      try { localStorage.setItem(storageKey, String(Math.round(sizeRef.current))); } catch { /* quota */ }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [storageKey, min, max, axis, invert]);

  return [size, startDrag];
}
