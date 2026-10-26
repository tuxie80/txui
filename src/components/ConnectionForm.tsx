import { errorDisplay } from '../utils/appError';
import { useEffect, useRef, useState } from 'react';
import { ConnectionsStore } from '../store/connections';
import type { ConnectionConfig, Engine, SslMode } from '../types';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { parseConnectionUrl, clickhouseCeilingParams, CH_CEILING_KEYS } from '../utils/connUrl';
import { portError, sshPortError, redisDbError, filePathError } from '../utils/connValidate';
import { withDeadline, connectDeadlineMs } from '../utils/withDeadline';
import { stagedDeadlineMs, verdictLine } from '../utils/connDiag';
import type { StagedConnectResult } from '../utils/connDiag';
import { ConnDiagChecklist } from './ConnDiagChecklist';
import {
  ENGINE_DEFAULTS, DEFAULT_HOST, resolveDefaults, clearStaleDefaults, databasePlaceholder,
} from '../utils/connDefaults';
import { EngineLogo } from './engineLogos';
import { PALETTE } from '../utils/palette';
import { basename } from '../utils/platform';
import { available, unavailableProps } from '../utils/platformCaps';
import { parseLabels, formatLabels, labelsFromTags } from '../utils/labels';
import { dbFilterApplies, parseDbFilter, formatDbFilter } from '../utils/dbFilter';
import { ParquetSchemaDialog } from './ParquetSchemaDialog';
import { securityCopyFrom, securityCopySources } from '../utils/connSecurity';

const ENGINE_LABELS: Record<Engine, string> = {
  mysql:    'MySQL / MariaDB / Percona',
  postgres: 'PostgreSQL',
  // Forks are protocol-compatible but untested — the
  // label says what is verified, the hint below says the rest.
  redis:    'Redis',
  clickhouse: 'ClickHouse (HTTP)',
  sqlite:  'SQLite (file)',
  parquet: 'Parquet (file or folder)',
  duckdb:  'DuckDB (file or :memory:)',
  mongodb: 'MongoDB',
  // SQL logins only (no Windows/integrated auth, no named instances) — the
  // label says what the driver actually does.
  sqlserver: 'SQL Server',
};

