/**
 * Copy SSL/SSH settings from another connection (src/utils/connSecurity.ts, W5.5).
 *
 * The behaviour this locks in: the copy carries TLS/SSH SETTINGS and the
 * password-auth CHOICE, but no secret is ever part of the shape; the source
 * list is same-engine, excludes the connection being edited, and is sorted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityCopyFrom, securityCopySources } from '../src/utils/connSecurity.ts';
import type { ConnectionConfig } from '../src/types/index.ts';

function cfg(over: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: 'id', name: 'conn', engine: 'postgres',
    ssl_mode: 'preferred', trust_server_cert: false,
    ssl_ca_path: null, ssl_cert_path: null, ssl_key_path: null,
    use_ssh: false, ssh_host: null, ssh_port: null, ssh_user: null,
    ssh_key_path: null, ssh_jump: null, use_ssh_password: false,
    ...over,
  } as unknown as ConnectionConfig;
}

test('nulls become the form’s empty values, flags are real booleans', () => {
  const c = securityCopyFrom(cfg({}));
  assert.deepEqual(c, {
    ssl_mode: 'preferred',
    ssl_ca_path: '', ssl_cert_path: '', ssl_key_path: '',
    trust_server_cert: false, has_custom_certs: false,
    use_ssh: false, ssh_host: '', ssh_port: 22, ssh_user: '',
    ssh_key_path: '', ssh_jump: '', use_ssh_password: false,
  });
});

test('a full bastion + mTLS setup copies whole, minus secrets', () => {
  const c = securityCopyFrom(cfg({
    ssl_mode: 'verify_full',
    ssl_ca_path: '/ca.pem', ssl_cert_path: '/cert.pem', ssl_key_path: '/key.pem',
    use_ssh: true, ssh_host: 'bastion.example.com', ssh_port: 2222,
    ssh_user: 'deploy', ssh_key_path: '/keys/id_ed25519', ssh_jump: 'ops@jump:22',
    use_ssh_password: true,
  }));
  assert.equal(c.ssl_mode, 'verify_full');
  assert.equal(c.has_custom_certs, true);
  assert.deepEqual(
    [c.ssh_host, c.ssh_port, c.ssh_user, c.ssh_key_path, c.ssh_jump],
    ['bastion.example.com', 2222, 'deploy', '/keys/id_ed25519', 'ops@jump:22'],
  );
  // The AUTH CHOICE copies; the password itself is not in the shape at all.
  assert.equal(c.use_ssh_password, true);
  assert.ok(!('password' in c) && !('ssh_password' in c));
});

test('sources: same engine only, self excluded, sorted by name', () => {
  const all = [
    cfg({ id: 'a', name: 'zeta', engine: 'postgres' }),
    cfg({ id: 'b', name: 'alpha', engine: 'postgres' }),
    cfg({ id: 'c', name: 'my', engine: 'mysql' }),
  ];
  assert.deepEqual(securityCopySources(all, 'postgres', 'a').map(c => c.id), ['b']);
  assert.deepEqual(securityCopySources(all, 'postgres').map(c => c.id), ['b', 'a']);
  assert.deepEqual(securityCopySources(all, 'redis'), []);
});
