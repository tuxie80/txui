/**
 * "Copy SSL/SSH settings from another connection" (W5.5, DataGrip).
 *
 * Setting up mutual TLS or a bastion for the tenth database on the same
 * cluster is retyping the same six paths. The Security tab offers a
 * "Copy from…" select of the other saved connections; choosing one copies the
 * TLS/SSH SETTINGS — never a secret. Passwords and key passphrases live in the
 * secret store keyed by connection id, so they are structurally absent here:
 * `use_ssh_password` copies the AUTH CHOICE, not a password, and the new
 * connection still gets its own.
 *
 * Compatibility rule: same engine. SSL modes mean different things per driver
 * (ClickHouse is HTTPS, SQL Server has its own trust flag), and a copied CA
 * path that silently does nothing is worse than no copy.
 *
 * Pure module: no React/Tauri imports, unit-tested with `node --test`.
 */
import type { ConnectionConfig, SslMode } from '../types';

/** The copyable security settings, in form-field shape (empty = unset). */
export interface SecurityCopy {
  ssl_mode: SslMode;
  ssl_ca_path: string;
  ssl_cert_path: string;
  ssl_key_path: string;
  trust_server_cert: boolean;
  /** True when the source carries any custom certificate path — the form's
   *  "Custom certificates" toggle follows it. */
  has_custom_certs: boolean;
  use_ssh: boolean;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_path: string;
  ssh_jump: string;
  use_ssh_password: boolean;
}

/** The settings of `src` as form values. Secrets are never part of this. */
export function securityCopyFrom(src: ConnectionConfig): SecurityCopy {
  return {
    ssl_mode: src.ssl_mode,
    ssl_ca_path: src.ssl_ca_path ?? '',
    ssl_cert_path: src.ssl_cert_path ?? '',
    ssl_key_path: src.ssl_key_path ?? '',
    trust_server_cert: !!src.trust_server_cert,
    has_custom_certs: !!(src.ssl_ca_path || src.ssl_cert_path || src.ssl_key_path),
    use_ssh: src.use_ssh,
    ssh_host: src.ssh_host ?? '',
    ssh_port: src.ssh_port ?? 22,
    ssh_user: src.ssh_user ?? '',
    ssh_key_path: src.ssh_key_path ?? '',
    ssh_jump: src.ssh_jump ?? '',
    use_ssh_password: src.use_ssh_password,
  };
}

/**
 * The connections a "Copy from…" select may list: same engine, not the
 * connection being edited. Sorted by name for a stable menu.
 */
export function securityCopySources(
  configs: ConnectionConfig[],
  engine: ConnectionConfig['engine'],
  excludeId?: string | null,
): ConnectionConfig[] {
  return configs
    .filter(c => c.engine === engine && c.id !== excludeId)
    .sort((a, b) => a.name.localeCompare(b.name));
}
