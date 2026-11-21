import { BadRequestException } from '@nestjs/common';

/** Returns true when the value is acceptable for the field. */
export type Check = (value: unknown) => boolean;

/** Upper bound of NUMERIC(12, 2) money columns. */
export const MAX_COP = 9_999_999_999;
/** Upper bound of NUMERIC(12, 3) quantity columns. */
export const MAX_QTY = 999_999_999;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const text =
  (max: number): Check =>
  (v) =>
    typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export const num =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export const int =
  (min: number, max: number): Check =>
  (v) =>
    Number.isInteger(v) && num(min, max)(v);
export const bool: Check = (v) => typeof v === 'boolean';
export const uuid: Check = (v) => typeof v === 'string' && UUID_RE.test(v);
/** Absolute http(s) URL or a path on this site (seed uses static images). */
export const url: Check = (v) => typeof v === 'string' && v.length <= 2000 && /^(https?:\/\/|\/)\S+$/i.test(v);
export const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOnly = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));
const uniqueNames = (items: Record<string, unknown>[]) => new Set(items.map((i) => i.name)).size === items.length;

const modifierOption: Check = (o) =>
  isObject(o) && hasOnly(o, ['name', 'price_cop']) && text(60)(o.name) && num(0, MAX_COP)(o.price_cop);

const modifierGroup: Check = (g) =>
  isObject(g) &&
  hasOnly(g, ['name', 'required', 'multiple', 'options']) &&
  text(60)(g.name) &&
  bool(g.required) &&
  bool(g.multiple) &&
  Array.isArray(g.options) &&
  g.options.length >= 1 &&
  g.options.length <= 30 &&
  g.options.every(modifierOption) &&
  uniqueNames(g.options);

/**
 * products.modifiers_schema: [{ name, required, multiple, options: [{ name, price_cop }] }].
 * Names are unique per level so order items can reference a modifier by group + option name.
 */
export const modifiersSchema: Check = (v) =>
  Array.isArray(v) && v.length <= 20 && v.every(modifierGroup) && uniqueNames(v);

/**
 * Whitelists the body: only keys with a rule are copied (so organization_id and other columns
 * can never come from the client), strings are trimmed, and missing `required` keys are rejected.
 */
export function parseBody<T extends object>(
  body: unknown,
  rules: { [K in keyof T]?: Check },
  required: (keyof T & string)[] = [],
): T {
  if (!isObject(body)) throw new BadRequestException('Cuerpo de la solicitud inválido');
  const out: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(rules) as [string, Check][]) {
    const value = body[key];
    if (value === undefined) {
      if (required.includes(key as keyof T & string)) throw new BadRequestException(`Falta el campo ${key}`);
    } else if (check(value)) {
      out[key] = typeof value === 'string' ? value.trim() : value;
    } else {
      throw new BadRequestException(`Campo inválido: ${key}`);
    }
  }
  return out as T;
}
