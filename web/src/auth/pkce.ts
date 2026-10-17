const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** RFC 7636 code_verifier: 43-128 chars from the unreserved set. */
export function generateVerifier(length = 64): string {
  if (length < 43 || length > 128) throw new RangeError('verifier length must be 43-128');
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  // 256 % 66 != 0 gives a slight bias; irrelevant for a one-shot 64-char secret but cheap to avoid.
  let out = '';
  for (let i = 0; i < length; i++) out += UNRESERVED[bytes[i]! % UNRESERVED.length];
  return out;
}

export function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** code_challenge = BASE64URL(SHA256(ASCII(verifier))) */
export async function challengeS256(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function randomState(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}
