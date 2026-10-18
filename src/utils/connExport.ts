/**
 * Connection export/import shapes (W5.2).
 *
 * Two envelopes exist:
 *   - plain:     `{ version: 1, connections: [...] }` — configs only, never
 *                secrets (the default, produced by `export_connections`);
 *   - encrypted: `{ v: 1, kdf: …, … }` — passphrase-protected, secrets
 *                included (opt-in, `export_connections_encrypted`).
 *
 * Import has to tell them apart BEFORE asking for a passphrase, so detection
 * is structural and deliberately narrow: the encrypted envelope alone carries
 * a `kdf` block under the short `v` key.
 *
 * Pure module: no React/Tauri imports, unit-tested with `node --test`.
 */

/** True when the file content is the passphrase-protected envelope. */
export function isEncryptedExport(json: string): boolean {
  try {
    const o: unknown = JSON.parse(json);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const r = o as Record<string, unknown>;
    return r.v === 1 && r.kdf != null && typeof r.kdf === 'object';
  } catch {
    return false;
  }
}
