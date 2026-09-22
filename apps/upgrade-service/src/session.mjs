import assert from 'node:assert/strict';

const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder();

const encode = (value) =>
  globalThis
    .btoa(String.fromCodePoint(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

const decode = (value) => {
  assert(/^[\w-]+$/u.test(value), 'Malformed session');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(
    globalThis.atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')),
    (character) => character.codePointAt(0),
  );
};

const keyFor = async (secret) => {
  assert(secret?.length >= 32, 'SESSION_SECRET must be at least 32 characters');
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(secret),
  );
  return globalThis.crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
};

export const random = () =>
  encode(globalThis.crypto.getRandomValues(new Uint8Array(32)));

export const seal = async (value, secret) => {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(secret);
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { iv, name: 'AES-GCM' },
    key,
    plaintext,
  );
  return `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
};

export const open = async (sealed, secret) => {
  try {
    const [iv, ciphertext] = sealed.split('.');
    const key = await keyFor(secret);
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { iv: decode(iv), name: 'AES-GCM' },
      key,
      decode(ciphertext),
    );
    const value = JSON.parse(decoder.decode(plaintext));
    assert(value.expires > Date.now(), 'Session expired');
    return value;
  } catch {
    throw new Error('Session expired or invalid');
  }
};

export const cookie = (name, value, maxAge = 600) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const readCookie = (request, name) => {
  const cookies = request.headers.get('cookie') ?? '';
  const match = cookies
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
};
