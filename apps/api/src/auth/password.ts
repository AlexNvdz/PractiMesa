import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

// OWASP minimum for argon2id: m=19 MiB, t=2, p=1.
const DEFAULTS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

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

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = PHC.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5], 'base64');
  const actual = await derive(password, Buffer.from(m[4], 'base64'), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return timingSafeEqual(actual, expected);
}
