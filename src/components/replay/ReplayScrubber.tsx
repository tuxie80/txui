// Replay transport + draggable time handle.
//
// The scrubber distinguishes a *live* cursor (updated continuously while the
// user drags, driving only the cheap chart-cursor relayout) from a *committed*
// cursor (set on release / step, which triggers the one expensive per-second
// snapshot fetch). This is the same split rustie uses to keep 10× scrubbing
// from firing a query per pixel.

import { type CSSProperties, useEffect, useRef } from 'react';

interface Props {
  timestamps: string[];
  index: number;                 // committed cursor
  liveIndex: number;             // cursor while dragging (== index when not dragging)
  playing: boolean;
  speed: number;                 // steps per second
  onDrag: (index: number) => void;    // live, no fetch
  onCommit: (index: number) => void;  // release / step, triggers fetch
  onTogglePlay: () => void;
  onSpeed: (s: number) => void;
}

const SPEEDS = [1, 2, 5, 10, 30];

export function ReplayScrubber({
  timestamps, index, liveIndex, playing, speed, onDrag, onCommit, onTogglePlay, onSpeed,
}: Props) {
  const n = timestamps.length;
  const last = Math.max(0, n - 1);
  const dragging = useRef(false);

  // Keep latest values available to the play interval without resubscribing.
  // Refs are updated in an effect (not during render) per react-hooks/refs.
  const indexRef = useRef(index);
  const onTogglePlayRef = useRef(onTogglePlay);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    indexRef.current = index;
    onTogglePlayRef.current = onTogglePlay;
    onCommitRef.current = onCommit;
  });

  // Auto-advance while playing. Uses committed index so each tick loads a
  // snapshot; stops at the tail.
  useEffect(() => {
    if (!playing) return;
    const h = setInterval(() => {
      onCommitRef.current(Math.min(last, indexRef.current + 1));
      if (indexRef.current >= last) onTogglePlayRef.current();
    }, 1000 / speed);
    return () => clearInterval(h);
  }, [playing, speed, last]);

  const atStart = liveIndex <= 0;
  const atEnd = liveIndex >= last;
  // Always resolve to a valid timestamp — never blank, never out of bounds.
  const clamped = n === 0 ? 0 : Math.max(0, Math.min(last, liveIndex));
  const ts = n === 0 ? '—' : timestamps[clamped];
  const pct = last > 0 ? (clamped / last) * 100 : 0;

  return (
    <div className="rp-scrubber">
      <div className="rp-transport">
        <button className="rp-btn" title="Jump to start" disabled={atStart}
          onClick={() => onCommit(0)}>⏮</button>
        <button className="rp-btn" title="Step back (←)" disabled={atStart}
          onClick={() => onCommit(index - 1)}>◀</button>
        <button className="rp-btn rp-btn-play" title={playing ? 'Pause (space)' : 'Play (space)'}
          onClick={onTogglePlay}>{playing ? '⏸' : '▶'}</button>
        <button className="rp-btn" title="Step forward (→)" disabled={atEnd}
          onClick={() => onCommit(index + 1)}>▶</button>
        <button className="rp-btn" title="Jump to end" disabled={atEnd}
          onClick={() => onCommit(last)}>⏭</button>

        <select className="rp-speed" value={speed} title="Playback speed"
          onChange={e => onSpeed(Number(e.target.value))}>
          {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
        </select>
      </div>

      <input
        className="rp-range"
        type="range"
        min={0}
        max={last}
        value={clamped}
        style={{ '--rp-pct': `${pct}%` } as CSSProperties}
        onMouseDown={() => { dragging.current = true; }}
        onChange={e => {
          const i = Number(e.target.value);
          if (dragging.current) onDrag(i); else onCommit(i);
        }}
        onMouseUp={e => { dragging.current = false; onCommit(Number((e.target as HTMLInputElement).value)); }}
        onKeyUp={e => onCommit(Number((e.target as HTMLInputElement).value))}
      />

      <div className="rp-clock">
        <span className="rp-clock-ts">{ts}</span>
        <span className="rp-clock-pos">{n === 0 ? '0 / 0' : `${(clamped + 1).toLocaleString()} / ${n.toLocaleString()}`}</span>
      </div>
    </div>
  );
}
