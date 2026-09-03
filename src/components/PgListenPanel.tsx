/**
 * `LISTEN` / `NOTIFY` — watching a PostgreSQL channel.
 *
 * The one item on the gap list with no workaround from a query window:
 * `LISTEN` needs a connection that stays put and something waiting on it, and
 * a request-response query cannot provide either. The backend holds a
 * dedicated connection and pushes notifications over a Tauri channel.
 *
 * Because that connection sits outside the pool, stopping matters. The panel
 * stops its listener when it unmounts as well as when the button is pressed —
 * a held connection outliving the panel is a leak the user cannot see, and on
 * a server with a connection limit it eventually costs an outage.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import type { Session } from '../types';
import { errorDisplay } from '../utils/appError';
import { clearTabActivities, panelTabKey, setActivity } from '../store/tabActivity';

type ListenEvent =
  | { type: 'Listening'; channels: string[] }
  | { type: 'Notification'; channel: string; payload: string; atMs: number }
  | { type: 'Closed'; reason: string };

interface Note { channel: string; payload: string; atMs: number; seq: number }

interface Props {
  session: Session;
  onClose: () => void;
}

/** Kept in memory only. A notification stream is unbounded by nature. */
const MAX_NOTES = 500;

export function PgListenPanel({ session, onClose }: Props) {
  const [channels, setChannels] = useState('');
  const [state, setState] = useState<'idle' | 'starting' | 'live' | 'closed'>('idle');
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [testPayload, setTestPayload] = useState('{"hello":"world"}');
  const tokenRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const supported = session.engine === 'postgres';

  const stop = useCallback(async () => {
    const t = tokenRef.current;
    tokenRef.current = null;
    if (t) await invoke('pg_listen_stop', { token: t }).catch(() => {});
    setState(s => (s === 'live' || s === 'starting' ? 'idle' : s));
  }, []);

  // Stop on unmount as well as on the button — see the note at the top.
  useEffect(() => () => {
    const t = tokenRef.current;
    if (t) void invoke('pg_listen_stop', { token: t }).catch(() => {});
  }, []);

  // A live LISTEN holds a dedicated connection outside the pool — the close
  // guard and the status-bar popover must be able to name it, and stop it.
  const activityKey = panelTabKey(session.sessionId, 'pglisten');
  useEffect(() => {
    if (state !== 'live' && state !== 'starting') { clearTabActivities(activityKey); return; }
    const list = channels.split(',').map(c => c.trim()).filter(Boolean);
    setActivity(activityKey, {
      id: 'listen',
      label: state === 'live' ? 'LISTEN active' : 'LISTEN connecting',
      detail: `LISTEN ${list.join(', ')}`,
      // The panel stops the listener when it unmounts, so nothing outlives it.
      survives: false,
      kill: () => { void stop(); },
    });
  }, [activityKey, state, channels, stop]);

  const start = useCallback(async () => {
    const list = channels.split(',').map(c => c.trim()).filter(Boolean);
    if (!list.length) { setError('Name at least one channel.'); return; }
    await stop();
    setError(null);
    setState('starting');
    const token = crypto.randomUUID();
    const onEvent = new Channel<ListenEvent>();
    onEvent.onmessage = ev => {
      if (ev.type === 'Listening') { setState('live'); return; }
      if (ev.type === 'Closed') {
        setState('closed');
        setError(`The listening connection closed: ${ev.reason}`);
        tokenRef.current = null;
        return;
      }
      setNotes(prev => {
        const next = [{ ...ev, seq: seqRef.current++ }, ...prev];
        return next.length > MAX_NOTES ? next.slice(0, MAX_NOTES) : next;
      });
    };
    try {
      tokenRef.current = token;
      await invoke('pg_listen_start', {
        sessionId: session.sessionId, token, channels: list, onEvent,
      });
    } catch (e) {
      tokenRef.current = null;
      setState('idle');
      setError(errorDisplay(e));
    }
  }, [channels, session.sessionId, stop]);

  /** Send one, so the round trip can be proved without a second client. */
  const notify = useCallback(async () => {
    const first = channels.split(',').map(c => c.trim()).filter(Boolean)[0];
    if (!first) return;
    try {
      await invoke('pg_notify', {
        sessionId: session.sessionId, channel: first, payload: testPayload,
      });
    } catch (e) {
      setError(errorDisplay(e));
    }
  }, [channels, testPayload, session.sessionId]);

  const clock = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  return (
    <div className="proc-panel">
      <div className="proc-toolbar">
        <span className="proc-title">📡 Listen / Notify</span>
        <input
          className="fif-input"
          value={channels}
          placeholder="channel, another_channel"
          disabled={state === 'live' || state === 'starting'}
          onChange={e => setChannels(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && state === 'idle') void start(); }}
        />
        {state === 'live' || state === 'starting' ? (
          <button className="toolbar-btn td-danger" onClick={() => void stop()}>Stop</button>
        ) : (
          <button className="toolbar-btn" onClick={() => void start()} disabled={!supported}>Listen</button>
        )}
        <span className={`pgl-state pgl-${state}`}>
          {state === 'live' ? '● live' : state === 'starting' ? '… connecting' : state === 'closed' ? '● closed' : 'idle'}
        </span>
        <div style={{ flex: 1 }} />
        <span className="dv-desc">{notes.length} received</span>
        <button className="toolbar-btn" onClick={() => setNotes([])} disabled={!notes.length}>Clear</button>
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      {!supported && (
        <div className="db-error">LISTEN / NOTIFY is a PostgreSQL feature.</div>
      )}
      {error && <div className="proc-error-bar">{error}</div>}

      {supported && state === 'live' && (
        <div className="pgl-send">
          <span className="dv-desc">Send one to the first channel, to prove the round trip:</span>
          <input className="fif-input" value={testPayload} onChange={e => setTestPayload(e.target.value)} />
          <button className="toolbar-btn" onClick={() => void notify()}>Notify</button>
        </div>
      )}

      {supported && state === 'idle' && !notes.length && (
        <div className="db-error">
          Name a channel and press Listen. A quiet channel and a channel that never started look
          identical, so the state above says which.
        </div>
      )}

      <div className="fif-results">
        {notes.map(n => (
          <div key={n.seq} className="pgl-note">
            <span className="pgl-time">{clock(n.atMs)}</span>
            <span className="pgl-chan">{n.channel}</span>
            <span className="pgl-payload">{n.payload || <em>(empty)</em>}</span>
          </div>
        ))}
        {notes.length >= MAX_NOTES && (
          <div className="dv-desc" style={{ padding: 8 }}>
            Showing the most recent {MAX_NOTES}. Older notifications are discarded — this is a live
            view, not a log.
          </div>
        )}
      </div>
    </div>
  );
}
