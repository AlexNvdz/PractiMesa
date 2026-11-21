import { BadRequestException } from '@nestjs/common';
import { int, modifiersSchema, nullable, num, parseBody, text, url, uuid } from './validation';

describe('parseBody', () => {
  const rules = { name: text(10), price: num(0, 100), note: nullable(text(5)) };

  it('keeps only known keys and trims strings', () => {
    expect(parseBody({ name: ' Café ', price: 5, organization_id: 'x' }, rules, ['name'])).toEqual({ name: 'Café', price: 5 });
  });

  it('accepts null only for nullable fields', () => {
    expect(parseBody({ note: null }, rules)).toEqual({ note: null });
    expect(() => parseBody({ price: null }, rules)).toThrow('Campo inválido: price');
  });

  it('rejects missing required keys, invalid values and non-object bodies', () => {
    expect(() => parseBody({ price: 1 }, rules, ['name'])).toThrow('Falta el campo name');
    expect(() => parseBody({ name: 'x'.repeat(11) }, rules)).toThrow(BadRequestException);
    for (const bad of [null, 'x', [], 3]) expect(() => parseBody(bad, rules)).toThrow('Cuerpo de la solicitud inválido');
  });
});

describe('checks', () => {
  it('num and int', () => {
    expect([num(0, 10)(10), num(0, 10)(11), num(0, 10)(Number.NaN), num(0, 10)('5')]).toEqual([true, false, false, false]);
    expect([int(0, 10)(3), int(0, 10)(3.5)]).toEqual([true, false]);
  });

  it('uuid and url', () => {
    expect(uuid('9b2f0c1e-1d2a-4c3b-8e4f-5a6b7c8d9e0f')).toBe(true);
    expect(uuid('nope')).toBe(false);
    expect(['https://cdn.x.co/a.jpg', '/menu/a.jpg'].every(url)).toBe(true);
    expect(['javascript:alert(1)', 'ftp://x', 'https://a b', 1].some(url)).toBe(false);
  });
});

describe('modifiersSchema', () => {
  const group = { name: 'Leche', required: false, multiple: true, options: [{ name: 'Almendras', price_cop: 1500 }] };

  it('accepts an empty list and well-formed groups', () => {
    expect(modifiersSchema([])).toBe(true);
    expect(modifiersSchema([group, { ...group, name: 'Tamaño' }])).toBe(true);
  });

  it.each([
    ['not a list', {}],
    ['unknown group key', [{ ...group, extra: 1 }]],
    ['unknown option key', [{ ...group, options: [{ name: 'x', price_cop: 1, hidden: true }] }]],
    ['missing flags', [{ name: 'x', options: group.options }]],
    ['no options', [{ ...group, options: [] }]],
    ['negative price', [{ ...group, options: [{ name: 'x', price_cop: -1 }] }]],
    ['duplicated option names', [{ ...group, options: [group.options[0], group.options[0]] }]],
    ['duplicated group names', [group, group]],
    ['too many groups', Array.from({ length: 21 }, (_, i) => ({ ...group, name: `g${i}` }))],
  ])('rejects %s', (_, value) => {
    expect(modifiersSchema(value)).toBe(false);
  });
});
