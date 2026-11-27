import { BadRequestException } from '@nestjs/common';

/** Rows per request: the default fits a phone screen, the cap keeps one answer light. */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** `limit` and `offset` query values, validated. Anything but a plain whole number is a 400. */
export function pageParams(limit?: string, offset?: string, fallback = DEFAULT_LIMIT) {
  const whole = (value: string | undefined, name: string, def: number) => {
    if (value === undefined || value === '') return def;
    if (!/^\d{1,6}$/.test(value)) throw new BadRequestException(`${name} debe ser un número entero`);
    return Number(value);
  };
  const size = Math.min(MAX_LIMIT, Math.max(1, whole(limit, 'limit', fallback)));
  return { limit: size, offset: whole(offset, 'offset', 0) };
}

/** Offset of the next page, or null when this one reached the end. */
export const nextOffset = (offset: number, limit: number, total: number) => (offset + limit < total ? offset + limit : null);

/**
 * Search text as a LIKE pattern that ignores case and accents: lowercase, accents stripped, wildcards escaped.
 * Compare against `translate(lower(column), ACCENTS_FROM, ACCENTS_TO)` in SQL.
 */
export const ACCENTS_FROM = 'áéíóúüñ';
export const ACCENTS_TO = 'aeiouun';
export function likePattern(text: string): string {
  const folded = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${folded}%`;
}
