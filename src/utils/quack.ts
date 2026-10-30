export const QUACK_SSL_FINGERPRINT_PARAM = 'quack_ssl_fingerprint';

export interface QuackUriParts {
  /** Endpoint only — never contains userinfo, a token, query or fragment. */
  endpoint: string;
  host: string;
  port: number | null;
  /** Secret returned separately for the form's existing password field. */
  password: string | null;
}

export function isQuackUri(raw: string): boolean {
  return raw.trim().slice(0, 6).toLowerCase() === 'quack:';
}

/**
 * Accept DuckDB's quack:host and quack://host forms. A password in userinfo is
 * separated for the normal secret-store path; usernames and query credentials
 * are rejected because Quack authenticates with a token, not a user/login pair.
 */
export function parseQuackUri(raw: string): QuackUriParts | null {
  const input = raw.trim();
  if (!isQuackUri(input)) return null;
  const rest = input.slice(6);
  if (!rest || /[\s?#]/.test(rest)) return null;
  try {
    const u = new URL(`quack://${rest.replace(/^\/\//, '')}`);
    if (!u.hostname || u.username) return null;
    const password = u.password ? decodeURIComponent(u.password) : null;
    return {
      endpoint: `quack://${u.host}`,
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port ? Number(u.port) : null,
      password,
    };
  } catch {
    return null;
  }
}

export function quackPathError(raw: string): string | null {
  return parseQuackUri(raw)
    ? null
    : 'Use quack:host[:port] (token goes in the password field, not the URI)';
}
