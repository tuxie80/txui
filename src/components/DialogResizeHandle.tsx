import { useRef } from 'react';

export interface DialogSize { width: number; height: number }

interface Props {
  target: string;
  label: string;
  minWidth?: number;
  minHeight?: number;
  onResize: (size: DialogSize) => void;
}

export function DialogResizeHandle({ target, label, minWidth = 420, minHeight = 320, onResize }: Props) {
  const start = useRef<{ px: number; py: number; width: number; height: number } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLElement>) {
    const dialog = e.currentTarget.closest(target);
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();
    start.current = { px: e.clientX, py: e.clientY, width: rect.width, height: rect.height };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: React.PointerEvent<HTMLElement>) {
    const s = start.current;
    if (!s) return;
    const maxWidth = Math.max(280, window.innerWidth - 32);
    const maxHeight = Math.max(240, window.innerHeight - 32);
    onResize({
      width: Math.max(Math.min(minWidth, maxWidth), Math.min(maxWidth, s.width + e.clientX - s.px)),
      height: Math.max(Math.min(minHeight, maxHeight), Math.min(maxHeight, s.height + e.clientY - s.py)),
    });
  }

  function onPointerUp() { start.current = null; }

  return (
    <button type="button" className="dialog-resize-handle" title={label} aria-label={label}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>◢</button>
  );
}
