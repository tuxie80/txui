/**
 * Connection URL parsing: `mysql://user:pass@host:3306/db?ssl-mode=REQUIRED`
 * and friends → structured fields for the connection form.
 *
 * The old paste handler silently dropped every query param, so
 * `postgres://u@h/db?sslmode=require` connected without SSL. This parser maps
 * known params onto structured fields, keeps the rest in `extraParams`, and
 * reports anything it could not map in `warnings` — nothing is ever lost.
 *
 * Pure module: no React/Tauri imports, unit-tested with `node --test`.
 */

/**
 * ClickHouse per-connection memory / row ceilings, stored as ordinary session
 * settings in `extra_params` under their ClickHouse names. `max_execution_time`
 * bounds time but time alone won't stop an OOM; these bound RAM and rows read.
 *
 * The form owns these two keys directly (dedicated inputs), so they are lifted
 * out of the generic Extra-params editor to avoid showing the same key twice.
 */
export const CH_CEILING_KEYS = ['max_memory_usage', 'max_rows_to_read'] as const;

/**
 * The `extra_params` entries for the chosen ceilings. Blank / zero / negative /
 * non-integer means "no limit" and omits the key — matching the backend, where
 * 0/None attaches nothing and leaves behaviour unchanged.
 */
export function clickhouseCeilingParams(
  maxMemoryUsage: string, maxRowsToRead: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (key: string, raw: string) => {
    const t = raw.trim();
    if (!t) return;
    const n = Number(t);
    if (Number.isInteger(n) && n > 0) out[key] = String(n);
  };
  add('max_memory_usage', maxMemoryUsage);
  add('max_rows_to_read', maxRowsToRead);
  return out;
}

/** Same values as the app's SslMode (src/types) including the new verify_ca. */
export type UrlSslMode = 'disable' | 'preferred' | 'require' | 'verify_ca' | 'verify_full';
export type UrlEngine = 'mysql' | 'postgres' | 'redis' | 'clickhouse' | 'mongodb' | 'sqlserver';

export interface ParsedConnectionUrlOk {
  ok: true;
  engine: UrlEngine;
  /** null when the URL uses a unix socket instead (see socketPath). */
  host: string | null;
  port: number | null;
  user: string | null;
  /** Returned separately so the caller can treat it as a secret. */
  password: string | null;
  database: string | null;
  sslMode: UrlSslMode | null;
  connectTimeoutSecs: number | null;
  applicationName: string | null;
  socketPath: string | null;
  /** redis:// only: numeric path segment (`redis://h/2` → 2). */
  redisDb: number | null;
  /** `?readonly=1` (ClickHouse's own spelling) → the form's READONLY box. */
  readOnly: boolean;
  /** Known-but-unstructured params (charset, options, …) plus anything unknown. */
  extraParams: Record<string, string>;
  /** Human-readable notes about params that could not be mapped cleanly. */
  warnings: string[];
}

export interface ParsedConnectionUrlErr {
  ok: false;
  error: string;
}

export type ParsedConnectionUrl = ParsedConnectionUrlOk | ParsedConnectionUrlErr;

const SCHEMES: Record<string, UrlEngine> = {
  mysql: 'mysql',
  mariadb: 'mysql',
  postgres: 'postgres',
  postgresql: 'postgres',
  redis: 'redis',
  rediss: 'redis',
  clickhouse: 'clickhouse',
  clickhouses: 'clickhouse',
  // clickhouse-connect / SQLAlchemy spellings.
  'clickhouse+http': 'clickhouse',
  'clickhouse+https': 'clickhouse',
  // mongodb+srv is DNS-SRV discovery; it also implies TLS (handled below).
  mongodb: 'mongodb',
  'mongodb+srv': 'mongodb',
  // mssql is the common short spelling (node-mssql, JDBC urls use
  // jdbc:sqlserver:// — the jdbc: wrapper is not a URL and is not parsed).
  sqlserver: 'sqlserver',
  mssql: 'sqlserver',
};

