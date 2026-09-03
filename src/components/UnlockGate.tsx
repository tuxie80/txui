/**
 * Startup gate.
 *
 * By default there is no encrypted vault (plain mode) — connections and their
 * (machine-obfuscated) secrets are on disk and the app opens straight away, so
 * this renders nothing. It only steps in when the user has turned the **Safe
 * Vault** on (Settings → Secure): then everything is in one encrypted file and
 * there is genuinely nothing to show until it is unlocked.
 *
 * Enabling/disabling the vault lives in Settings, not here — the first run is
 * no longer a password wall.
 */
import { errorDisplay } from '../utils/appError';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type VaultState = 'plain' | 'locked' | 'unlocked';
interface Status { state: VaultState; path: string }

export function UnlockGate({ onOpened }: { onOpened: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<Status>('vault_status')
      .then(s => {
        setStatus(s);
        // Plain (default) and an already-open vault both mean "let the app load
        // its connections now".
        if (s.state === 'plain' || s.state === 'unlocked') onOpened();
      })
      // If even the status cannot be read there is nothing useful to gate on;
      // let the app through and let it report its own errors.
      .catch(() => { setStatus({ state: 'unlocked', path: '' }); onOpened(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { inputRef.current?.focus(); }, [status?.state]);

  // Nothing to gate unless a vault exists and is still locked.
  if (!status || status.state !== 'locked') return null;

  const ready = pw.length > 0;
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke('vault_unlock', { password: pw });
      setPw('');
      setStatus({ ...status, state: 'unlocked' });
      onOpened();
    } catch (e) {
      setError(errorDisplay(e));
      inputRef.current?.select();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="unlock-overlay">
      <div className="unlock-card">
        <div className="unlock-title">🔒 Locked</div>
        <p className="unlock-detail">
          Safe Vault is on: your connections and their passwords are in one encrypted file.
          Nothing can be listed or opened until it is unlocked; the password is held in memory
          for this run only.
        </p>
        <input
          ref={inputRef}
          type="password"
          placeholder="Password"
          value={pw}
          onChange={e => setPw(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
        />
        {error && <div className="unlock-error">{error}</div>}
        <button className="unlock-btn" disabled={busy || !ready} onClick={submit}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        <p className="unlock-hint">File: {status.path}</p>
      </div>
    </div>
  );
}
