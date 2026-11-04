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
    // 20.4: a label with no letter is unmistakable: it is a V.
    ['Ana CI 12345678', 'Ana', 'V-12345678'],
    ['Ana C.I.: 12.345.678', 'Ana', 'V-12345678'],
    ['Ana (CI 12345678)', 'Ana', 'V-12345678'],
    ['Ana cédula 12345678', 'Ana', 'V-12345678'],
    ['Ana ced. 12 345 678', 'Ana', 'V-12345678'],
    ['CI 1234567 Ana', 'Ana', 'V-1234567'],
    // Boundaries of the real rules still extract.
    ['Ana V-123456', 'Ana', 'V-123456'],
    ['Ana E-123456789', 'Ana', 'E-123456789'],
    ['Torre P-123456', 'Torre', 'P-123456'],
    ['Ana (J-123456789)', 'Ana', 'J-123456789'],
    ['Ana (G-200000001)', 'Ana', 'G-200000001'],
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
    // 20.4: short tokens are not cedulas (V/E 6-9, J/G 9, P 6-12): company names, lots, buildings.
    'Inversiones G-20000 C.A.',
    'Inversiones J-1234 C.A.',
    'Edificio P-12345',
    'Torre E-12345',
    'Local J-12345678',
    'Ana V-12345',
    'Ana V-1234567890',
    'Ana P-12345',
    // No label, or a label that cannot give a type, or not a standalone label.
    'Ana 12345678',
    'Maci 12345678',
    'Ana RIF 12345678',
    'Ana pasaporte 12345678',
    'Ana CI 12345',
    'Ana CI 1234567890',
    'Ana ci 12345678901',
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
  it('keeps a company name that looks like a short id and extracts the real cedula beside it', () => {
    const r = splitIdDocFromName('Inversiones G-20000 C.A. (V-12345678)');
    expect(r.found).toBe(true);
    expect(r.idDoc).toBe('V-12345678');
    expect(r.name).toBe('Inversiones G-20000 C.A.');
    expect(r.ambiguous).toBe(false);
  });
  it('a label does not eat letters of the word before it', () => {
    expect(splitIdDocFromName('Marci CI 12345678').name).toBe('Marci');
  });
  it('stripIdDocFromName is the view helper', () => {
    expect(stripIdDocFromName('Ana (V-70123456)')).toBe('Ana');
    expect(stripIdDocFromName('Ana 3era')).toBe('Ana 3era');
  });
});
