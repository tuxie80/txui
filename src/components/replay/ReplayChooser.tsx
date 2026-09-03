// Shown when a picked SQLite file fingerprints as a Dolphie recording: asks the
// user how to open it — the time-scrubbed Replay dashboard, or the raw SQLite
// browser — rather than deciding for them. This is the "give the user options"
// entry point; neither choice is taken until they click.

import type { ReplayProbe } from '../../lib/replay';
import './replay.css';

interface Props {
  probe: ReplayProbe;
  onReplay: () => void;
  onRaw: () => void;
}

export function ReplayChooser({ probe, onReplay, onRaw }: Props) {
  const m = probe.metadata;
  const span = probe.first_timestamp && probe.last_timestamp
    ? `${probe.first_timestamp} → ${probe.last_timestamp}` : null;

  return (
    <div className="rp-root rp-center">
      <div className="rp-chooser">
        <div className="rp-chooser-badge">⏱ Dolphie recording detected</div>
        <div className="rp-chooser-meta">
          {m && <span className="rp-host">{m.host}:{m.port}</span>}
          {m && <span className="rp-dim">{m.host_distro} · dolphie {m.dolphie_version}</span>}
          <span className="rp-count">{probe.snapshot_count.toLocaleString()} snapshots</span>
          {span && <span className="rp-dim">{span}</span>}
        </div>
        <p className="rp-chooser-q">How do you want to open this file?</p>
        <div className="rp-chooser-actions">
          <button className="rp-choice rp-choice-primary" onClick={onReplay}>
            <span className="rp-choice-title">⏱ Replay dashboard</span>
            <span className="rp-choice-sub">Time-scrubbed panels, graphs & processlist over the recording</span>
          </button>
          <button className="rp-choice" onClick={onRaw}>
            <span className="rp-choice-title">🗃️ Raw SQLite</span>
            <span className="rp-choice-sub">Browse the underlying tables (replay_data, metadata…)</span>
          </button>
        </div>
        <div className="rp-chooser-hint">You can switch either way at any time from the header.</div>
      </div>
    </div>
  );
}