/** MySQL `ssl-mode` / MariaDB values → app SslMode. */
const MYSQL_SSL: Record<string, UrlSslMode> = {
  disable: 'disable',
  disabled: 'disable',
  preferred: 'preferred',
  prefer: 'preferred',
  required: 'require',
  require: 'require',
  verify_ca: 'verify_ca',
  verify_identity: 'verify_full',
  verify_full: 'verify_full',
};

/** libpq `sslmode` values → app SslMode. */
const PG_SSL: Record<string, UrlSslMode> = {
  disable: 'disable',
  prefer: 'preferred',
  preferred: 'preferred',
  require: 'require',
  required: 'require',
  'verify-ca': 'verify_ca',
  'verify-full': 'verify_full',
};

/** PG params that are known but have no structured field — kept in extraParams without a warning. */
const PG_KNOWN_PASSTHROUGH = new Set(['options', 'statement_timeout', 'search_path', 'lock_timeout']);

function fail(error: string): ParsedConnectionUrlErr {
  return { ok: false, error };
}

function tryDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Parse the raw query string manually (not URLSearchParams) so `+` stays a
 * literal plus and malformed percent-escapes survive as warnings instead of
 * throwing.
 */
function parseQuery(search: string): Array<[string, string]> {
  const raw = search.replace(/^\?/, '');
  if (!raw) return [];
  return raw.split('&').filter(Boolean).map(pair => {
    const eq = pair.indexOf('=');
    return eq === -1 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
  });
}

