/** About TxUI — basic program info. */
import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
// The app's own icon, so the About box shows what the Dock shows.
// `penguin.png` was different artwork entirely — a flat penguin on a blue
// disc — which meant the two places the product identifies itself did not
// agree with each other. Served from public/ (the same 47 KB file the splash
// uses) instead of bundling a second 155 KB copy of the artwork (WP-15 15.5).
const appIcon = '/txui-icon.png';

interface Props { onClose: () => void }

export function AboutModal({ onClose }: Props) {
  // Real app version from the Tauri runtime (tauri.conf.json) — never hardcoded
  const [version, setVersion] = useState('');
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="cv-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="about-modal">
        <img className="about-logo" src={appIcon} alt="TxUI" />
        <h2>TxUI</h2>
        <div className="about-version">{version ? `v${version}` : ''}</div>
        <p className="about-desc">
          A fast, DBA-focused database GUI for MySQL / MariaDB / Percona,
          PostgreSQL and Redis. Processlist &amp; kill, replication and
          server dashboards, EXPLAIN visualization, SQL quality analysis,
          fleet-wide execution, schema comparison, audit logging — with a
          native Rust core built for speed.
        </p>
        <div className="about-meta">
          <span>Author: <b>Txe</b></span>
          <span>Built with Tauri · Rust · React</span>
        </div>
        <button className="primary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
