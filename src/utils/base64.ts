/**
 * Base64 encoding of binary payloads for the Tauri bridge.
 *
 * `invoke` args are JSON; a `number[]` for a byte buffer costs ~4 bytes of
 * JSON per byte of payload plus a second parse allocation — a 20 MB xlsx
 * became ~140 MB of string. A base64 string is 4/3 the payload and crosses
 * as one string, decoded in Rust (`write_binary_file`).
 *
 * Pure by the utils contract: `btoa` is a global in both the WebView and
 * Node (≥16), so this runs under `node --test` unchanged.
 */

/** Chunk size for the String.fromCharCode spread — past ~64k args the spread blows the call stack. */
const CHUNK = 0x8000;

/** Encode bytes as base64. Empty input encodes to the empty string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
