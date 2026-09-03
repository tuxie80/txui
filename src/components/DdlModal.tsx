import { useEffect, useRef } from 'react';

interface Props {
  title: string;
  sql: string;
  onClose: () => void;
  onInsert?: () => void;
}

export function DdlModal({ title, sql, onClose, onInsert }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">DDL — {title}</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <pre className="modal-code">{sql}</pre>
        <div className="modal-footer">
          <button onClick={() => navigator.clipboard.writeText(sql)}>Copy</button>
          {onInsert && <button className="primary" onClick={onInsert}>Insert into editor</button>}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
