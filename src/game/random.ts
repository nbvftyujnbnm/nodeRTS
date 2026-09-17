/**
 * Cross-platform random token generator.
 *
 * The game simulation runs both on the Node server and, in peer-to-peer mode,
 * inside the host player's browser, so it cannot depend on `node:crypto`.
 * `crypto.getRandomValues` is available in Node 18+ and every modern browser.
 */
export function randomToken(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
