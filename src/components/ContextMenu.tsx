import { useEffect, useRef } from 'react';

interface Props {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}

export function ContextMenu({ x, y, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp to viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 180),
    top:  Math.min(y, window.innerHeight - 200),
    zIndex: 1000,
  };

  return (
    <div ref={ref} className="context-menu" style={style}>
      {children}
    </div>
  );
}

interface ItemProps {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export function ContextMenuItem({ label, onClick, danger }: ItemProps) {
  return (
    <div
      className={`context-menu-item${danger ? ' danger' : ''}`}
      onClick={onClick}
    >
      {label}
    </div>
  );
}
