import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseCsv,
  resolveRarity,
  withExistingDuplicates,
} from './parse-csv.js';

const H = 'name,rarity,number,imageUrl,marketPriceUsd';
const buf = (s: string) => Buffer.from(s, 'utf8');
const codes = (s: string | Buffer) =>
  parseCsv(typeof s === 'string' ? buf(s) : s).errors.map(
    (e) => `${e.row}:${e.field}:${e.code}`,
  );

describe('parseCsv (Story 22.7)', () => {
  it('parses the template fixture (reused by 22.9)', () => {
    const r = parseCsv(readFileSync('test/fixtures/cards-template.csv'));
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      {
        row: 2,
        name: 'Charizard ex',
        rarityTier: 'DOUBLE_RARE',
        number: '001/165',
        imageUrl: 'https://img.example.com/c.png',
        marketPriceUsd: '12.50',
      },
      {
        row: 3,
        name: 'Pikachu',
        rarityTier: 'COMMON',
        number: null,
        imageUrl: null,
        marketPriceUsd: null,
      },
    ]);
  });

  it('BOM, CRLF, `;` separator, quoted separators and multi-line names', () => {
    const csv =
      '﻿Name ; RARITY;Number\r\n"Charizard ex; ""Holo, Rev""";rare holo;1\r\n"Line one\nline two";Common;2\r\n';
    const r = parseCsv(buf(csv));
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.name)).toEqual([
      'Charizard ex; "Holo, Rev"',
      'Line one\nline two',
    ]);
    expect(r.rows[0].rarityTier).toBe('RARE');
  });

  it('comma file where `;` only appears inside quotes stays comma', () => {
    const r = parseCsv(buf(`name,rarity\n"a;b;c;d",common\n`));
    expect(r.errors).toEqual([]);
    expect(r.rows[0].name).toBe('a;b;c;d');
  });

  it('skips blank lines but numbers rows by record (header 1, first data 2)', () => {
    expect(codes(`${H}\n\nx,common,,,\n\ny,nope,,,\n`)).toEqual([
      '3:rarity:INVALID_RARITY',
    ]);
  });

  it.each([
    ['double rare', 'DOUBLE_RARE'],
    ['DOUBLE_RARE', 'DOUBLE_RARE'],
    ['double-rare', 'DOUBLE_RARE'],
    ['  Special   Illustration-Rare ', 'SPECIAL_ILLUSTRATION_RARE'],
    ['Illustration Rare', 'ILLUSTRATION_RARE'],
    ['Rare Holo', 'RARE'],
    ['hyper rare', 'HYPER_RARE'],
    ['promo', null],
    ['', null],
    ['mythic', null],
    ['=cmd', null],
  ])('rarity %j -> %j', (raw, tier) => {
    expect(resolveRarity(raw)).toBe(tier);
  });

  it('header problems are row-1 errors', () => {
    expect(codes('name\nx\n')).toContain('1:rarity:MISSING_COLUMN');
    expect(codes('rarity,foo\ncommon,1\n')).toEqual(
      expect.arrayContaining(['1:foo:UNKNOWN_COLUMN', '1:name:MISSING_COLUMN']),
    );
    expect(codes('name,Name,rarity\nx,y,common\n')).toContain(
      '1:name:DUPLICATE_COLUMN',
    );
    expect(codes(',name,rarity\n1,x,common\n')).toContain('1::UNKNOWN_COLUMN');
  });

  it('optional columns may be absent', () => {
    const r = parseCsv(buf('rarity,name\ncommon,A\n'));
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ name: 'A', number: null });
  });

  it('short / long rows => COLUMN_COUNT, never a crash', () => {
    expect(codes(`${H}\nx,common\nx,common,1,,,extra\nok,common,,,\n`)).toEqual(
      ['2:row:COLUMN_COUNT', '3:row:COLUMN_COUNT'],
    );
  });

  it('per-field codes, all rows in one pass', () => {
    const long = 'x'.repeat(121);
    const csv = [
      H,
      `,common,,,`,
      `${long},common,,,`,
      `ok,common,${'9'.repeat(31)},,`,
      `ok,promo,,,`,
      `ok,common,,http://a.com/x.png,`,
      `ok,common,,/uploads/public/other/x.png,`,
      `ok,common,,https://u:p@a.com/x.png,`,
      `ok,common,,/uploads/public/simulator/../x.png,`,
      `ok,common,,,1,5`,
      `ok,common,,,-1`,
      `ok,common,,,1.234`,
      `ok,common,,,abc`,
      `ok,common,,,1e3`,
      `ok,common,,,999999999`,
      `ok,common,,,١٢`,
    ].join('\n');
    expect(codes(csv)).toEqual([
      '2:name:REQUIRED',
      '3:name:TOO_LONG',
      '4:number:TOO_LONG',
      '5:rarity:INVALID_RARITY',
      '6:imageUrl:INVALID_URL',
      '7:imageUrl:INVALID_URL',
      '8:imageUrl:INVALID_URL',
      '9:imageUrl:INVALID_URL',
      '10:row:COLUMN_COUNT',
      '11:marketPriceUsd:INVALID_PRICE',
      '12:marketPriceUsd:INVALID_PRICE',
      '13:marketPriceUsd:INVALID_PRICE',
      '14:marketPriceUsd:INVALID_PRICE',
      '15:marketPriceUsd:INVALID_PRICE',
      '16:marketPriceUsd:INVALID_PRICE',
    ]);
  });

  it('prices: exact decimal strings, 0 and max accepted', () => {
    const r = parseCsv(
      buf(`${H}\na,common,,,0\nb,common,,,99999999.99\nc,common,,,7.5\n`),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.marketPriceUsd)).toEqual([
      '0',
      '99999999.99',
      '7.5',
    ]);
  });

  it('formula injection and PII-looking cells are rejected, never stored', () => {
    expect(
      codes(
        `${H}\n=cmd|' /C calc'!A0,common,,,\n@SUM(1),common,,,\n+1+1,common,,,\n-2,common,,,\nok,common,=1+1,,\nok,common,user@example.com,,\n`,
      ),
    ).toEqual([
      '2:name:FORMULA',
      '3:name:FORMULA',
      '4:name:FORMULA',
      '5:name:FORMULA',
      '6:number:FORMULA',
      '7:number:UNSAFE_TEXT',
    ]);
  });

  it('DUPLICATE_NUMBER ignores case (22.10): file and set keys are lower-case', () => {
    const csv = `${H}\na,common,A1,,\nb,common,a1,,\nc,common,TG12,,\nd,common,tg12,,\ne,common,A 1,,\n`;
    expect(codes(csv)).toEqual([
      '3:number:DUPLICATE_NUMBER',
      '5:number:DUPLICATE_NUMBER',
    ]);
    const r = withExistingDuplicates(
      parseCsv(buf(`${H}\na,common,A1,,\nb,common,B2,,\n`)),
      new Set(['a1']),
    );
    expect(r.errors.map((e) => `${e.row}:${e.code}`)).toEqual([
      '2:DUPLICATE_NUMBER',
    ]);
    expect(r.rows.map((x) => x.number)).toEqual(['B2']);
    // the number is kept as written
    expect(parseCsv(buf(`${H}\na,common,Tg12,,\n`)).rows[0].number).toBe(
      'Tg12',
    );
  });

  it('DUPLICATE_NUMBER on the 2nd appearance and against the set', () => {
    const csv = `${H}\na,common,1,,\nb,common,1,,\nc,common,2,,\nd,common,,,\ne,common,,,\n`;
    expect(codes(csv)).toEqual(['3:number:DUPLICATE_NUMBER']);
    const r = withExistingDuplicates(parseCsv(buf(csv)), new Set(['2', '1']));
    expect(r.errors.map((e) => `${e.row}:${e.code}`)).toEqual([
      '2:DUPLICATE_NUMBER',
      '3:DUPLICATE_NUMBER',
      '4:DUPLICATE_NUMBER',
    ]);
    expect(
      parseCsv(buf(csv), { existingNumbers: new Set(['2']) }).errors.length,
    ).toBe(2);
  });

  it('file-level errors: empty, header only, encoding, malformed quotes', () => {
    expect(codes('')).toEqual(['0:file:EMPTY']);
    expect(codes('﻿  \n')).toEqual(['0:file:EMPTY']);
    expect(codes(H)).toEqual(['0:file:EMPTY']);
    expect(codes(`${H}\n`)).toEqual(['0:file:EMPTY']);
    expect(codes(Buffer.from(`${H}\nPeña,common,,,\n`, 'latin1'))).toEqual([
      '0:file:ENCODING',
    ]);
    expect(codes(`${H}\n"unterminated,common,,,\n`)).toEqual([
      '0:file:MALFORMED_CSV',
    ]);
    expect(codes(`${H}\n"a"b,common,,,\n`)).toEqual(['0:file:MALFORMED_CSV']);
  });

  it('unicode names are kept; an unquoted inner quote is a clean MALFORMED_CSV, not a crash', () => {
    const r = parseCsv(buf(`${H}\nPokémon 日本語 ✨,common,№1,,\n`));
    expect(r.errors).toEqual([]);
    expect(r.rows[0].name).toBe('Pokémon 日本語 ✨');
    expect(codes(`${H}\nCharizard "ex",rare,,,\n`)).toEqual([
      '0:file:MALFORMED_CSV',
    ]);
  });

  it('row limit: 2000 ok, 2001 => one TOO_MANY_ROWS', () => {
    const mk = (n: number) =>
      `${H}\n${Array.from({ length: n }, (_, i) => `c${i},common,${i},,`).join('\n')}\n`;
    const ok = parseCsv(buf(mk(2000)));
    expect(ok.errors).toEqual([]);
    expect(ok.rows).toHaveLength(2000);
    expect(codes(mk(2001))).toEqual(['0:file:TOO_MANY_ROWS']);
    expect(codes(mk(50_000))).toEqual(['0:file:TOO_MANY_ROWS']);
  });

  it('row limit can be tuned by env', () => {
    process.env.SIMULATOR_CSV_MAX_ROWS = '1';
    try {
      expect(codes(`${H}\na,common,,,\nb,common,,,\n`)).toEqual([
        '0:file:TOO_MANY_ROWS',
      ]);
    } finally {
      delete process.env.SIMULATOR_CSV_MAX_ROWS;
    }
  });
});
