/**
 * Settings — the canonical home for application preferences (⚙ / ⌘,).
 *
 * Grouped into tabs rather than one long scroll: the list had grown past the
 * point where you could find anything by reading, and scrolling to hunt for a
 * checkbox is not browsing. One tab per concern; the tab you were last on is
 * remembered, because settings are usually revisited for the same reason.
 */
import { errorDisplay } from '../utils/appError';
import { useCallback, useEffect, useState } from 'react';
import { aiHasKey, aiSetKey } from '../utils/aiClient';
import { PREFS, usePreference } from '../store/preferences';
import { THEMES, applyTheme } from '../utils/themes';
import { clampFontSize, FONT_SIZE_MIN, FONT_SIZE_MAX } from '../utils/fontScale';
import { beep } from '../utils/beep';
import {
  loadProfiles, activeProfile, setActiveProfile, saveProfiles, duplicateProfile,
} from '../utils/formatProfiles';
import type { FormatProfile } from '../utils/formatProfiles';
import { invoke } from '@tauri-apps/api/core';
import { SecurityPanel } from './SecurityPanel';
import { SqlTemplatesStore } from '../store/sqlTemplates';
import type { SqlTemplate } from '../store/sqlTemplates';
import { defaultEol, shortcuts } from '../utils/platform';

/** Shortcut labels for this platform — see utils/platform. */
const SC = shortcuts();

const TABS = ['Appearance', 'Editor', 'Connections', 'AI', 'Security', 'Safety', 'SQL templates', 'Logging'] as const;
type Tab = typeof TABS[number];
const TAB_KEY = 'dbgui.settingsTab';

interface Props { onClose: () => void }

const LIMIT_CHOICES = [100, 1000, 10000, 0]; // 0 = no limit

/** Query-deadline stepper. 0 is "off" and is the default. */
const QUERY_TIMEOUT_STEP = 15;
// An hour, not the backend's 86400 ceiling: past this the stepper stops being
// a usable way to enter a number, and a deadline that long is not doing any
// work a person would notice.
const QUERY_TIMEOUT_MAX = 3600;