interface Props {
  initial?: Partial<ConnectionConfig>;
  /** prefilled folder path for a brand-new connection (sidebar folder menu) */
  initialGroup?: string;
  /** Empty password fields mean "leave the stored secret unchanged". */
  onSave: (config: ConnectionConfig, password: string, sshPassword: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Form sections, one tab per concern. The old everything-visible two-column
 * layout squeezed Advanced's three-across rows into half the card and they
 * poked out past its right edge; tabs give every section the full width.
 */
type CFTab = 'connection' | 'options' | 'security' | 'advanced';
const CF_TABS: ReadonlyArray<{ id: CFTab; label: string }> = [
  { id: 'connection', label: 'Connection' },
  { id: 'options',    label: 'Options' },
  { id: 'security',   label: 'SSH / SSL' },
  { id: 'advanced',   label: 'Advanced' },
];

export function ConnectionForm({ initial, initialGroup, onSave, onCancel }: Props) {
  const [engine,   setEngine]   = useState<Engine>(initial?.engine ?? 'mysql');
  // Cloud SQL IAM auth applies only to the client/server SQL engines.
  const iamCapable = engine === 'mysql' || engine === 'postgres';
  const [name,     setName]     = useState(initial?.name ?? '');
  // Empty, not prefilled: the engine default is shown as placeholder text and
  // applied by resolveDefaults() at save time. Editing an existing connection
  // still loads its real stored values.
  const [host,     setHost]     = useState(initial?.host ?? '');
  const [port,     setPort]     = useState<number | null>(initial?.port ?? null);
  const [user,     setUser]     = useState(initial?.user ?? '');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState(initial?.database ?? '');
  const [filePath, setFilePath] = useState(initial?.file_path ?? '');
  const [group,    setGroup]    = useState(initial?.group ?? initialGroup ?? '');
  const [color,    setColor]    = useState<string | null>(initial?.color ?? null);
  const [knownGroups, setKnownGroups] = useState<string[]>([]);
  // All saved configs — feeds the Security tab's "Copy from…" select (W5.5).
  const [knownConns, setKnownConns] = useState<ConnectionConfig[]>([]);
  useEffect(() => {
    ConnectionsStore.list()
      .then(cs => {
        setKnownGroups([...new Set(cs.map(c => c.group).filter((g): g is string => !!g))].sort());
        setKnownConns(cs);
      })
      .catch(() => {});
  }, []);
  const [environment, setEnvironment] = useState(initial?.environment ?? '');
  const [readOnly, setReadOnly] = useState(initial?.read_only ?? false);
  const [autocommit, setAutocommit] = useState(initial?.autocommit ?? true);
  const [prodAllowDdl, setProdAllowDdl] = useState(initial?.prod_allow_ddl ?? false);
  const [prodAllowUnfiltered, setProdAllowUnfiltered] = useState(initial?.prod_allow_unfiltered_write ?? false);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [autoConnect, setAutoConnect] = useState(initial?.auto_connect ?? false);
  // The text form is the source of truth — one field, round-tripping exactly,
  // rather than a chip editor plus a hidden-toggle that can disagree with it.
  const [labelText, setLabelText] = useState(
    formatLabels(initial?.labels?.length ? initial.labels : labelsFromTags(initial?.tags)));
  // W5.6 database visibility filter: exact names, comma-separated; blank
  // shows everything (the pre-filter behaviour).
  const [dbFilterText, setDbFilterText] = useState(formatDbFilter(initial?.db_filter));
  const [sslMode,  setSslMode]  = useState<SslMode>(initial?.ssl_mode ?? 'preferred');
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  // Parquet "New…" — design the schema, then the dialog creates the file.
  const [showParquetNew, setShowParquetNew] = useState(false);

  // SSH tunnel
  const [useSsh,     setUseSsh]     = useState(initial?.use_ssh ?? false);
  const [sshHost,    setSshHost]    = useState(initial?.ssh_host ?? '');
  const [sshPort,    setSshPort]    = useState(initial?.ssh_port ?? 22);
  const [sshUser,    setSshUser]    = useState(initial?.ssh_user ?? '');
  const [sshKeyPath, setSshKeyPath] = useState(initial?.ssh_key_path ?? '');
  const [sshJump,    setSshJump]    = useState(initial?.ssh_jump ?? '');
  const [useSshPassword, setUseSshPassword] = useState(initial?.use_ssh_password ?? false);
  // ssh-agent status, so the key field can say whether leaving it blank works.
  const [agentStatus, setAgentStatus] = useState<{ available: boolean; key_count: number } | null>(null);
  useEffect(() => {
    if (!useSsh) return;
    invoke<{ available: boolean; key_count: number }>('ssh_agent_status')
      .then(setAgentStatus)
      .catch(() => setAgentStatus(null));
  }, [useSsh]);
  const [sshPassword,    setSshPassword]    = useState('');

  // SSL certs
  const [showSsl,    setShowSsl]    = useState(
    !!(initial?.ssl_ca_path || initial?.ssl_cert_path || initial?.ssl_key_path)
  );
  const [sslCaPath,   setSslCaPath]   = useState(initial?.ssl_ca_path ?? '');
  const [trustCert,   setTrustCert]   = useState(!!initial?.trust_server_cert);
  const [sslCertPath, setSslCertPath] = useState(initial?.ssl_cert_path ?? '');
  const [sslKeyPath,  setSslKeyPath]  = useState(initial?.ssl_key_path ?? '');
  // Cloud SQL IAM auth (MySQL / PostgreSQL)
  const [useIamAuth,  setUseIamAuth]  = useState(initial?.use_iam_auth ?? false);
  const [iamKeyPath,  setIamKeyPath]  = useState(initial?.iam_key_path ?? '');
  // Password command (W5.1): stdout is the password; backend resolves it at
  // connect/test and re-runs after the TTL.
  const [passwordExec,    setPasswordExec]    = useState(initial?.password_exec ?? '');
  const [passwordExecTtl, setPasswordExecTtl] = useState(initial?.password_exec_ttl_secs?.toString() ?? '');

  // Advanced (connection tuning / pool) — lives on the Advanced tab now.
  const [tab, setTab] = useState<CFTab>('connection');
  const [connectTimeout, setConnectTimeout] = useState(initial?.connect_timeout_secs?.toString() ?? '');
  const [queryTimeout, setQueryTimeout] = useState(initial?.query_timeout_secs?.toString() ?? '');
  const [applicationName, setApplicationName] = useState(initial?.application_name ?? '');
  const [socketPath,      setSocketPath]      = useState(initial?.socket_path ?? '');
  const [charset,         setCharset]         = useState(initial?.charset ?? '');
  const [collation,       setCollation]       = useState(initial?.collation ?? '');
  const [timeZone,        setTimeZone]        = useState(initial?.time_zone ?? '');
  const [initSql,         setInitSql]         = useState(initial?.init_sql ?? '');
  const [logDir,          setLogDir]          = useState(initial?.log_dir ?? '');
  const [enableCleartext, setEnableCleartext] = useState(initial?.enable_cleartext_plugin ?? false);
  const [poolMax,     setPoolMax]     = useState(initial?.pool_max?.toString() ?? '');
  const [poolAcquire, setPoolAcquire] = useState(initial?.pool_acquire_timeout_secs?.toString() ?? '');
  const [poolIdle,    setPoolIdle]    = useState(initial?.pool_idle_timeout_secs?.toString() ?? '');
  const [stmtTimeout, setStmtTimeout] = useState(initial?.statement_timeout_secs?.toString() ?? '');
  // ClickHouse memory / row ceilings live in extra_params under their CH names.
  // They own dedicated inputs, so they are hidden from the generic editor below.
  const [chMaxMemory, setChMaxMemory] = useState(initial?.extra_params?.['max_memory_usage'] ?? '');
  const [chMaxRows,   setChMaxRows]   = useState(initial?.extra_params?.['max_rows_to_read'] ?? '');
  const [extraRows,   setExtraRows]   = useState<Array<{ k: string; v: string }>>(
    Object.entries(initial?.extra_params ?? {})
      .filter(([k]) => !(CH_CEILING_KEYS as readonly string[]).includes(k))
      .map(([k, v]) => ({ k, v }))
  );

  // URL paste diagnostics + ad-hoc test feedback
  const [urlWarnings, setUrlWarnings] = useState<string[]>([]);
  const [testing,     setTesting]     = useState(false);
  const [testResult,  setTestResult]  = useState<{ ok: boolean; msg: string } | null>(null);
  /** The staged run behind testResult (connect_test_staged) — the checklist. */
  const [testDiag,    setTestDiag]    = useState<StagedConnectResult | null>(null);

  // W5.4 database picker: names fetched from the server with the form's own
  // credentials, offered as datalist suggestions — the typed value still wins.
  const [dbOptions,   setDbOptions]   = useState<string[]>([]);
  const [dbFetching,  setDbFetching]  = useState(false);
  const [dbListError, setDbListError] = useState<string | null>(null);

  /** "Fetch" beside the database box: connect and list the server's databases. */
  async function fetchDatabases() {
    setDbFetching(true);
    setDbListError(null);
    try {
      const config = buildConfig();
      // Same deadline as a connect — a hung lookup must not spin forever.
      // A blank password on a SAVED config falls back to the stored secret
      // backend-side; on a new one it is simply "no password".
      const names = await withDeadline(
        invoke<string[]>('connect_list_databases', { config, password: password || null }),
        connectDeadlineMs(config));
      setDbOptions(names);
      if (names.length === 0) setDbListError('The server reported no databases');
    } catch (err) {
      setDbListError(errorDisplay(err));
    } finally {
      setDbFetching(false);
    }
  }

  /** W5.5 "Copy from…": TLS + SSH SETTINGS of another saved connection of the
   *  same engine — never a password (those live in the secret store). */
  function applySecurityCopy(sourceId: string) {
    const src = knownConns.find(c => c.id === sourceId);
    if (!src) return;
    const c = securityCopyFrom(src);
    setSslMode(c.ssl_mode);
    setShowSsl(c.has_custom_certs);
    setSslCaPath(c.ssl_ca_path);
    setSslCertPath(c.ssl_cert_path);
    setSslKeyPath(c.ssl_key_path);
    setTrustCert(c.trust_server_cert);
    setUseSsh(c.use_ssh);
    setSshHost(c.ssh_host);
    setSshPort(c.ssh_port);
    setSshUser(c.ssh_user);
    setSshKeyPath(c.ssh_key_path);
    setSshJump(c.ssh_jump);
    setUseSshPassword(c.use_ssh_password);
    setSshPassword(''); // the auth CHOICE copies; the secret does not
  }

  function pasteUrl(raw: string) {
    // mysql://user:pass@host:port/db?ssl-mode=REQUIRED  |  postgresql://...
    // |  redis://.../2  |  clickhouse://user@host:8123/db?readonly=1
    const p = parseConnectionUrl(raw);
    if (!p.ok) {
      setError(`Not a valid connection URL — ${p.error} (expected e.g. mysql://user:pass@host:3306/db)`);
      return;
    }
    setEngine(p.engine);
    if (p.host) setHost(p.host);
    // Blank means the engine default now, so a URL without a port leaves the
    // box empty and its placeholder does the talking.
    setPort(p.port);
    if (p.user) setUser(p.user);
    if (p.password) setPassword(p.password); // secret field — never lands in config JSON
    const db = p.engine === 'redis' && p.redisDb != null ? String(p.redisDb) : p.database;
    if (db) setDatabase(db);
    if (p.sslMode) setSslMode(p.sslMode);
    if (p.connectTimeoutSecs != null) setConnectTimeout(String(p.connectTimeoutSecs));
    if (p.applicationName) setApplicationName(p.applicationName);
    if (p.socketPath) setSocketPath(p.socketPath);
    // ClickHouse spells read-only in the URL; honour it rather than making the
    // user re-tick a box the URL already asked for.
    if (p.readOnly) setReadOnly(true);
    const extra = Object.entries(p.extraParams);
    if (extra.length > 0) {
      setExtraRows(prev => {
        const rows = prev.filter(r => !(r.k in p.extraParams));
        return [...rows, ...extra.map(([k, v]) => ({ k, v }))];
      });
      setTab('advanced');
    }
    if (p.connectTimeoutSecs != null || p.applicationName || p.socketPath) setTab('advanced');
    if (!name.trim()) setName(`${p.user || 'db'}@${p.host ?? p.socketPath ?? 'localhost'}`);
    setUrlWarnings(p.warnings);
    setError(null);
  }

  /** Native file picker, filtered to the engine's extensions. */
  async function pickFile() {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: engine === 'sqlite'
        ? [{ name: 'SQLite database', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] },
           { name: 'All files', extensions: ['*'] }]
        : engine === 'duckdb'
          ? [{ name: 'DuckDB database', extensions: ['duckdb', 'ddb', 'db'] },
             { name: 'All files', extensions: ['*'] }]
          : [{ name: 'Parquet', extensions: ['parquet', 'parq', 'pq'] },
             { name: 'All files', extensions: ['*'] }],
    });
    if (typeof picked !== 'string') return;
    setFilePath(picked);
    // A file connection with no name is nameless in the sidebar; the file name
    // is the obvious default and is still editable.
    if (!name.trim()) {
      setName(basename(picked).replace(/\.[^.]+$/, '') ?? picked);
    }
  }

  /** Native folder picker — a Parquet partitioned dataset is a directory. */
  async function pickFolder() {
    const picked = await openDialog({ multiple: false, directory: true });
    if (typeof picked !== 'string') return;
    setFilePath(picked);
    // Same default-name rule as a file: the folder's own name.
    if (!name.trim()) {
      setName(basename(picked) ?? picked);
    }
  }

  /** Create a brand-new, empty SQLite database and point this connection at it. */
  async function newSqliteFile() {    const picked = await saveDialog({
      defaultPath: 'new-database.sqlite',
      filters: [{ name: 'SQLite database', extensions: ['sqlite', 'sqlite3', 'db'] }],
    });
    if (!picked) return;
    try {
      // The save dialog already confirmed any overwrite, but the backend
      // refuses an existing path outright — truncating someone's database
      // because a name collided is not a thing this app does.
      await invoke('create_sqlite_file', { path: picked });
      setFilePath(picked);
      if (!name.trim()) {
        setName(basename(picked).replace(/\.[^.]+$/, '') ?? picked);
      }
      setError(null);
    } catch (e) {
      setError(`Could not create the database — ${errorDisplay(e)}`);
    }
  }

  function onEngineChange(e: Engine) {
    const next = clearStaleDefaults(
      { host: host ?? '', port, user: user ?? '', database: database ?? '' }, engine, e,
    );
    setEngine(e);
    setPort(next.port);
    setUser(next.user);
    setDatabase(next.database);
  }

  /** Empty/invalid numeric fields become null (backend defaults apply). */
  function toNum(s: string): number | null {
    const t = s.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  function buildConfig(): ConnectionConfig {
    const extraParams: Record<string, string> = {};
    for (const r of extraRows) if (r.k.trim()) extraParams[r.k.trim()] = r.v;
    // ClickHouse memory / row ceilings ride along as session settings. They are
    // added last so the dedicated inputs win over any stray manual entry.
    if (engine === 'clickhouse') {
      Object.assign(extraParams, clickhouseCeilingParams(chMaxMemory, chMaxRows));
    }
    return {
      id:       initial?.id ?? '00000000-0000-0000-0000-000000000000',
      name:     name.trim(),
      engine,
      file_path: filePath.trim() || null,
      ...resolveDefaults(
        { host: host ?? '', port, user: user ?? '', database: database ?? '' }, engine,
      ),
      ssl_mode: sslMode,
      group:    group || null,
      color,
      environment: environment || null,
      read_only:   readOnly,
      autocommit,
      prod_allow_ddl: environment === 'prod' ? prodAllowDdl : false,
      prod_allow_unfiltered_write: environment === 'prod' ? prodAllowUnfiltered : false,
      notes:        notes.trim() || null,
      auto_connect: autoConnect,
      labels:       parseLabels(labelText),
      // Stored only where it can act — a Redis/PG/file-engine config carrying
      // a dead filter would hide nothing and confuse the export reader.
      db_filter:    dbFilterApplies(engine) ? parseDbFilter(dbFilterText) : [],
      // Kept in step so an export stays readable by an older build.
      tags:         parseLabels(labelText).filter(l => !l.hidden).map(l => l.name),
      // SSH
      use_ssh:      useSsh,
      ssh_host:     useSsh ? (sshHost || null) : null,
      ssh_port:     useSsh ? (sshPort || 22) : null,
      ssh_user:     useSsh ? (sshUser || null) : null,
      ssh_key_path: useSsh ? (sshKeyPath || null) : null,
      ssh_jump:         useSsh ? (sshJump.trim() || null) : null,
      use_ssh_password: useSsh && useSshPassword,
      // SSL certs
      ssl_ca_path:   showSsl ? (sslCaPath || null) : null,
      trust_server_cert: trustCert,
      ssl_cert_path: showSsl ? (sslCertPath || null) : null,
      ssl_key_path:  showSsl ? (sslKeyPath || null) : null,
      use_iam_auth:  iamCapable && useIamAuth,
      iam_key_path:  iamCapable && useIamAuth ? (iamKeyPath || null) : null,
      // Password command — a file engine has no login to authenticate.
      password_exec:          isFile ? null : (passwordExec.trim() || null),
      password_exec_ttl_secs: isFile ? null : toNum(passwordExecTtl),
      // Advanced
      connect_timeout_secs: toNum(connectTimeout),
      query_timeout_secs:   toNum(queryTimeout),
      // Only PostgreSQL carries this (startup `application_name`); MySQL's
      // `program_name` equivalent is frozen into the handshake and sqlx gives
      // us no way to send it — don't store a value no server will ever see.
      application_name:     engine === 'postgres' ? (applicationName.trim() || null) : null,
      extra_params:         extraParams,
      socket_path:          socketPath.trim() || null,
      init_sql:             initSql.trim() || null,
      log_dir:              logDir.trim() || null,
      charset:              charset.trim() || null,
      collation:            collation.trim() || null,
      time_zone:            timeZone.trim() || null,
      enable_cleartext_plugin: enableCleartext,
      pool_max:                   toNum(poolMax),
      pool_acquire_timeout_secs:  toNum(poolAcquire),
      pool_idle_timeout_secs:     toNum(poolIdle),
      statement_timeout_secs:     toNum(stmtTimeout),
    };
  }

  // Validation lives ahead of BOTH paths that build a config — Test and Save
  // — so an impossible value never leaves the form.
  function validateForm(): string | null {
    if (isFile) return filePathError(filePath, engine as 'sqlite' | 'parquet' | 'duckdb');
    const p = portError(port);
    if (p) return p;
    if (isRedis) {
      const r = redisDbError(database ?? '');
      if (r) return r;
    }
    if (useSsh) {
      const s = sshPortError(sshPort);
      if (s) return s;
    }
    return null;
  }

  async function handleTest() {
    const invalid = validateForm();
    if (invalid) { setError(invalid); return; }
    setTesting(true);
    setTestResult(null);
    setTestDiag(null);
    setError(null);
    try {
      const config = buildConfig();
      // Staged diagnostics (W3.1): "no" is not an answer — the checklist says
      // WHICH of DNS/TCP/SSH/TLS/auth/probe broke. A failed run is data
      // (verdict 'fail'), not a rejection. The sidebar bounds how long it
      // waits on a connect; the form's Test gets the same treatment — an IPC
      // call that never settles must not leave "Testing…" spinning forever.
      // A staged run can legitimately take several connect-timeouts (one per
      // stage up to the first failure), so its deadline is the staged one.
      const result = await withDeadline(
        ConnectionsStore.testStaged(config, password, sshPassword),
        stagedDeadlineMs(config));
      setTestDiag(result);
      setTestResult({ ok: result.verdict === 'ok', msg: verdictLine(result) });
    } catch (err) {
      setTestResult({ ok: false, msg: errorDisplay(err) });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return; }
    const invalid = validateForm();
    if (invalid) { setError(invalid); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(buildConfig(), password, sshPassword);
    } catch (err) {
      setError(errorDisplay(err));
    } finally {
      setSaving(false);
    }
  }

  const isRedis  = engine === 'redis';
  // SQLite, Parquet and DuckDB open a path. Host, port, user, password, SSL
  // and SSH are all meaningless for them, so the form hides that half rather
  // than showing boxes that do nothing. DuckDB's "path" may also be the
  // literal `:memory:` — a scratch database, the normal way to query
  // Parquet/CSV/JSON files in SQL.
  const isFile   = engine === 'sqlite' || engine === 'parquet' || engine === 'duckdb';
  const engineDefaults = ENGINE_DEFAULTS[engine];

  // W5.4: why the database Fetch button is greyed, or null when it works.
  // Host/port/user must be real values — the lookup connects with exactly
  // what the form shows, and a guess at the defaults is not that.
  const dbFetchWhy: string | null = isFile
    ? 'Database lookup — not applicable here: a file engine opens a local path'
    : isRedis
      ? 'Database lookup — Redis databases are numbered 0–15; type the number'
      : !(host.trim() && port != null && user.trim())
        ? 'Fill in host, port and user first'
        : null;

  // W5.6: why the database visibility filter is greyed, or null when it
  // applies. Each reason names the mechanism that already does the job.
  const dbFilterWhy: string | null = isFile
    ? 'Database filter — not applicable here: a file engine opens one local path'
    : isRedis
      ? 'Database filter — Redis databases are numbered 0–15; the Database # field picks one'
      : engine === 'postgres'
        ? 'Database filter — PostgreSQL connects to one database; the Database field already scopes the tree'
        : null;

  // The card is draggable by its title bar, so it can be parked aside while
  // credentials are copied out of whatever password manager sits behind it.
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragStart = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  function onTitleDown(e: React.PointerEvent<HTMLElement>) {
    dragStart.current = { px: e.clientX, py: e.clientY, x: drag.x, y: drag.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onTitleMove(e: React.PointerEvent<HTMLElement>) {
    const s = dragStart.current;
    if (!s) return;
    setDrag({ x: s.x + e.clientX - s.px, y: s.y + e.clientY - s.py });
  }
  function onTitleUp() { dragStart.current = null; }

  // A dot on the Advanced tab is the only way to see — without opening it —
  // that an edited connection carries non-default tuning.
  const advancedInUse = !!(connectTimeout || queryTimeout || applicationName
    || socketPath || charset || collation || timeZone || initSql || logDir
    || enableCleartext || poolMax || poolAcquire || poolIdle || stmtTimeout
    || chMaxMemory || chMaxRows || extraRows.some(r => r.k.trim()));

  return (
    <div className="conn-form"
         style={drag.x || drag.y ? { transform: `translate(${drag.x}px, ${drag.y}px)` } : undefined}>
      <h2 className="cf-title" title="Drag to move"
          onPointerDown={onTitleDown} onPointerMove={onTitleMove}
          onPointerUp={onTitleUp} onPointerCancel={onTitleUp}>
        {initial?.id ? 'Edit connection' : 'New connection'}
      </h2>

      <div className="settings-tabs cf-tabs" role="tablist">
        {CF_TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
                  className={`settings-tab${tab === t.id ? ' active' : ''}`}
                  onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'advanced' && tab !== 'advanced' && advancedInUse && (
              <span className="cf-tab-dot" title="Advanced settings in use" />
            )}
          </button>
        ))}
      </div>

      {tab === 'connection' && (<>

      {!initial?.id && (
        <label>Paste connection URL (optional)
          <input
            placeholder="mysql://user:pass@host:3306/db?ssl-mode=REQUIRED — fills the fields below"
            onPaste={e => { const t = e.clipboardData.getData('text'); if (/^\w+:\/\//.test(t)) { e.preventDefault(); pasteUrl(t); } }}
            onChange={e => { if (/^\w+:\/\//.test(e.target.value)) pasteUrl(e.target.value); }}
          />
        </label>
      )}
      {urlWarnings.length > 0 && (
        <p className="form-hint" style={{ margin: 0 }}>
          URL applied with notes: {urlWarnings.join(' · ')}
        </p>
      )}

      <div className="cf-grid">
        <div className="cf-row">
          <label>Engine</label>
          <div className="cf-engine"
               title={engine === 'redis'
                 ? 'Protocol-compatible forks (Valkey, DragonflyDB, KeyDB) generally work but are untested'
                 : undefined}>
            <EngineLogo engine={engine} size={22} title={false} />
            <select value={engine} onChange={e => onEngineChange(e.target.value as Engine)}>
              {(Object.keys(ENGINE_LABELS) as Engine[]).map(k => (
                <option key={k} value={k}>{ENGINE_LABELS[k]}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="cf-row">
          <label>Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="My database" />
        </div>
        {isFile && (
          <div className="cf-row">
            <label>{engine === 'parquet' ? 'File / folder' : 'File'}</label>
            <div className="cf-pair">
              <input value={filePath} onChange={e => setFilePath(e.target.value)}
                     placeholder={engine === 'sqlite'
                       ? '/path/to/database.sqlite'
                       : engine === 'duckdb'
                         ? '/path/to/database.duckdb — or :memory:'
                         : '/path/to/data.parquet — or a dataset folder'}
                     title={engine === 'parquet'
                       ? 'A single Parquet file, or a folder of them opened as one partitioned dataset. Files are immutable — New… creates an empty one with a schema you design, or Export → Parquet writes one from a result grid'
                       : engine === 'duckdb'
                         ? 'The file must already exist — a mistyped path is an error, never a new database'
                         : undefined}
                     style={{ flex: 1 }} />
              <button type="button" className="toolbar-btn" onClick={pickFile}>Browse…</button>
              {engine === 'parquet' && (
                <button type="button" className="toolbar-btn" onClick={pickFolder}
                        title="Open a whole directory of Parquet files as one partitioned dataset — hive key=value folders become filterable columns">
                  Folder…
                </button>
              )}
              {engine === 'sqlite' && (
                <button type="button" className="toolbar-btn" onClick={newSqliteFile}
                        title="Create a new, empty SQLite database (WAL, foreign keys on)">
                  New…
                </button>
              )}
              {engine === 'parquet' && (
                <button type="button" className="toolbar-btn" onClick={() => setShowParquetNew(true)}
                        title="Create a new, empty Parquet file with a schema you design">
                  New…
                </button>
              )}
              {engine === 'duckdb' && (
                <button type="button" className="toolbar-btn"
                        title="In-memory scratch database — nothing on disk; the way to query Parquet/CSV/JSON files with read_parquet() / read_csv() / read_json()"
                        onClick={() => { setFilePath(':memory:'); if (!name.trim()) setName('scratch (memory)'); }}>
                  :memory:
                </button>
              )}
            </div>
          </div>
        )}
        {!isFile && (
        <div className="cf-row">
          <label>Host / Port</label>
          <div className="cf-pair">
            <input value={host ?? ''} onChange={e => setHost(e.target.value)}
                   placeholder={DEFAULT_HOST} style={{ flex: 1 }} />
            {/* '' is the empty state, not 0 — `Number('')` is 0, which is not a port.
                Out-of-range values are rejected at save/test (utils/connValidate). */}
            <input type="number" min={1} max={65535} value={port ?? ''} placeholder={String(engineDefaults.port)}
                   onChange={e => setPort(e.target.value === '' ? null : Number(e.target.value))}
                   style={{ width: 84 }} />
          </div>
        </div>
        )}
        {!isFile && (
        <div className="cf-row">
          <label>User / Pass</label>
          <div className="cf-pair">
            <input value={user ?? ''} onChange={e => setUser(e.target.value)}
                   placeholder={engineDefaults.user || 'user'} style={{ flex: 1 }} />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                   placeholder={engine === 'mysql' && useIamAuth ? 'generated IAM token' : 'password'}
                   readOnly={engine === 'mysql' && useIamAuth}
                   title={engine === 'mysql' && useIamAuth
                     ? 'Cloud SQL IAM mints a short-lived token at connect time; no stored password is used'
                     : undefined}
                   style={{ flex: 1 }} />
          </div>
        </div>
        )}
        {engine === 'mysql' && (
        <div className="cf-row">
          <label>Authentication</label>
          <div className="cf-iam-main">
            <label className="form-check">
              <input type="checkbox" checked={useIamAuth}
                     onChange={e => setUseIamAuth(e.target.checked)} />
              IAM
            </label>
            {useIamAuth && (
              <>
                <input value={iamKeyPath} onChange={e => setIamKeyPath(e.target.value)}
                       placeholder="Credential JSON path — blank uses gcloud application-default credentials"
                       spellCheck={false} />
                <span className="form-hint">
                  User = IAM principal. TxUI mints the short-lived password token automatically;
                  leave the credential path blank after `gcloud auth application-default login`.
                </span>
              </>
            )}
          </div>
        </div>
        )}
        {/* Parquet has no database layer — the file IS the object. DuckDB's
            databases come from the file's catalog (the tree lists them), so
            there is nothing to type here either. */}
        {engine !== 'parquet' && engine !== 'duckdb' && (
        <div className="cf-row">
          {/* Redis has 16 numbered databases and the driver targets one via
              the URL path, so the field is meaningful there too — it was
              hidden, leaving db0 the only reachable database unless a URL
              was pasted. */}
          <label>{isRedis ? 'Database #' : 'Database'}</label>
          <div className="cf-pair">
            <input
              value={database ?? ''}
              onChange={e => setDatabase(e.target.value)}
              placeholder={databasePlaceholder(engine)}
              inputMode={isRedis ? 'numeric' : undefined}
              list={dbOptions.length > 0 ? 'dbgui-db-names' : undefined}
              style={{ flex: 1 }}
            />
            {/* W5.4: fetch the server's database names as suggestions — the
                typed value still wins (datalist, not a select). Greyed with
                the reason when there is nothing to ask: .unavail goes on the
                WRAPPER, not the button — a pointer-events:none button fires
                no hover, so the data-tip would never show (App.css:236). */}
            <span className={dbFetchWhy ? 'unavail' : undefined}
                  data-tip={dbFetchWhy ?? undefined}>
              <button type="button" className="toolbar-btn"
                aria-disabled={dbFetchWhy ? true : undefined}
                title={dbFetchWhy ? undefined : 'Connect with the fields above and list the server’s databases'}
                onClick={() => { if (dbFetchWhy || dbFetching) return; void fetchDatabases(); }}>
                {dbFetching ? 'Fetching…' : 'Fetch'}
              </button>
            </span>
            <datalist id="dbgui-db-names">
              {dbOptions.map(d => <option key={d} value={d} />)}
            </datalist>
          </div>
          {dbListError && <p className="form-hint" style={{ margin: 0 }}>Fetch databases: {dbListError}</p>}
        </div>
        )}
        <div className="cf-row">
          <label>Folder</label>
          <input
            list="dbgui-groups"
            value={group ?? ''}
            onChange={e => setGroup(e.target.value)}
            placeholder="prod/eu — '/' nests; pick existing or type new"
          />
          <datalist id="dbgui-groups">
            {knownGroups.map(g => <option key={g} value={g} />)}
          </datalist>
        </div>
      </div>

      <label>Appearance
        <div className="cf-appearance">
          <div className="cf-swatch-row">
            <span className="cf-swatch-label">Colour</span>
            <button type="button" className={`cf-swatch cf-swatch-none ${color === null ? 'cf-swatch-on' : ''}`}
                    title="no colour" onClick={() => setColor(null)}>∅</button>
            <span className="cf-current" style={color ? { background: color } : undefined} />
          </div>
          <div className="cf-palette">
            {PALETTE.map(c => (
              <button key={c} type="button"
                      className={`cf-chip ${color === c ? 'cf-chip-on' : ''}`}
                      style={{ background: c }} title={c}
                      onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
      </label>

      <label>Environment
        <select value={environment} onChange={e => setEnvironment(e.target.value)}>
          <option value="">— none —</option>
          <option value="dev">dev</option>
          <option value="test">test</option>
          <option value="prod">prod (confirm before writes)</option>
        </select>
      </label>

      {environment === 'prod' && (
        <div className="cf-prod-warn">
          <div className="cf-prod-warn-title">⚠ Production hard limits (server-enforced)</div>
          <label className="form-check">
            <input type="checkbox" checked={prodAllowDdl} onChange={e => setProdAllowDdl(e.target.checked)} />
            Allow destructive DDL (DROP/TRUNCATE/ALTER/…)
          </label>
          <label className="form-check">
            <input type="checkbox" checked={prodAllowUnfiltered} onChange={e => setProdAllowUnfiltered(e.target.checked)} />
            Allow unfiltered UPDATE/DELETE (no WHERE)
          </label>
        </div>
      )}
      </>)}

      {tab === 'options' && (<>
      <div className={`cf-ro${readOnly ? ' cf-ro-on' : ''}`}>
        <label className="form-check cf-ro-toggle"
               title="Every statement is write-checked in the UI and again in the backend; import, datagen, dump/restore and kill are blocked">
          <input type="checkbox" checked={readOnly} onChange={e => setReadOnly(e.target.checked)} />
          <strong>READ-ONLY</strong> — refuse all writes in this session
        </label>
        {readOnly && (
          <div className="cf-ro-note">
            Writes are refused client-side and by the server (
            {engine === 'postgres'
              ? <code>default_transaction_read_only = on</code>
              : engine === 'mysql'
                ? <code>SET SESSION transaction_read_only = 1</code>
                : engine === 'clickhouse'
                  ? <><code>readonly=1</code> on every request</>
                  : engine === 'duckdb'
                    ? <><code>access_mode = READ_ONLY</code> at open</>
                    : engine === 'mongodb'
                      ? <>driver has no write path</>
                      : engine === 'sqlserver'
                        ? <>client-side only — TDS has no read-only flag</>
                        : <>client-side only — Redis has no read-only mode</>}
            ); import, data generation, dump/restore and kill are blocked.
          </div>
        )}
      </div>

      {(engine === 'mysql' || engine === 'postgres') && (
        <div className="cf-block">
          <label className="form-check">
            <input type="checkbox" checked={!autocommit}
                   onChange={e => setAutocommit(!e.target.checked)} />
            <strong>Autocommit off</strong> — Commit / Rollback live for the whole session
          </label>
          {!autocommit && (
            <div className="cf-ro-note">
              The session pins one connection and holds a transaction open on it —
              nothing is durable until you press <strong>Commit</strong>; closing the
              session rolls back.
            </div>
          )}
        </div>
      )}

      <label className="form-check">
        <input type="checkbox" checked={autoConnect} onChange={e => setAutoConnect(e.target.checked)} />
        Connect automatically at launch
      </label>

      <label>Labels (comma-separated)
        <input
          value={labelText}
          onChange={e => setLabelText(e.target.value)}
          placeholder="e.g. cz-test, prod-eu, .billing"
          spellCheck={false}
        />
      </label>
      {/* Labels are not decoration — they are what the 🏷 Fleet checks run
          against, so what a label resolves to has to be visible while typing
          it. A leading dot hides a label from the sidebar without changing
          anything else about it. */}
      <div className="cf-labels">
        {parseLabels(labelText).length === 0 ? (
          <span className="form-hint">
            Fleet checks (drift, index divergence, statistics) run on labels;
            a leading <code>.</code> hides one from the sidebar.
          </span>
        ) : (
          <>
            {parseLabels(labelText).map(l => (
              <span key={l.name} className={`cf-label${l.hidden ? ' cf-label-hidden' : ''}`}
                    title={l.hidden ? 'Hidden — groups and filters, but shows no chip' : 'Shown in the sidebar'}>
                {l.hidden && <span className="cf-label-eye">◌</span>}{l.name}
              </span>
            ))}
          </>
        )}
      </div>

      {/* W5.6 database visibility filter (pgAdmin's DB restriction): on a
          shared host with hundreds of databases the tree shows only these.
          Greyed with the reason where the engine has no database list to
          narrow (.unavail on the WRAPPER, not the input — a disabled input
          fires no hover, so the data-tip would never show). The backend
          applies it in list_schema, so the tree, the database switcher and
          the browser all see the same narrowed list. */}
      <label className={dbFilterWhy ? 'unavail' : undefined}
             data-tip={dbFilterWhy ?? undefined}
             aria-disabled={dbFilterWhy ? true : undefined}>
        Databases to show <span className="form-hint">(comma-separated; blank = all)</span>
        <input
          value={dbFilterText}
          onChange={e => { if (dbFilterWhy) return; setDbFilterText(e.target.value); }}
          placeholder="e.g. shop, shop_staging"
          spellCheck={false}
        />
      </label>
      {!dbFilterWhy && parseDbFilter(dbFilterText).length > 0 && (
        <p className="form-hint" style={{ margin: 0 }}>
          The tree shows exactly these {parseDbFilter(dbFilterText).length}{' '}
          database{parseDbFilter(dbFilterText).length === 1 ? '' : 's'} — names match as the
          server stores them (MySQL is case-sensitive on Linux).
        </p>
      )}

      <label>Notes
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
          placeholder="shown as a sidebar tooltip · searchable" style={{ resize: 'vertical', fontFamily: 'inherit' }} />
      </label>
      </>)}

      {tab === 'security' && (<>

      {/* ── Copy from another connection (W5.5) ─────────────────── */}
      {/* DataGrip's shortcut for the tenth database on the same cluster:
          TLS + SSH SETTINGS of a saved same-engine connection, copied into
          this form. Passwords never come along — they live in the secret
          store keyed by connection id, and the new connection gets its own. */}
      {(() => {
        const sources = securityCopySources(knownConns, engine, initial?.id ?? null);
        const why = isFile
          ? 'Copy security settings — not applicable here: a file engine has no TLS or SSH to copy'
          : sources.length === 0
            ? `Copy security settings — no other saved ${ENGINE_LABELS[engine]} connections`
            : null;
        return (
          <div className={why ? 'form-section unavail' : 'form-section'}
               data-tip={why ?? undefined}
               aria-disabled={why ? true : undefined}>
            <div className="form-row">
              <label style={{ flex: 1 }}>Copy SSL/SSH settings from…
                <select value=""
                        onChange={e => { if (why) return; applySecurityCopy(e.target.value); }}>
                  <option value="" disabled>— choose a connection —</option>
                  {sources.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            </div>
            {!why && (
              <p className="form-hint">
                Copies SSL mode, certificate paths and the SSH tunnel settings
                (incl. the auth choice) — never a password.
              </p>
            )}
          </div>
        );
      })()}

      {/* ── SSH tunnel ──────────────────────────────────────────── */}
      {/* Offered for every client/server engine, greyed for the file engines:
          SQLite/DuckDB/Parquet open a local path, so there is no server to
          tunnel to. Greyed with the reason on hover (the .unavail idiom),
          never hidden — a hidden control reads as "I cannot find it". It was
          once hidden for Redis, but the tunnel was in fact created and then
          IGNORED by the Redis driver, which connected straight to the real
          host — SSH was silently broken, not unsupported. The driver now
          honours the tunnel endpoint. */}
      {/* Greyed on Windows until 0.49.0, when the tunnel got its Windows
          branch (db/ssh.rs). The entry left utils/platformCaps.ts with it —
          leaving it would have had the form say "not implemented yet" about
          something that is. */}
      <div className={isFile ? 'form-section unavail' : 'form-section'}
           data-tip={isFile
             ? 'SSH tunnel — not applicable here: a file engine opens a local path, there is no server to tunnel to'
             : undefined}
           aria-disabled={isFile || undefined}>
          <label className="form-section-toggle">
            <input type="checkbox" checked={useSsh}
                   onChange={e => { if (isFile) return; setUseSsh(e.target.checked); }} />
            SSH tunnel
          </label>

          {/* Six stacked fields took more vertical space than the whole rest
              of the form. Paired onto three lines, with the labels as
              placeholders — every one of them is self-explanatory. */}
          {useSsh && (
            <div className="form-subsection cf-tight">
              <div className="form-row">
                <input style={{ flex: 1 }} value={sshHost}
                       onChange={e => setSshHost(e.target.value)}
                       placeholder="SSH host — bastion.example.com" />
                {/* A cleared box is 0 (`Number('')`), and 0 is NOT a port — it
                    stays in state as-is and save/test reject it with a message,
                    rather than silently becoming 22 in buildConfig. */}
                <input type="number" min={1} max={65535} style={{ flex: '0 0 70px' }} value={sshPort}
                       onChange={e => setSshPort(e.target.value === '' ? 0 : Number(e.target.value))} title="SSH port" />
                <input style={{ flex: '0 0 120px' }} value={sshUser}
                       onChange={e => setSshUser(e.target.value)} placeholder="user" />
              </div>
              <div className="form-row">
                <input style={{ flex: 1 }} value={sshKeyPath}
                       onChange={e => setSshKeyPath(e.target.value)}
                       placeholder="Private key — blank uses ssh-agent / ~/.ssh/id_*" />
                <input style={{ flex: 1 }} value={sshJump}
                       onChange={e => setSshJump(e.target.value)}
                       placeholder="Jump host (optional) — user@host:port" />
              </div>
              {/* Agent status — matters exactly when the key field is blank. */}
              {!sshKeyPath.trim() && !useSshPassword && agentStatus && (
                <div className={`ssh-agent-pill ${agentStatus.available && agentStatus.key_count > 0 ? 'ok' : 'warn'}`}
                     title="With no key and no password, the tunnel authenticates with the ssh-agent's loaded keys (or ~/.ssh/id_*).">
                  {agentStatus.available
                    ? (agentStatus.key_count > 0
                        ? `ssh-agent: ${agentStatus.key_count} key${agentStatus.key_count === 1 ? '' : 's'} loaded`
                        : 'ssh-agent: running, no keys — run ssh-add, or set a key path')
                    : 'ssh-agent: not running — set a key path or enable password auth'}
                </div>
              )}
              <div className="form-row">
                <label className="form-check" style={{ flex: '0 0 auto' }}>
                  <input type="checkbox" checked={useSshPassword}
                         onChange={e => setUseSshPassword(e.target.checked)} />
                  Password auth
                </label>
                {useSshPassword && (
                  <input type="password" style={{ flex: 1 }} value={sshPassword}
                         onChange={e => setSshPassword(e.target.value)}
                         placeholder="SSH password — blank keeps the saved one" />
                )}
              </div>
            </div>
          )}
        </div>

      {/* MySQL IAM lives on the main Connection tab; PostgreSQL stays here. */}
      {engine === 'postgres' && (
        <div className="form-section">
          <label className="form-section-toggle">
            <input type="checkbox" checked={useIamAuth}
                   onChange={e => setUseIamAuth(e.target.checked)} />
            Cloud SQL IAM authentication
          </label>
          {useIamAuth && (
            <div className="form-subsection cf-tight">
              <div className="form-row">
                <input style={{ flex: 1 }} value={iamKeyPath}
                       onChange={e => setIamKeyPath(e.target.value)}
                       placeholder="Service-account key (JSON) path — empty = gcloud ADC" />
              </div>
              <p className="form-hint">
                User = IAM principal; password = short-lived token minted from this key,
                never stored — leave the password blank. Leave the key path empty to use this
                machine's gcloud application-default credentials
                (gcloud auth application-default login).
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Password command (W5.1) ─────────────────────────────── */}
      {/* pgAdmin's password exec: a shell command whose stdout IS the
          password, resolved at connect/test and re-run after the TTL. This
          reopens AWS RDS IAM-style short-lived passwords and covers
          Vault/1Password CLIs generically. Stored in connections.json
          (readable — it is a command, not a secret), never logged. */}
      <div className={isFile ? 'form-section unavail' : 'form-section'}
           data-tip={isFile
             ? 'Password command — not applicable here: a file engine opens a local path, there is no login to authenticate'
             : undefined}
           aria-disabled={isFile || undefined}>
        <label>Password command
          <input value={passwordExec} disabled={isFile}
                 onChange={e => setPasswordExec(e.target.value)}
                 placeholder="op read op://Vault/prod-db/password" spellCheck={false} />
        </label>
        {passwordExec.trim() && (
          <div className="form-row">
            <label style={{ flex: '0 0 200px' }}>Re-run after (seconds)
              <input type="number" min={0} value={passwordExecTtl} disabled={isFile}
                     onChange={e => setPasswordExecTtl(e.target.value)}
                     placeholder="blank = run once per connect" />
            </label>
          </div>
        )}
        <p className="form-hint">
          stdout becomes the password; <code>%HOST% %PORT% %USER% %DATABASE%</code>{' '}
          placeholders; re-run after the TTL — for IAM / Vault / 1Password CLIs.
        </p>
      </div>

      {/* ── SSL / TLS ───────────────────────────────────────────── */}
      {/* Same file-engine treatment as the tunnel: TLS is a property of a
          server connection, and a local file has none. */}
      <div className={isFile ? 'form-section unavail' : 'form-section'}
           data-tip={isFile
             ? 'SSL/TLS — not applicable here: a file engine opens a local path, there is no connection to encrypt'
             : undefined}
           aria-disabled={isFile || undefined}>
          <div className="form-row">
            <label style={{ flex: 1 }}>SSL mode
              <select value={sslMode} onChange={e => { if (isFile) return; setSslMode(e.target.value as SslMode); }}>
                <option value="disable">Disable</option>
                <option value="preferred">Preferred</option>
                <option value="require">Require</option>
                <option value="verify_ca">Verify CA</option>
                <option value="verify_full">Verify (full)</option>
              </select>
            </label>
            <label className="form-check" style={{ flex: '0 0 auto', alignSelf: 'end' }}>
              <input type="checkbox" checked={showSsl} onChange={e => setShowSsl(e.target.checked)} />
              Custom certificates
            </label>
          </div>

          {/* Trust-any-certificate. Only offered where the driver honours it,
              and worded as what it does rather than what it enables: this turns
              verification OFF, unlike the CA path above which narrows it. */}
          {engine === 'sqlserver' && (
            <div className="form-row">
              <label className="form-check">
                <input type="checkbox" checked={trustCert}
                       onChange={e => setTrustCert(e.target.checked)} />
                Trust the server certificate — <strong>disables verification</strong>
              </label>
            </div>
          )}
          {engine === 'sqlserver' && trustCert && (
            <p className="form-hint cf-prod-warn">
              Disables verification — an interceptor can present their own certificate and
              read everything. For dev servers with self-signed certificates only, never
              production; to trust a private CA, set its path under <em>Custom certificates</em>.
            </p>
          )}

          {showSsl && (
            <div className="form-subsection cf-tight">
              {/* Three paths on one line. They are only ever filled in by
                  someone who already knows what each is. */}
              <div className="form-row">
                <input style={{ flex: 1 }} value={sslCaPath}
                       onChange={e => setSslCaPath(e.target.value)} placeholder="CA certificate" />
                <input style={{ flex: 1 }} value={sslCertPath}
                       onChange={e => setSslCertPath(e.target.value)} placeholder="Client certificate (mTLS)" />
                <input style={{ flex: 1 }} value={sslKeyPath}
                       onChange={e => setSslKeyPath(e.target.value)} placeholder="Client key" />
              </div>
              {/* ClickHouse goes over HTTPS through reqwest; it now honours the
                  client certificate + key as a TLS identity (mutual TLS) as well
                  as the CA, so all three paths apply. */}
              {engine === 'clickhouse' && (
                <p className="form-hint">
                  All three apply — client cert + key give mutual TLS (needs an https / 8443 endpoint).
                </p>
              )}
            </div>
          )}
        </div>

      </>)}

      {tab === 'advanced' && (
          <div className="form-subsection">
            {engine === 'clickhouse' && (
              <div className="cf-block">
                <label>Memory &amp; row ceilings{' '}
                  <span className="form-hint">(blank / 0 = no limit)</span>
                  <div className="form-row">
                    <input type="number" min={0} value={chMaxMemory} disabled={readOnly}
                           onChange={e => setChMaxMemory(e.target.value)}
                           placeholder="max_memory_usage (bytes)" style={{ flex: 1 }} />
                    <input type="number" min={0} value={chMaxRows} disabled={readOnly}
                           onChange={e => setChMaxRows(e.target.value)}
                           placeholder="max_rows_to_read (rows)" style={{ flex: 1 }} />
                  </div>
                  <p className="form-hint">
                    {readOnly
                      ? <>Turn off READ-ONLY to set these — <code>readonly=1</code> makes the
                        server reject them.</>
                      : <>Per-query RAM (bytes) and rows-scanned ceilings, sent with every
                        request — the stop against an OOM.</>}
                  </p>
                </label>
              </div>
            )}
            <div className="form-row">
              <label style={{ flex: 1 }}>Connect timeout (s)
                <input type="number" min={0} value={connectTimeout} onChange={e => setConnectTimeout(e.target.value)} placeholder="default" />
              </label>
              {/* Blank and 0 are different answers and the placeholder says so:
                  blank defers to Settings, 0 exempts this connection from a
                  global deadline someone else set. */}
              <label style={{ flex: 1 }} title={
                'Kill a query on this connection after this many seconds. '
                + 'Leave blank to use the Settings value; 0 means no deadline.'}>
                Query timeout (s)
                <input type="number" min={0} value={queryTimeout}
                       onChange={e => setQueryTimeout(e.target.value)}
                       placeholder="from Settings" />
              </label>
              {/* PostgreSQL is the only engine that carries this: it becomes
                  the startup `application_name` and shows in
                  pg_stat_activity. MySQL's equivalent is the `program_name`
                  connection attribute, which is frozen into the handshake and
                  which sqlx gives us no way to send — so for every other
                  engine the field is not shown at all, rather than accepting
                  a value the server will never see. */}
              {engine === 'postgres' && (
                <label style={{ flex: 1 }}>
                  Application name
                  <input value={applicationName} onChange={e => setApplicationName(e.target.value)}
                         placeholder="TxUI" />
                </label>
              )}
            </div>
            {/* Windows has no Unix domain sockets — MySQL there uses a named
                pipe and PostgreSQL is TCP-only. The field is greyed rather
                than removed: the form then has the same shape on every
                desktop, and the reason travels with the control (hover) instead
                of being a sentence that only exists while it is not offered. */}
            <label {...unavailableProps('unix-socket')}>
              Unix socket {engine === 'postgres' ? 'directory' : 'path'}{' '}
              <span className="form-hint">
                {available('unix-socket')
                  ? <>(overrides host/port
                      {engine === 'postgres' ? ' — takes the directory, not the socket file' : ''})</>
                  : <>(not available on Windows — use host/port)</>}
              </span>
              <input
                value={socketPath}
                onChange={e => setSocketPath(e.target.value)}
                disabled={!available('unix-socket')}
                placeholder={engine === 'postgres' ? '/tmp' : '/var/run/mysqld/mysqld.sock'}
              />
            </label>
            {/* charset/collation are MySQL handshake options — PostgreSQL takes
                its encoding from the database, so showing them there implied a
                setting that the backend silently ignores. */}
            {engine === 'mysql' && (
              <div className="form-row">
                <label style={{ flex: 1 }}>Charset
                  <input value={charset} onChange={e => setCharset(e.target.value)} placeholder="utf8mb4" />
                </label>
                <label style={{ flex: 1 }}>Collation
                  <input value={collation} onChange={e => setCollation(e.target.value)} placeholder="server default" />
                </label>
              </div>
            )}
            {/* The driver pins sessions to UTC, which is why TxUI and the
                mysql CLI can show the same TIMESTAMP two hours apart. The
                field is where someone goes once the tuner has told them. */}
            {engine === 'mysql' && (
              <label>Session time zone{' '}
                <span className="form-hint">(blank = UTC, as TxUI has always used)</span>
                <input value={timeZone} onChange={e => setTimeZone(e.target.value)}
                       placeholder="SYSTEM, +02:00, Europe/Prague" list="txui-tz-suggestions" />
                <datalist id="txui-tz-suggestions">
                  <option value="SYSTEM">Match the server&rsquo;s own zone</option>
                  <option value="+00:00">UTC</option>
                </datalist>
                <p className="form-hint">
                  Blank = UTC, so <code>TIMESTAMP</code> can differ from the{' '}
                  <code>mysql</code> CLI — <code>SYSTEM</code> makes them agree.
                  Named zones need the server&rsquo;s time-zone tables loaded.
                </p>
              </label>
            )}
            <label>Init SQL <span className="form-hint">(run once per new pooled connection)</span>
              <textarea value={initSql} onChange={e => setInitSql(e.target.value)} rows={2}
                placeholder={engine === 'postgres'
                  ? "SET statement_timeout = '30s';"
                  : "SET time_zone = '+00:00';"}
                style={{ resize: 'vertical', fontFamily: 'inherit' }} />
            </label>
            <label>Log directory <span className="form-hint">(writes &lt;dir&gt;/&lt;connection&gt;.log; enable in Settings → Logging)</span>
              <input value={logDir} onChange={e => setLogDir(e.target.value)} placeholder="/var/log/txui" />
            </label>
            {engine === 'mysql' && (
              <label className="form-check">
                <input type="checkbox" checked={enableCleartext} onChange={e => setEnableCleartext(e.target.checked)} />
                Enable cleartext auth plugin (mysql_clear_password — needed for PAM)
              </label>
            )}
            <label>Extra params <span className="form-hint">({engine === 'postgres' ? 'startup options' : 'SET SESSION key = value'})</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {extraRows.map((r, i) => (
                  <div key={i} className="cf-pair">
                    <input value={r.k} placeholder="key" style={{ flex: 1 }}
                      onChange={e => setExtraRows(prev => prev.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
                    <input value={r.v} placeholder="value" style={{ flex: 1 }}
                      onChange={e => setExtraRows(prev => prev.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
                    <button type="button" title="Remove" style={{ width: 28 }}
                      onClick={() => setExtraRows(prev => prev.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
                <button type="button" style={{ alignSelf: 'flex-start' }}
                  onClick={() => setExtraRows(prev => [...prev, { k: '', v: '' }])}>+ add param</button>
              </div>
              {/* This field is the general escape hatch, and nothing said so —
                  people were asking for driver options that were already
                  reachable here. Naming a few makes the shape obvious. */}
              {engine === 'mysql' && (
                <p className="form-hint">
                  Any <code>SET SESSION</code> option — e.g. <code>max_allowed_packet</code>,{' '}
                  <code>sql_mode</code>, <code>net_read_timeout</code> — applied to every
                  pooled connection.
                </p>
              )}
            </label>
            <label>Pool <span className="form-hint">(blank = backend defaults)</span>
              <div className="form-row">
                <input type="number" min={0} value={poolMax} onChange={e => setPoolMax(e.target.value)} placeholder="max conns" style={{ flex: 1 }} />
                <input type="number" min={0} value={poolAcquire} onChange={e => setPoolAcquire(e.target.value)} placeholder="acquire s" style={{ flex: 1 }} />
                <input type="number" min={0} value={poolIdle} onChange={e => setPoolIdle(e.target.value)} placeholder="idle s" style={{ flex: 1 }} />
              </div>
            </label>
            {engine !== 'redis' && engine !== 'sqlite' && engine !== 'parquet' && engine !== 'duckdb' && engine !== 'mongodb' && engine !== 'sqlserver' && (
              <label>Statement timeout <span className="form-hint">(seconds; blank = leave the server alone)</span>
                <input type="number" min={0} value={stmtTimeout}
                  onChange={e => setStmtTimeout(e.target.value)} placeholder="e.g. 30" />
                <p className="form-hint">
                  {engine === 'mysql'
                    ? <><code>max_execution_time</code> — bounds read-only SELECTs only,
                      not writes.</>
                    : engine === 'clickhouse'
                    ? <><code>max_execution_time</code>, applied to every query.</>
                    : <><code>statement_timeout</code> — reads and writes alike.</>}
                </p>
              </label>
            )}
          </div>
      )}

      {error && <p className="error">{error}</p>}
      {initial?.id && (
        <p className="form-hint" style={{ margin: 0 }}>
          Blank password fields keep the saved secrets — for Save and Test alike.
        </p>
      )}
      {testResult && (
        <p style={{ margin: 0, fontSize: 'calc(12px * var(--font-scale, 1))', color: testResult.ok ? 'var(--green)' : 'var(--red)', whiteSpace: 'pre-wrap' }}>
          {testResult.msg}
        </p>
      )}
      {testDiag && <ConnDiagChecklist result={testDiag} />}

      <div className="form-actions">
        <button onClick={handleTest} disabled={saving || testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {showParquetNew && (
        <ParquetSchemaDialog
          onCancel={() => setShowParquetNew(false)}
          onCreated={path => {
            setShowParquetNew(false);
            setFilePath(path);
            if (!name.trim()) {
              setName(basename(path).replace(/\.[^.]+$/, '') ?? path);
            }
            setError(null);
          }}
        />
      )}
    </div>
  );
}