export function parseConnectionUrl(raw: string): ParsedConnectionUrl {
  let input = raw.trim();
  if (!input) return fail('empty URL');

  // ADO-style `host\instance`: a backslash is not a valid URL host character,
  // and the driver does no named-instance resolution (UDP 1434 is off), so
  // strip the instance and say so rather than failing the whole parse.
  let instanceNote: string | null = null;
  const inst = /^((?:sqlserver|mssql):\/\/[^/?]*?[^/\\:?])\\([^\\/:?]+)(.*)$/i.exec(input);
  if (inst) {
    instanceNote = `named instance "${inst[2]}" is not supported — the connection uses ` +
      'the host (and port) alone; point it at the instance\'s port instead';
    input = inst[1] + inst[3];
  }

  let u: URL;
  let emptyHostRetry = false;
  try {
    u = new URL(input);
  } catch {
    // libpq style `postgres://user@/db`: userinfo with an empty host means a
    // local-socket connection, but WHATWG URL rejects it. Retry with a
    // placeholder host and treat the host as absent.
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^@/?]*@)\//i.exec(input);
    if (!m) return fail(`not a valid URL: ${input}`);
    try {
      u = new URL(m[1] + 'placeholder.invalid' + input.slice(m[1].length));
      emptyHostRetry = true;
    } catch {
      return fail(`not a valid URL: ${input}`);
    }
  }

  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  const engine = SCHEMES[scheme];
  if (!engine) return fail(`unsupported scheme "${u.protocol}" (expected mysql://, mariadb://, postgres://, postgresql://, redis://, rediss://, clickhouse://, mongodb://, mongodb+srv://, sqlserver:// or mssql://)`);

  const warnings: string[] = [];
  if (instanceNote) warnings.push(instanceNote);
  const extraParams: Record<string, string> = {};
  let sslMode: UrlSslMode | null = null;
  let connectTimeoutSecs: number | null = null;
  let applicationName: string | null = null;
  let socketPath: string | null = null;

  // WHATWG URL keeps the brackets on IPv6 literals — strip them, then decode.
  // A host that decodes to a path (libpq style postgres://u@%2Fvar%2Frun/db)
  // is a unix-socket location, not a host.
  let host: string | null = null;
  if (!emptyHostRetry && u.hostname) {
    const decoded = tryDecode(u.hostname.replace(/^\[|\]$/g, '')) ?? u.hostname;
    if (decoded.startsWith('/')) socketPath = decoded;
    else host = decoded;
  }
  const port = u.port ? Number(u.port) : null;

  let user: string | null = null;
  if (u.username) {
    user = tryDecode(u.username);
    if (user === null) { user = u.username; warnings.push('username has malformed percent-encoding, kept as-is'); }
  }
  let password: string | null = null;
  if (u.password) {
    password = tryDecode(u.password);
    if (password === null) { password = u.password; warnings.push('password has malformed percent-encoding, kept as-is'); }
  }

  // Path segment: database name, or a numeric db index for redis.
  const pathSeg = u.pathname.replace(/^\//, '');
  let database: string | null = null;
  let redisDb: number | null = null;
  let readOnly = false;
  if (pathSeg) {
    const decoded = tryDecode(pathSeg) ?? pathSeg;
    if (engine === 'redis') {
      if (/^\d+$/.test(decoded)) {
        redisDb = Number(decoded);
      } else {
        database = decoded;
        warnings.push(`redis path "${decoded}" is not a numeric db index, kept as database name`);
      }
    } else {
      database = decoded;
    }
  }

  // rediss:// implies TLS.
  if (scheme === 'rediss') sslMode = 'require';
  // Same for the TLS spellings of ClickHouse.
  if (scheme === 'clickhouses' || scheme === 'clickhouse+https') sslMode = 'require';
  // mongodb+srv implies TLS by spec (the SRV record points at TLS listeners).
  if (scheme === 'mongodb+srv') sslMode = 'require';
  // We speak the HTTP interface only. Port 9000 is the native protocol — a
  // paste of it would connect to nothing, so say so rather than fail obscurely.
  if (engine === 'clickhouse' && (port === 9000 || port === 9440)) {
    warnings.push(
      `port ${port} is the ClickHouse native protocol; this client speaks the ` +
      'HTTP interface (8123, or 8443 for TLS) — change the port if the connection fails',
    );
  }

  const setTimeoutParam = (rawVal: string, key: string) => {
    const n = Number(rawVal);
    if (Number.isInteger(n) && n > 0) {
      connectTimeoutSecs = n;
    } else {
      warnings.push(`invalid ${key} value "${rawVal}" (expected positive integer seconds), kept in extraParams`);
      extraParams[key] = rawVal;
    }
  };

  const setSslParam = (rawVal: string, key: string, table: Record<string, UrlSslMode>) => {
    const mode = table[rawVal.toLowerCase()];
    if (mode) {
      sslMode = mode;
    } else {
      warnings.push(`unknown ${key} value "${rawVal}", kept in extraParams`);
      extraParams[key] = rawVal;
    }
  };

  for (const [rawKey, rawVal] of parseQuery(u.search)) {
    const key = (tryDecode(rawKey) ?? rawKey).toLowerCase();
    const val = tryDecode(rawVal) ?? rawVal;

    if (engine === 'mysql') {
      switch (key) {
        case 'ssl-mode': case 'sslmode': setSslParam(val, key, MYSQL_SSL); continue;
        case 'connect-timeout': case 'connect_timeout': case 'timeout': setTimeoutParam(val, key); continue;
        case 'socket': case 'unix_socket': socketPath = val; continue;
        case 'program_name': applicationName = val; continue;
        case 'charset': case 'collation': extraParams[key] = val; continue; // known, unstructured
        default: break;
      }
    } else if (engine === 'postgres') {
      switch (key) {
        case 'sslmode': setSslParam(val, key, PG_SSL); continue;
        case 'connect_timeout': setTimeoutParam(val, key); continue;
        case 'application_name': applicationName = val; continue;
        case 'host':
          // libpq: a host value starting with / is a unix-socket directory.
          if (val.startsWith('/')) socketPath = val;
          else extraParams[key] = val;
          continue;
        default:
          if (PG_KNOWN_PASSTHROUGH.has(key)) { extraParams[key] = val; continue; }
          break;
      }
    } else if (engine === 'mongodb') {
      switch (key) {
        // MongoDB spells TLS as `tls=true` (older: `ssl=true`).
        case 'tls': case 'ssl':
          if (val === 'true' || val === '1') sslMode = 'require';
          else if (val === 'false' || val === '0') sslMode = 'disable';
          else { warnings.push(`unknown ${key} value "${val}", kept in extraParams`); extraParams[key] = val; }
          continue;
        // Milliseconds in the URI spec — stored as the app's seconds.
        case 'connecttimeoutms': {
          const n = Number(val);
          if (Number.isInteger(n) && n > 0) connectTimeoutSecs = Math.max(1, Math.ceil(n / 1000));
          else { warnings.push(`invalid ${key} value "${val}" (expected positive integer ms), kept in extraParams`); extraParams[key] = val; }
          continue;
        }
        case 'appname': applicationName = val; continue;
        // Known URI options the backend's URI builder applies verbatim —
        // stored under their canonical camelCase spelling (the param key was
        // lowercased for matching, but the backend allowlist is case-sensitive).
        case 'authsource': extraParams['authSource'] = val; continue;
        case 'replicaset': extraParams['replicaSet'] = val; continue;
        case 'directconnection': extraParams['directConnection'] = val; continue;
        default: break;
      }
    } else if (engine === 'sqlserver') {
      switch (key) {
        // ADO/JDBC spellings. `encrypt` maps onto the SSL mode: false = plain,
        // true = encrypted, strict (TDS 8) = full verification.
        case 'encrypt':
          if (val === 'true' || val === 'yes' || val === 'mandatory') sslMode = 'require';
          else if (val === 'strict') sslMode = 'verify_full';
          else if (val === 'false' || val === 'no') sslMode = 'disable';
          else { warnings.push(`unknown encrypt value "${val}", kept in extraParams`); extraParams[key] = val; }
          continue;
        case 'trustservercertificate':
          // ConnectionConfig has no trust-cert field — the driver never accepts
          // an unverifiable certificate (db/sqlserver.rs module docs). Say so
          // rather than silently honouring or silently dropping the flag.
          if (val === 'true' || val === 'yes') {
            warnings.push(
              'trustServerCertificate is not supported by this client — a self-signed ' +
              'server certificate will fail verification (no opt-in exists yet)',
            );
          }
          continue;
        case 'instancename': case 'instance':
          warnings.push(
            `named instance "${val}" is not supported — connect by host:port instead`,
          );
          continue;
        case 'connection timeout': case 'connecttimeout': case 'timeout':
          setTimeoutParam(val, key);
          continue;
        default: break;
      }
    } else if (engine === 'clickhouse') {      switch (key) {
        // `secure=1` is how clickhouse-driver spells TLS; the HTTP interface
        // itself has no ssl param, the scheme decides.
        case 'secure': case 'ssl':
          if (val === '1' || val === 'true') sslMode = 'require';
          else if (val === '0' || val === 'false') sslMode = 'disable';
          else { warnings.push(`unknown ${key} value "${val}", kept in extraParams`); extraParams[key] = val; }
          continue;
        case 'connect_timeout': case 'connection_timeout': setTimeoutParam(val, key); continue;
        // readonly=1 is a server-enforced setting, not a client convention —
        // it maps straight onto the connection's READONLY box.
        case 'readonly':
          if (val === '1' || val === '2') readOnly = true;
          else if (val === '0') readOnly = false;
          else { warnings.push(`unknown readonly value "${val}", kept in extraParams`); extraParams[key] = val; }
          continue;
        // Everything else is a legitimate ClickHouse session setting
        // (max_threads, max_memory_usage, …) — carried through untouched.
        default:
          extraParams[key] = val;
          continue;
      }
    }

    // Unknown for this engine — never silently dropped.
    extraParams[key] = val;
    warnings.push(`unknown param "${key}" for ${engine}, kept in extraParams`);
  }

  return {
    ok: true, engine, host, port, user, password, database,
    sslMode, connectTimeoutSecs, applicationName, socketPath, redisDb, readOnly,
    extraParams, warnings,
  };
}

