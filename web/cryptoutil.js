// Password verifier and cost encryption on Web Crypto. Keys live only in memory.
const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

export const DEFAULT_ITERATIONS = 600000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const HASH_PREFIX = 'pbkdf2-sha256';

export function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export function newSalt() {
  return toBase64(globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

async function pbkdf2Bits(password, saltB64, iterations) {
  const material = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const params = { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(saltB64), iterations };
  return new Uint8Array(await subtle.deriveBits(params, material, 256));
}

// Verifier format: pbkdf2-sha256$<iterations>$<salt>$<hash>, all base64 where binary.
export async function hashPassword(password, iterations) {
  const salt = newSalt();
  const hash = toBase64(await pbkdf2Bits(password, salt, iterations));
  return `${HASH_PREFIX}$${iterations}$${salt}$${hash}`;
}

export function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const [prefix, iterations, salt, hash, extra] = stored.split('$');
  const count = Number(iterations);
  if (prefix !== HASH_PREFIX || extra !== undefined || !salt || !hash) return null;
  if (!Number.isInteger(count) || count < 1) return null;
  return { iterations: count, salt, hash };
}

export async function checkPassword(stored, password) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const actual = await pbkdf2Bits(password, parsed.salt, parsed.iterations);
  const expected = fromBase64(parsed.hash);
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ (expected[i] ?? 0);
  return diff === 0;
}

export async function deriveKey(password, saltB64, iterations) {
  const bits = await pbkdf2Bits(password, saltB64, iterations);
  return subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export class InvalidToken extends Error {}

// Token: base64(iv || ciphertext+tag).
export async function encryptInt(key, value) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(String(value))));
  const token = new Uint8Array(iv.length + sealed.length);
  token.set(iv);
  token.set(sealed, iv.length);
  return toBase64(token);
}

export async function decryptInt(key, token) {
  try {
    const bytes = fromBase64(token);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) }, key, bytes.slice(IV_BYTES));
    const value = Number(new TextDecoder().decode(plain));
    if (!Number.isInteger(value)) throw new InvalidToken('bad payload');
    return value;
  } catch {
    throw new InvalidToken('cost cannot be decrypted');
  }
}
