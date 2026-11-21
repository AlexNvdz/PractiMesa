import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

// OWASP minimum for argon2id: m=19 MiB, t=2, p=1.
const DEFAULTS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

type Params = typeof DEFAULTS;

function derive(password: string, salt: Buffer, params: Params): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2('argon2id', { message: password, nonce: salt, ...params }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

/** argon2id hash in PHC string format, compatible with other argon2 libraries. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, DEFAULTS);
  const { memory, passes, parallelism } = DEFAULTS;
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(hash)}`;
}

/** Parses `$argon2id$v=19$m=..,t=..,p=..$salt$hash`; null for anything else. */
function parsePhc(stored: string) {
  const [empty, alg, version, params, salt, hash, ...rest] = stored.split('$');
  if (empty !== '' || alg !== 'argon2id' || version !== 'v=19' || !salt || !hash || rest.length) return null;
  const values = Object.fromEntries((params ?? '').split(',').map((kv) => kv.split('=')));
  const [memory, passes, parallelism] = [values.m, values.t, values.p].map(Number);
  if (![memory, passes, parallelism].every((n) => Number.isInteger(n) && n > 0)) return null;
  return { memory, passes, parallelism, salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const phc = parsePhc(stored);
  if (!phc) return false;
  const actual = await derive(password, phc.salt, {
    memory: phc.memory,
    passes: phc.passes,
    parallelism: phc.parallelism,
    tagLength: phc.hash.length,
  });
  return timingSafeEqual(actual, phc.hash);
}
