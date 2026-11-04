import { describe, expect, it } from 'vitest';
import { splitIdDocFromName, stripIdDocFromName } from './id-doc-in-name.js';

describe('splitIdDocFromName (story 20.3)', () => {
  const found: Array<[string, string, string]> = [
    ['Ana Prueba (V-70123456)', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba ( V-70123456 )', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba(V-70123456)', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba (v70123456)', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba V-70123456', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba   V70123456  ', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba, V-70123456', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba - V-70.123.456', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba [E-81234567]', 'Ana Prueba', 'E-81234567'],
    ['Ana Prueba (CI: V-70123456)', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba C.I. V-70123456', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba cédula: V 70 123 456', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba (J-12345678-9)', 'Ana Prueba', 'J-123456789'],
    ['V-70123456 Ana Prueba', 'Ana Prueba', 'V-70123456'],
    ['Ana V-70123456 Prueba', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba (Ｖ-７０１２３４５６)', 'Ana Prueba', 'V-70123456'],
    ['Ana Prueba (V​-70123456)', 'Ana Prueba', 'V-70123456'],
    ['José Núñez (P-AB123456)', 'José Núñez', 'P-AB123456'],
  ];
  it.each(found)('extracts %j', (input, name, id) => {
    const r = splitIdDocFromName(input);
    expect(r.found).toBe(true);
    expect(r.name).toBe(name);
    expect(r.idDoc).toBe(id);
    expect(r.ambiguous).toBe(false);
    expect(r.name).not.toMatch(/\d{5}/);
  });

  const untouched = [
    'Ana Prueba',
    'Ana 3era',
    'Ana (3era)',
    'Ana María 2da Pérez',
    'Calle 12345',
    'Ave 12345 Norte',
    'Ana Pérez (hermana)',
    'Pedro 2026',
    'Ana V-123',
    'Ana V 1234',
    'María del 12.345',
    'PENDING12345',
    'Apt 5, piso 12',
    '',
  ];
  it.each(untouched)('leaves %j alone', (input) => {
    const r = splitIdDocFromName(input);
    expect(r.found).toBe(false);
    expect(r.name).toBe(input);
    expect(r.idDoc).toBeNull();
  });

  it('flags two different cedulas as ambiguous and strips both', () => {
    const r = splitIdDocFromName('Ana (V-70123456) y Luis (E-81234567)');
    expect(r.ambiguous).toBe(true);
    expect(r.idDoc).toBe('V-70123456');
    expect(r.name).not.toMatch(/\d{5}/);
  });
  it('the same cedula twice is not ambiguous', () => {
    const r = splitIdDocFromName('Ana V-70123456 (V-70123456)');
    expect(r.ambiguous).toBe(false);
    expect(r.name).toBe('Ana');
  });
  it('a name that is only a cedula leaves an empty name', () => {
    expect(splitIdDocFromName('(V-70123456)').name).toBe('');
  });
  it('stripIdDocFromName is the view helper', () => {
    expect(stripIdDocFromName('Ana (V-70123456)')).toBe('Ana');
    expect(stripIdDocFromName('Ana 3era')).toBe('Ana 3era');
  });
});