export function SettingsModal({ onClose }: Props) {
  const [showCreate, setShowCreate] = usePreference(PREFS.showCreateOnBrowse);
  const [defaultLimit, setDefaultLimit] = usePreference(PREFS.defaultLimit);
  const [editorWrap, setEditorWrap] = usePreference(PREFS.editorWrap);
  const [copyHeaders, setCopyHeaders] = usePreference(PREFS.copyHeaders);
  const [exportEol, setExportEol] = usePreference(PREFS.exportEol);
  const [keywordCase, setKeywordCase] = usePreference(PREFS.editorKeywordCase);
  const [editorMinimap, setEditorMinimap] = usePreference(PREFS.editorMinimap);
  const [editorChangeBars, setEditorChangeBars] = usePreference(PREFS.editorChangeBars);
  const [editorHints, setEditorHints] = usePreference(PREFS.editorHints);
  const [autoFormat, setAutoFormat] = usePreference(PREFS.editorAutoFormat);
  const [writeConfirm, setWriteConfirm] = usePreference(PREFS.writeConfirm);
  const [fontSize, setFontSize] = usePreference(PREFS.appFontSize);
  const [prodRowCap, setProdRowCap] = usePreference(PREFS.prodRowCap);
  const [serverLog, setServerLog] = usePreference(PREFS.serverLog);
  const [queryWarnings, setQueryWarnings] = usePreference(PREFS.queryWarnings);
  const [connectTimeout, setConnectTimeout] = usePreference(PREFS.connectTimeoutSecs);
  const [queryTimeout, setQueryTimeout] = usePreference(PREFS.queryTimeoutSecs);
  const [beepOnLong, setBeepOnLong] = usePreference(PREFS.beepOnLongQuery);
  const [notifyOnLong, setNotifyOnLong] = usePreference(PREFS.notifyOnLongQuery);
  const [beepSecs, setBeepSecs] = usePreference(PREFS.longQueryBeepSecs);
  const [autoExplainSecs, setAutoExplainSecs] = usePreference(PREFS.autoExplainSecs);
  const [delimiter, setDelimiter] = usePreference(PREFS.sqlDelimiter);
  const [scriptError, setScriptError] = usePreference(PREFS.scriptErrorMode);
  const [interactiveKill, setInteractiveKill] = usePreference(PREFS.interactiveKill);
  const [keepAlive, setKeepAlive] = usePreference(PREFS.keepAlive);
  const [aiProvider, setAiProvider] = usePreference(PREFS.aiProvider);
  const [aiBaseUrl, setAiBaseUrl] = usePreference(PREFS.aiBaseUrl);
  const [aiModel, setAiModel] = usePreference(PREFS.aiModel);
  const [aiKey, setAiKey] = useState('');
  const [aiKeySet, setAiKeySet] = useState(false);
  useEffect(() => { aiHasKey().then(setAiKeySet).catch(() => {}); }, []);
  const [profiles, setProfiles] = useState<FormatProfile[]>(() => loadProfiles(localStorage));
  const [profileId, setProfileId] = useState(() => activeProfile(localStorage).id);
  const profile = profiles.find(p => p.id === profileId) ?? profiles[0];
  const patchProfile = (patch: Partial<FormatProfile>) => {
    // A built-in is read-only: editing one would make "TxUI default" mean
    // something different on every machine.
    if (profile.builtin) return;
    const next = profiles.map(p => (p.id === profile.id ? { ...p, ...patch } : p));
    setProfiles(next);
    saveProfiles(next, localStorage);
  };
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('dbgui:theme') ?? 'txui-dark'; } catch { return 'txui-dark'; }
  });
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      return (TABS as readonly string[]).includes(saved ?? '') ? (saved as Tab) : 'Appearance';
    } catch { return 'Appearance'; }
  });
  const pickTab = (t: Tab) => {
    setTab(t);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* quota */ }
  };

  // The backend applies this to any connection that has no timeout of its own,
  // so it has to be pushed there — not just stored in localStorage.
  useEffect(() => {
    invoke('set_connect_timeout', { secs: connectTimeout }).catch(() => {});
  }, [connectTimeout]);
  useEffect(() => {
    invoke('set_query_timeout', { secs: queryTimeout }).catch(() => {});
  }, [queryTimeout]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">⚙ Settings</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="settings-tabs" role="tablist">
          {TABS.map(t => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`settings-tab${tab === t ? ' active' : ''}`}
              onClick={() => pickTab(t)}
            >{t}</button>
          ))}
        </div>

        <div className="settings-body">
          {tab === 'Appearance' && (<>
          {/* Appearance */}
          <section className="settings-section">
            <h3>Appearance</h3>
            <label className="settings-row">
              <span>Theme</span>
              <select value={theme} onChange={e => { setTheme(e.target.value); applyTheme(e.target.value); }}>
                <optgroup label="Dark">
                  {THEMES.filter(t => t.dark).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </optgroup>
                <optgroup label="Light">
                  {THEMES.filter(t => !t.dark).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </optgroup>
              </select>
            </label>
            <label className="settings-row">
              <span>Font size <em>(app-wide; the grid has its own Aa popover)</em></span>
              <span className="settings-stepper">
                <button
                  type="button"
                  className="settings-stepper-btn"
                  disabled={fontSize <= FONT_SIZE_MIN}
                  onClick={() => setFontSize(clampFontSize(fontSize - 1))}
                  aria-label="Decrease font size"
                >−</button>
                <span className="settings-stepper-value">{fontSize} px</span>
                <button
                  type="button"
                  className="settings-stepper-btn"
                  disabled={fontSize >= FONT_SIZE_MAX}
                  onClick={() => setFontSize(clampFontSize(fontSize + 1))}
                  aria-label="Increase font size"
                >+</button>
              </span>
            </label>
            <p className="settings-hint">Grid font, density and zebra stripes live in the grid's Aa popover (they apply per-grid, live).</p>
          </section>
          </>)}

          {tab === 'Editor' && (
          <section className="settings-section">
            <h3>Editor & browsing</h3>
            <label className="settings-check">
              <input type="checkbox" checked={showCreate} onChange={e => setShowCreate(e.target.checked)} />
              <span>Insert <code>SHOW CREATE</code> output into the editor when browsing a table/view</span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={editorWrap} onChange={e => setEditorWrap(e.target.checked)} />
              <span>Word-wrap the SQL editor by default <em>(new editors; toggle live with {SC.wrap} or View → Toggle Word Wrap)</em></span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={copyHeaders} onChange={e => setCopyHeaders(e.target.checked)} />
              <span>Include column headers when copying cells <em>({SC.copy}; toggle with {SC.copyHeaders})</em></span>
            </label>
            <label className="settings-row">
              <span>Line endings in exported files</span>
              <select value={exportEol} onChange={e => setExportEol(e.target.value as typeof exportEol)}>
                <option value="platform">This platform ({defaultEol() === '\r\n' ? 'CRLF' : 'LF'})</option>
                <option value="lf">LF (\n) — Unix, Excel, modern Notepad</option>
                <option value="crlf">CRLF (\r\n) — older Windows tooling</option>
              </select>
            </label>
            {/* The clipboard is deliberately untouched: pasting is between two
                applications that have already agreed on a convention. */}
            <label className="settings-row">
              <span>Confirm writes <em>(shows the statement and counts the rows it will change)</em></span>
              <select value={writeConfirm} onChange={e => setWriteConfirm(e.target.value as typeof writeConfirm)}>
                <option value="destructive">UPDATE / DELETE always, others on prod</option>
                <option value="always">every write statement</option>
                <option value="prod">only on prod, or with no WHERE</option>
              </select>
            </label>
            <label className="settings-row">
              <span>SQL keyword case <em>(what completion inserts — formatting follows the profile below)</em></span>
              <select value={keywordCase} onChange={e => setKeywordCase(e.target.value as typeof keywordCase)}>
                <option value="upper">SELECT — upper case</option>
                <option value="lower">select — lower case</option>
              </select>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={editorMinimap} onChange={e => setEditorMinimap(e.target.checked)} />
              <span>Editor minimap <em>(line-density map with viewport + search markers; toggles live)</em></span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={editorChangeBars} onChange={e => setEditorChangeBars(e.target.checked)} />
              <span>Change bars in editor gutter <em>(mark lines that differ from the buffer as first loaded; off by default)</em></span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={editorHints} onChange={e => setEditorHints(e.target.checked)} />
              <span>Hints (completion, lint, hover) <em>(the automatic popups, squiggles and tooltips; toggles live — explicit commands like quick definition and the kill picker stay on)</em></span>
            </label>
            <label className="settings-row">
              <span>Auto-format SQL <em>(the built-in beautifier — also on demand with {SC.beautify})</em></span>
              <select value={autoFormat} onChange={e => setAutoFormat(e.target.value as typeof autoFormat)}>
                <option value="off">off — format only on demand</option>
                <option value="semicolon">when ; completes a statement</option>
                <option value="paste">after pasting SQL</option>
              </select>
            </label>
            <p className="settings-hint">Auto-format reflows keywords, clauses and indentation using the active formatting profile; strings, quoted identifiers and comments are never touched.</p>

            <label className="settings-row">
              <span>Formatting profile <em>(used by {SC.format}, {SC.beautify} and auto-format)</em></span>
              <select
                value={profileId}
                onChange={e => { setProfileId(e.target.value); setActiveProfile(e.target.value, localStorage); }}
              >
                {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {profile?.note && <p className="settings-hint">{profile.note}</p>}

            <div className="settings-profile">
              <label className="settings-row">
                <span>Keywords</span>
                <select value={profile.keywordCase} disabled={profile.builtin}
                        onChange={e => patchProfile({ keywordCase: e.target.value as 'upper' | 'lower' })}>
                  <option value="upper">UPPERCASE</option>
                  <option value="lower">lowercase</option>
                </select>
              </label>
              <label className="settings-row">
                <span>Indent</span>
                <select value={profile.indentWidth} disabled={profile.builtin}
                        onChange={e => patchProfile({ indentWidth: Number(e.target.value) })}>
                  <option value={0}>Tab</option>
                  <option value={2}>2 spaces</option>
                  <option value={4}>4 spaces</option>
                  <option value={8}>8 spaces</option>
                </select>
              </label>
              <label className="settings-row">
                <span>Commas</span>
                <select value={profile.commaStyle} disabled={profile.builtin}
                        onChange={e => patchProfile({ commaStyle: e.target.value as 'trailing' | 'leading' })}>
                  <option value="trailing">trailing — a,</option>
                  <option value="leading">leading — , a</option>
                </select>
              </label>
              <div className="settings-row">
                <span>{profile.builtin
                  ? 'Built-in profiles are read-only — copy one to edit it.'
                  : 'Custom profile.'}</span>
                <span className="settings-profile-actions">
                  <button type="button" className="toolbar-btn" onClick={() => {
                    const copy = duplicateProfile(profile, profiles);
                    const next = [...profiles, copy];
                    setProfiles(next);
                    saveProfiles(next, localStorage);
                    setProfileId(copy.id);
                    setActiveProfile(copy.id, localStorage);
                  }}>Duplicate</button>
                  {!profile.builtin && (
                    <button type="button" className="toolbar-btn" onClick={() => {
                      const next = profiles.filter(p => p.id !== profile.id);
                      setProfiles(next);
                      saveProfiles(next, localStorage);
                      setProfileId(next[0].id);
                      setActiveProfile(next[0].id, localStorage);
                    }}>Delete</button>
                  )}
                </span>
              </div>
            </div>
            <label className="settings-row">
              <span>Default row limit</span>
              <select value={defaultLimit} onChange={e => setDefaultLimit(Number(e.target.value))}>
                {LIMIT_CHOICES.map(n => <option key={n} value={n}>{n === 0 ? 'No limit' : n.toLocaleString()}</option>)}
              </select>
            </label>
            <p className="settings-hint">The limit caps SELECTs with no LIMIT of their own — applies to newly opened sessions; change it live per session from the status bar.</p>
            <label className="settings-row">
              <span>Statement delimiter <em>(what separates one statement from the next)</em></span>
              <input
                className="settings-text settings-text-sm"
                value={delimiter}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={e => setDelimiter(e.target.value)}
                onBlur={e => { if (!e.target.value.trim()) setDelimiter(';'); }}
                aria-label="SQL statement delimiter"
              />
            </label>
            <p className="settings-hint">
              Almost always <code>;</code>. Change it for dialects and dumps that terminate
              differently (<code>/</code>, <code>GO</code>); a <code>DELIMITER</code> directive inside
              the script still overrides it from that line on. Leaving it empty resets it to <code>;</code>.
            </p>
            <label className="settings-check">
              <input type="checkbox" checked={beepOnLong} onChange={e => setBeepOnLong(e.target.checked)} />
              <span>Beep when a long-running query finishes</span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={notifyOnLong} onChange={e => setNotifyOnLong(e.target.checked)} />
              <span>Notify when a long-running query finishes (window in the background)</span>
            </label>
            <label className="settings-row">
              <span>Long-running query is <em>(only runs at least this long get a beep / notification)</em></span>
              <span className="settings-stepper">
                <button
                  type="button"
                  className="settings-stepper-btn"
                  disabled={(!beepOnLong && !notifyOnLong) || beepSecs <= 1}
                  onClick={() => setBeepSecs(Math.max(1, beepSecs - 5))}
                  aria-label="Decrease long-query threshold"
                >−</button>
                <span className="settings-stepper-value">{beepSecs} s</span>
                <button
                  type="button"
                  className="settings-stepper-btn"
                  disabled={(!beepOnLong && !notifyOnLong) || beepSecs >= 3600}
                  onClick={() => setBeepSecs(Math.min(3600, beepSecs + 5))}
                  aria-label="Increase long-query threshold"
                >+</button>
                <button
                  type="button"
                  className="settings-stepper-btn settings-stepper-wide"
                  disabled={!beepOnLong}
                  onClick={() => beep('ok')}
                  title="Play the sound"
                >Test</button>
              </span>
            </label>
            <p className="settings-hint">
              Rises on success, falls on failure — so you can tell what happened from another window.
              Queries faster than the threshold stay quiet; the notification fires only while the window is unfocused.
            </p>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={autoExplainSecs > 0}
                onChange={e => setAutoExplainSecs(e.target.checked ? (autoExplainSecs || PREFS.autoExplainSecs.default) : 0)}
              />
              <span>Fetch the plan when a slow query finishes <em>(auto-EXPLAIN)</em></span>
            </label>
            <label className="settings-row">
              <span>Slow means at least <em>(0 = never fetch; the plan waits behind a badge on the statement's gutter marker, it never steals focus)</em></span>
              <span className="settings-stepper">
                <button
                  type="button"
                  className="settings-stepper-btn"
                  disabled={autoExplainSecs <= 1}
                  onClick={() => setAutoExplainSecs(Math.max(1, autoExplainSecs - 1))}
                  aria-label="Decrease auto-explain threshold"
                >−</button>
                <span className="settings-stepper-value">{autoExplainSecs > 0 ? `${autoExplainSecs} s` : 'off'}</span>
                <button
                  type="button"
                  className="settings-stepper-btn"
                  disabled={autoExplainSecs >= 300}
                  onClick={() => setAutoExplainSecs(Math.min(300, autoExplainSecs + 1))}
                  aria-label="Increase auto-explain threshold"
                >+</button>
              </span>
            </label>
            <p className="settings-hint">
              Read-family single statements only, on engines that have EXPLAIN — a script would mean
              one background plan per statement. A failed fetch stays silent.
            </p>
          </section>
          )}

          {tab === 'Connections' && (
          <section className="settings-section">
            <h3>Connections</h3>
            <label className="settings-check">
              <input type="checkbox" checked={keepAlive} onChange={e => setKeepAlive(e.target.checked)} />
              <span>Keep connections alive <em>(ping open sessions periodically and on window focus, so a pool that dropped during sleep / a VPN blip is re-established before your next query)</em></span>
            </label>
            <label className="settings-row">
              <span>
                Connect timeout
                <em>(how long to wait for a server to answer; a connection's own
                Advanced → connect timeout still wins)</em>
              </span>
              <span className="settings-stepper">
                <button
                  type="button"
                  className="settings-stepper-btn"
                  disabled={connectTimeout <= 1}
                  onClick={() => setConnectTimeout(Math.max(1, connectTimeout - 1))}
                  aria-label="Decrease connect timeout"
                >−</button>
                <span className="settings-stepper-value">{connectTimeout} s</span>
                <button
                  type="button"
                  className="settings-stepper-btn"
                  disabled={connectTimeout >= 300}
                  onClick={() => setConnectTimeout(Math.min(300, connectTimeout + 1))}
                  aria-label="Increase connect timeout"
                >+</button>
              </span>
            </label>
            <p className="settings-hint">
              A server that is up answers in well under a second on a LAN and a couple over a VPN,
              so a longer wait almost always means the host is not going to answer at all. Raise it
              only if you routinely connect over something slow.
            </p>
            <label className="settings-row">
              <span>
                Query timeout
                <em>(kill a query that runs longer than this; a connection's own
                Advanced → query timeout still wins)</em>
              </span>
              <span className="settings-stepper">
                <button
                  type="button"
                  className="settings-stepper-btn"
                  disabled={queryTimeout <= 0}
                  onClick={() => setQueryTimeout(Math.max(0, queryTimeout - QUERY_TIMEOUT_STEP))}
                  aria-label="Decrease query timeout"
                >−</button>
                <span className="settings-stepper-value">
                  {queryTimeout === 0 ? 'off' : `${queryTimeout} s`}
                </span>
                <button
                  type="button"
                  className="settings-stepper-btn"
                  disabled={queryTimeout >= QUERY_TIMEOUT_MAX}
                  onClick={() => setQueryTimeout(Math.min(QUERY_TIMEOUT_MAX, queryTimeout + QUERY_TIMEOUT_STEP))}
                  aria-label="Increase query timeout"
                >+</button>
              </span>
            </label>
            <p className="settings-hint">
              Off by default, and worth leaving off unless you want the guard: TxUI cannot tell a
              runaway query from an import you meant to take ten minutes, and killing the second one
              halfway is the worse mistake. This is enforced here rather than by the server, so
              unlike MySQL's <code>max_execution_time</code> — which bounds read-only SELECT only —
              it covers writes too, and it issues the same KILL the Stop button does.
            </p>
          </section>
          )}

          {tab === 'AI' && (
          <section className="settings-section">
            <h3>AI assistant</h3>
            <p className="settings-hint">
              Powers the editor’s generate-SQL, explain, and “Fix with AI” actions. Bring your own endpoint and key.
              The key is stored in the encrypted vault, never in plain settings, and is sent only to
              the endpoint below.
            </p>
            <label className="settings-row">
              <span>Provider</span>
              <select value={aiProvider} onChange={e => setAiProvider(e.target.value as typeof aiProvider)}>
                <option value="anthropic">Anthropic (Messages API)</option>
                <option value="openai">OpenAI-compatible (/chat/completions)</option>
              </select>
            </label>
            <label className="settings-row">
              <span>Endpoint base URL</span>
              <input value={aiBaseUrl} onChange={e => setAiBaseUrl(e.target.value)}
                placeholder={aiProvider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} />
            </label>
            <label className="settings-row">
              <span>Model</span>
              <input value={aiModel} onChange={e => setAiModel(e.target.value)}
                placeholder={aiProvider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o'} />
            </label>
            <label className="settings-row">
              <span>API key {aiKeySet && <em>(a key is saved)</em>}</span>
              <input type="password" value={aiKey} onChange={e => setAiKey(e.target.value)}
                placeholder={aiKeySet ? '•••••••• — type to replace' : 'paste your API key'} />
            </label>
            <div className="settings-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              {aiKeySet && (
                <button className="toolbar-btn" onClick={() => { void aiSetKey(''); setAiKeySet(false); setAiKey(''); }}>
                  Clear key
                </button>
              )}
              <button className="primary" disabled={!aiKey.trim()}
                onClick={() => { void aiSetKey(aiKey.trim()).then(() => { setAiKeySet(true); setAiKey(''); }); }}>
                Save key
              </button>
            </div>
          </section>
          )}

          {tab === 'Security' && <SecurityPanel />}

          {tab === 'Safety' && (
          <section className="settings-section">
            <h3>Safety</h3>
            <label className="settings-check">
              <input type="checkbox" checked={interactiveKill} onChange={e => setInteractiveKill(e.target.checked)} />
              <span>Interactive kill <em>(the process list can kill a query or connection in one click; turn off for a read-only monitor)</em></span>
            </label>
            <label className="settings-row">
              <span>Prod row cap <em>(replaces the default LIMIT on prod sessions; the status-bar override still wins)</em></span>
              <select value={prodRowCap} onChange={e => setProdRowCap(Number(e.target.value))}>
                {[1000, 10000, 100000, 0].map(n => <option key={n} value={n}>{n === 0 ? 'Off' : n.toLocaleString()}</option>)}
              </select>
            </label>
            <label className="settings-row">
              <span>On a failed statement <em>(when running several statements at once)</em></span>
              <select value={scriptError} onChange={e => setScriptError(e.target.value as typeof scriptError)}>
                <option value="ask">ask — ignore, ignore all, or stop</option>
                <option value="stop">stop immediately</option>
              </select>
            </label>
            <p className="settings-hint">
              A batch of independent statements should not be binned by one bad one, but a sequence
              usually is meaningless past the failure — <strong>ask</strong> puts that call in your hands
              per run, and “ignore all” stops asking for the rest of that run.
              <strong> Stop immediately</strong> aborts without prompting and marks the rest skipped.
            </p>
          </section>
          )}

          {tab === 'SQL templates' && <SqlTemplatesSection />}

          {tab === 'Logging' && (
          <section className="settings-section">
            <h3>Logging</h3>
            <label className="settings-check">
              <input type="checkbox" checked={serverLog} onChange={e => setServerLog(e.target.checked)} />
              <span>Write a per-connection server activity log <em>(applies to newly opened sessions)</em></span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={queryWarnings} onChange={e => setQueryWarnings(e.target.checked)} />
              <span>Fetch server warnings <em>(extra roundtrip on writes)</em></span>
            </label>
            <p className="settings-hint">The per-connection directory is set in the connection editor → Advanced; lines are appended to &lt;dir&gt;/&lt;connection&gt;.log.</p>
          </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** `?name` editor expansions — curated seeds + user CRUD, SQLite-backed. */
function SqlTemplatesSection() {
  const [templates, setTemplates] = useState<SqlTemplate[]>([]);
  const [editing, setEditing] = useState<SqlTemplate | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    SqlTemplatesStore.list().then(setTemplates).catch(e => setError(errorDisplay(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function handleDelete(id: number) {
    setError(null);
    try {
      await SqlTemplatesStore.delete(id);
      if (editing !== null && editing !== 'new' && editing.id === id) setEditing(null);
      load();
    } catch (e) {
      setError(errorDisplay(e));
    }
  }

  return (
    <section className="settings-section">
      <h3>SQL templates</h3>
      <p className="settings-hint">
        Type <code>?name</code> in the editor to expand a template as a snippet.
        In the body: <code>{'${1}'}</code> = cursor stop, <code>{'${1:default}'}</code> = stop with a
        default value, <code>{'${0}'}</code> = final cursor position.
      </p>

      {error && <div className="tpl-error">{error}</div>}

      <div className="tpl-list">
        {templates.map(t => (
          <div key={t.id} className="tpl-row">
            <div className="tpl-info">
              <span className="tpl-name">?{t.name}</span>
              <span className="tpl-engine">{t.engine ?? 'any'}</span>
              {t.builtin && <span className="tpl-builtin">built-in</span>}
              <span className="tpl-desc">{t.description}</span>
            </div>
            <div className="tpl-actions">
              <button className="toolbar-btn" onClick={() => { setEditing(t); setError(null); }}>Edit</button>
              <button className="history-delete" title="Delete" onClick={() => handleDelete(t.id)}>×</button>
            </div>
          </div>
        ))}
        {templates.length === 0 && <div className="settings-hint">No templates yet.</div>}
      </div>

      {editing === null ? (
        <button className="toolbar-btn" onClick={() => { setEditing('new'); setError(null); }}>+ Add template</button>
      ) : (
        <SqlTemplateForm
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          onDone={() => { setEditing(null); load(); }}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function SqlTemplateForm({ initial, onDone, onCancel }: {
  initial: SqlTemplate | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [engine, setEngine] = useState(initial?.engine ?? 'any');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [error, setError] = useState<string | null>(null);

  const nameOk = /^[a-z][\w-]*$/i.test(name.trim());
  const valid = nameOk && body.trim().length > 0;

  async function handleSave() {
    setError(null);
    try {
      await SqlTemplatesStore.save({
        id: initial?.id ?? null,
        name: name.trim(),
        engine,
        description: description.trim(),
        body,
      });
      onDone();
    } catch (e) {
      setError(errorDisplay(e));
    }
  }

  return (
    <div className="tpl-form">
      <div className="tpl-form-row">
        <input
          autoFocus
          placeholder="name (typed as ?name)"
          value={name}
          onChange={e => setName(e.target.value)}
          className={name.trim() && !nameOk ? 'tpl-invalid' : undefined}
        />
        <select value={engine} onChange={e => setEngine(e.target.value)}>
          <option value="any">any engine</option>
          <option value="mysql">mysql</option>
          <option value="postgres">postgres</option>
          <option value="redis">redis</option>
        </select>
      </div>
      <input
        placeholder="description (shown next to the completion)"
        value={description}
        onChange={e => setDescription(e.target.value)}
      />
      <textarea
        placeholder={"SELECT * FROM … WHERE x = '${1}'"}
        value={body}
        onChange={e => setBody(e.target.value)}
        rows={4}
        spellCheck={false}
      />
      {error && <div className="tpl-error">{error}</div>}
      <div className="tpl-form-actions">
        <button className="primary" disabled={!valid} onClick={handleSave}>
          {initial ? 'Save' : 'Add'}
        </button>
        <button className="toolbar-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
