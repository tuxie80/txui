/**
 * Settings → Security. One file, one password — so this panel is short.
 *
 * It says where the file is, lets you change the password, lock without
 * quitting, and move the whole setup to another machine. A copy of the vault
 * IS the backup and IS the export: there is only one format, so a file written
 * here opens on any machine and any platform.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { basename } from '../utils/platform';

type VaultState = 'plain' | 'locked' | 'unlocked';
interface Status {
  state: VaultState;
  path: string;
  connections: number;
  secrets: number;
}
interface ImportSummary { connections: number; secrets: number; folders: number }

/** Matches what the vault format enforces. */
const MIN_PASSWORD = 8;

export function SecurityPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState<null | 'change' | 'export' | 'import' | 'enable' | 'disable'>(null);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [importPath, setImportPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await invoke<Status>('vault_status')); }
    catch (e) { setError(errorDisplay(e)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = useCallback(async (fn: () => Promise<string | null>) => {
    setBusy(true); setError(null); setNote(null);
    try {
      const msg = await fn();
      if (msg) setNote(msg);
      setForm(null); setPw1(''); setPw2(''); setImportPath(null);
    } catch (e) {
      setError(errorDisplay(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [refresh]);

  if (!status) {
    return (
      <section className="settings-section">
        <h3>Security</h3>
        <p className="settings-hint">{error ?? 'Reading the vault…'}</p>
      </section>
    );
  }

  const vaultOn = status.state !== 'plain';
  const open = status.state === 'unlocked';

  return (
    <section className="settings-section">
      <h3>Security</h3>

      <div className={`sec-status${vaultOn && !open ? ' sec-locked' : ''}`}>
        <div className="sec-status-head">
          <span className="sec-status-title">
            {open ? 'Safe Vault — open' : status.state === 'locked' ? 'Safe Vault — locked' : 'Safe Vault — off'}
          </span>
          <span className="sec-chip">{status.connections} connection{status.connections === 1 ? '' : 's'}</span>
          {vaultOn && open && <span className="sec-chip">{status.secrets} secret{status.secrets === 1 ? '' : 's'}</span>}
        </div>
        {vaultOn ? (
          <>
            <p className="sec-protects">
              Your connections, their passwords and your folder tree are in one encrypted file,
              saved automatically on every change. Without the password the file reveals nothing —
              not even which servers you have.
            </p>
            <p className="sec-meta">{status.path}</p>
            <ul className="sec-warnings">
              <li>
                While the vault is open, anything running as you can read what this app can read.
                Lock it when you step away.
              </li>
            </ul>
          </>
        ) : (
          <>
            <p className="sec-protects">
              Connections and passwords are stored <strong>unencrypted</strong> on this disk — the
              common default, with no password prompt at startup. Passwords are lightly obfuscated
              (scrambled with a per-machine key) so a casual look at the file or a synced backup
              doesn&rsquo;t show them in the clear, but that is <strong>not real protection</strong>.
              Turn on Safe Vault below to require a master password.
            </p>
            <p className="sec-meta">{status.path.replace(/vault\.txui$/, '') || 'this machine'}</p>
          </>
        )}
      </div>

      {error && <div className="sec-error">{error}</div>}
      {note && <div className="sec-note">{note}</div>}

      <div className="sec-block">
        <div className="sec-block-title">Safe Vault</div>
        <label className="sec-toggle">
          <input
            type="checkbox"
            checked={vaultOn}
            disabled={busy || status.state === 'locked'}
            onChange={e => { setError(null); setNote(null); setPw1(''); setPw2(''); setForm(e.target.checked ? 'enable' : 'disable'); }}
          />
          <span>Encrypt everything with a master password</span>
        </label>
        <p className="sec-option-blurb">
          {vaultOn
            ? 'On: one encrypted file, unlocked with your password once each time the app starts.'
            : 'Off (default): stored unencrypted, no prompt. Turning this on creates the encrypted vault and moves your existing connections into it.'}
          {status.state === 'locked' && ' Unlock the vault first to change this.'}
        </p>

        {form === 'enable' && (
          <Form
            title="Turn on Safe Vault"
            hint={`Pick a master password (at least ${MIN_PASSWORD} characters). You'll enter it once each start. There is no recovery — if you forget it, the file cannot be opened by anyone.`}
            first={`Master password (at least ${MIN_PASSWORD})`}
            second="Repeat password"
            ready={pw1.length >= MIN_PASSWORD && pw1 === pw2}
            problem={pw2.length > 0 && pw1 !== pw2 ? 'The two passwords do not match.'
              : pw1.length > 0 && pw1.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : null}
            {...{ busy, pw1, pw2, setPw1, setPw2 }}
            onCancel={() => { setForm(null); setPw1(''); setPw2(''); }}
            onSubmit={() => act(async () => {
              const carried = await invoke<number>('vault_create', { password: pw1 });
              window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
              return `Safe Vault is on. ${carried} connection${carried === 1 ? '' : 's'} moved into the encrypted file.`;
            })}
          />
        )}

        {form === 'disable' && (
          <Form
            title="Turn off Safe Vault"
            hint="This decrypts everything back to plain files on this disk. Your passwords will be stored UNENCRYPTED (lightly obfuscated) afterwards. Enter your current master password to confirm."
            first="Current master password"
            ready={pw1.length > 0}
            {...{ busy, pw1, pw2, setPw1, setPw2 }}
            onCancel={() => { setForm(null); setPw1(''); }}
            onSubmit={() => act(async () => {
              await invoke('vault_disable', { password: pw1 });
              window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
              return 'Safe Vault is off. Secrets are now stored unencrypted on this disk.';
            })}
          />
        )}
      </div>

      {vaultOn && (<>
      <div className="sec-block">
        <div className="sec-block-title">Password</div>
        <div className="sec-row">
          <button className="toolbar-btn" disabled={busy || !open} onClick={() => setForm('change')}>
            Change password
          </button>
          <button
            className="toolbar-btn"
            disabled={busy || !open}
            title="Close the vault without quitting — connections stay shut until it is reopened"
            onClick={() => act(async () => { await invoke('vault_lock'); return 'Locked.'; })}
          >Lock now</button>
        </div>
        {form === 'change' && (
          <Form
            title="Change the vault password"
            hint="The file is re-encrypted under the new one. There is no recovery."
            first="Current password"
            second={`New password (at least ${MIN_PASSWORD} characters)`}
            ready={pw1.length > 0 && pw2.length >= MIN_PASSWORD}
            problem={pw2.length > 0 && pw2.length < MIN_PASSWORD
              ? `Use at least ${MIN_PASSWORD} characters.` : null}
            {...{ busy, pw1, pw2, setPw1, setPw2 }}
            onCancel={() => { setForm(null); setPw1(''); setPw2(''); }}
            onSubmit={() => act(async () => {
              await invoke('vault_change_password', { current: pw1, next: pw2 });
              return 'Password changed.';
            })}
          />
        )}
      </div>

      <div className="sec-block">
        <div className="sec-block-title">Another machine</div>
        <p className="sec-option-blurb">
          A copy of the vault is both the backup and the export — same format, so it opens on any
          machine and any platform. Give it a different password if it is going to travel.
          Importing merges: connections arrive with fresh ids and add to what is already here.
        </p>
        <div className="sec-row">
          <button className="toolbar-btn" disabled={busy || !open} onClick={() => setForm('export')}>
            Save a copy…
          </button>
          <button
            className="toolbar-btn"
            disabled={busy || !open}
            onClick={async () => {
              const path = await openDialog({
                multiple: false,
                filters: [{ name: 'TxUI vault', extensions: ['txui', 'json'] }],
              });
              if (typeof path !== 'string') return;
              setImportPath(path); setPw1(''); setForm('import');
            }}
          >Import a vault…</button>
        </div>

        {form === 'export' && (
          <Form
            title="Save a copy"
            hint="Leave the password blank to keep the current one."
            first="Password for the copy (optional)"
            ready
            {...{ busy, pw1, pw2, setPw1, setPw2 }}
            onCancel={() => { setForm(null); setPw1(''); }}
            onSubmit={async () => {
              const path = await saveDialog({
                defaultPath: 'txui-vault.txui',
                filters: [{ name: 'TxUI vault', extensions: ['txui'] }],
              });
              if (!path) return;
              await act(async () => {
                const n = await invoke<number>('vault_export', { path, password: pw1 || null });
                return `Wrote ${n} connection${n === 1 ? '' : 's'} to ${basename(String(path))}.`;
              });
            }}
          />
        )}

        {form === 'import' && importPath && (
          <Form
            title={`Import ${basename(importPath)}`}
            hint="Its own password, which may differ from this vault's."
            first="Password for that file"
            ready={pw1.length > 0}
            {...{ busy, pw1, pw2, setPw1, setPw2 }}
            onCancel={() => { setForm(null); setImportPath(null); setPw1(''); }}
            onSubmit={() => act(async () => {
              const r = await invoke<ImportSummary>('vault_import', {
                path: importPath, password: pw1,
              });
              window.dispatchEvent(new CustomEvent('dbgui:connections-changed'));
              return `Imported ${r.connections} connection(s), ${r.secrets} secret(s), `
                + `${r.folders} folder(s).`;
            })}
          />
        )}
      </div>
      </>)}
    </section>
  );
}

/** One or two password fields with a guard and a reason. */
function Form(props: {
  title: string; hint: string;
  first: string; second?: string;
  ready: boolean; problem?: string | null;
  busy: boolean;
  pw1: string; pw2: string;
  setPw1: (v: string) => void; setPw2: (v: string) => void;
  onSubmit: () => void; onCancel: () => void;
}) {
  const { title, hint, first, second, ready, problem, busy, pw1, pw2, setPw1, setPw2 } = props;
  return (
    <div className="sec-form">
      <div className="sec-block-title">{title}</div>
      <p className="settings-hint">{hint}</p>
      <div className="sec-row">
        <input type="password" placeholder={first} value={pw1}
               onChange={e => setPw1(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter' && ready && !busy) props.onSubmit(); }} />
        {second && (
          <input type="password" placeholder={second} value={pw2}
                 onChange={e => setPw2(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter' && ready && !busy) props.onSubmit(); }} />
        )}
        <button className="toolbar-btn" disabled={busy || !ready} onClick={props.onSubmit}>OK</button>
        <button className="toolbar-btn" disabled={busy} onClick={props.onCancel}>Cancel</button>
      </div>
      {problem && <div className="sec-error">{problem}</div>}
    </div>
  );
}
