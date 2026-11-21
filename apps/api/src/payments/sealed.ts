import { ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** 32 random bytes in base64: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" */
function key(): Buffer {
  const k = Buffer.from(process.env.CREDENTIALS_KEY ?? '', 'base64');
  if (k.length !== 32) throw new ServiceUnavailableException('CREDENTIALS_KEY no está configurada');
  return k;
}

/**
 * AES-256-GCM, output base64(iv | tag | data). `context` (organization + provider) is authenticated too,
 * so a sealed value copied to another organization's row fails to open.
 */
export function seal(plain: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv).setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function unseal(sealed: string, context: string): string {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12)).setAAD(Buffer.from(context));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