/** Fields accepted by buildConnectionUrl — mirrors ParsedConnectionUrlOk minus diagnostics. */
export interface ConnectionUrlFields {
  engine: UrlEngine;
  host?: string | null;
  port?: number | null;
  user?: string | null;
  database?: string | null;
  sslMode?: UrlSslMode | null;
  connectTimeoutSecs?: number | null;
  applicationName?: string | null;
  socketPath?: string | null;
  redisDb?: number | null;
  readOnly?: boolean;
  extraParams?: Record<string, string>;
}

/** Canonical driver spellings for the URL form of each ssl mode. */
const SSL_TO_MYSQL: Record<UrlSslMode, string> = {
  disable: 'DISABLED', preferred: 'PREFERRED', require: 'REQUIRED',
  verify_ca: 'VERIFY_CA', verify_full: 'VERIFY_IDENTITY',
};
const SSL_TO_PG: Record<UrlSslMode, string> = {
  disable: 'disable', preferred: 'prefer', require: 'require',
  verify_ca: 'verify-ca', verify_full: 'verify-full',
};

/**
 * Inverse of parseConnectionUrl: fields → URL string. The password is
 * deliberately omitted — this is for "copy as URL" sharing, not for secrets.
 */
export function buildConnectionUrl(f: ConnectionUrlFields): string {
  const params: Array<[string, string]> = [];

  // rediss:// when redis runs over TLS, else the plain engine scheme.
  let scheme: string = f.engine;
  if (f.engine === 'redis' && f.sslMode && f.sslMode !== 'disable') scheme = 'rediss';
  if (f.engine === 'clickhouse' && f.sslMode && f.sslMode !== 'disable') scheme = 'clickhouses';

  if (f.engine === 'mysql' && f.sslMode) params.push(['ssl-mode', SSL_TO_MYSQL[f.sslMode]]);
  if (f.engine === 'postgres' && f.sslMode) params.push(['sslmode', SSL_TO_PG[f.sslMode]]);
  // MongoDB's URI spelling of TLS is a param, not a scheme variant.
  if (f.engine === 'mongodb' && f.sslMode && f.sslMode !== 'disable') params.push(['tls', 'true']);
  if (f.engine === 'mongodb' && f.sslMode === 'disable') params.push(['tls', 'false']);
  // SQL Server's is `encrypt` — strict (TDS 8) is the full-verification form.
  if (f.engine === 'sqlserver' && f.sslMode) {
    params.push(['encrypt', f.sslMode === 'disable' ? 'false'
      : f.sslMode === 'verify_full' ? 'strict' : 'true']);
  }
  // ClickHouse has no ssl param — the scheme carries it (see below) — but
  // readonly is a real server setting, so it round-trips through the URL.
  if (f.engine === 'clickhouse' && f.readOnly) params.push(['readonly', '1']);
  if (f.connectTimeoutSecs != null) {
    // MongoDB's URI spec takes milliseconds; the others take seconds.
    if (f.engine === 'mongodb') params.push(['connectTimeoutMS', String(f.connectTimeoutSecs * 1000)]);
    else if (f.engine === 'sqlserver') params.push(['connection timeout', String(f.connectTimeoutSecs)]);
    else params.push([f.engine === 'postgres' ? 'connect_timeout' : 'connect-timeout', String(f.connectTimeoutSecs)]);
  }
  if (f.applicationName) {
    params.push([f.engine === 'mysql' ? 'program_name' : f.engine === 'mongodb' ? 'appName' : 'application_name', f.applicationName]);
  }
  if (f.socketPath) {
    params.push([f.engine === 'postgres' ? 'host' : 'socket', f.socketPath]);
  }
  for (const [k, v] of Object.entries(f.extraParams ?? {})) params.push([k, v]);

  const userinfo = f.user ? `${encodeURIComponent(f.user)}@` : '';
  // Socket URLs carry a placeholder authority host (an empty one is invalid
  // once userinfo is present); the socket param takes precedence on parse.
  let authority: string;
  if (f.socketPath) {
    authority = 'localhost';
  } else {
    const h = f.host ?? 'localhost';
    authority = h.includes(':') ? `[${h}]` : h;
  }
  if (f.port != null) authority += `:${f.port}`;

  const db = f.engine === 'redis' && f.redisDb != null
    ? String(f.redisDb)
    : (f.database ? encodeURIComponent(f.database) : '');

  const qs = params.length
    ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';
  return `${scheme}://${userinfo}${authority}${db ? `/${db}` : ''}${qs}`;
}
