import { CsvError, parse } from 'csv-parse/sync';
import { sanitizeAuditPayload } from '../../../audit/audit-payload.js';
import { PACK_TIERS, mapPackTier, type PackTier } from '../../pack-tiers.js';
import { isValidImageUrl } from '../image-url.validator.js';
import { isValidPriceUsd } from '../price-usd.validator.js';

/** Story 22.7 (AD-107, A101, A113): pure CSV parser/validator of manual cards. No I/O, no network. */
export const CSV_MAX_BYTES_DEFAULT = 1024 * 1024;
export const CSV_MAX_ROWS_DEFAULT = 2000;
export const CSV_NAME_MAX = 120;
export const CSV_NUMBER_MAX = 30;
export const CSV_MAX_REPORTED_ERRORS = 100;

/** `SIMULATOR_CSV_MAX_BYTES` (default 1 MB), read per call so tests can tune it. */
export function csvMaxBytes(): number {
  const n = Number(process.env.SIMULATOR_CSV_MAX_BYTES);
  return Number.isInteger(n) && n > 0 ? n : CSV_MAX_BYTES_DEFAULT;
}
/** `SIMULATOR_CSV_MAX_ROWS` (default 2000 data rows). */
export function csvMaxRows(): number {
  const n = Number(process.env.SIMULATOR_CSV_MAX_ROWS);
  return Number.isInteger(n) && n > 0 ? n : CSV_MAX_ROWS_DEFAULT;
}

export interface CsvRowError {
  row: number;
  field: string;
  code: string;
  message: string;
}

export interface CsvCardRow {
  /** 1-based, header = 1, first data record = 2. */
  row: number;
  name: string;
  rarityTier: PackTier;
  number: string | null;
  imageUrl: string | null;
  /** Exact decimal string (`^\d{1,8}(\.\d{1,2})?$`), never a float. */
  marketPriceUsd: string | null;
}

export interface CsvParseResult {
  /** Rows that passed every per-row rule (only importable when `errors` is empty). */
  rows: CsvCardRow[];
  errors: CsvRowError[];
  /** Number of data records read. */
  dataRows: number;
  /** `{row, number}` of every data row with a usable number, to look the set up for clashes. */
  numbers: { row: number; number: string }[];
}

export const CSV_COLUMNS = [
  'name',
  'rarity',
  'number',
  'imageUrl',
  'marketPriceUsd',
] as const;
type Column = (typeof CSV_COLUMNS)[number];
const REQUIRED: readonly Column[] = ['name', 'rarity'];
const byKey = new Map<string, Column>(
  CSV_COLUMNS.map((c) => [c.toLowerCase(), c]),
);
const normHeader = (s: string): string => s.replace(/\s+/gu, '').toLowerCase();

const PRICE_RE = /^\d{1,8}(\.\d{1,2})?$/;
const FORMULA_RE = /^[=@+\-\t\r]/;

const err = (
  row: number,
  field: string,
  code: string,
  message: string,
): CsvRowError => ({ row, field, code, message });

const fileErr = (code: string, message: string): CsvParseResult => ({
  rows: [],
  errors: [err(0, 'file', code, message)],
  dataRows: 0,
  numbers: [],
});

/** `fatal` UTF-8 decode; a BOM is stripped (`ignoreBOM: false`). `null` when the bytes are not UTF-8. */
export function decodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      buf,
    );
  } catch {
    return null;
  }
}

/** `,` or `;`: whichever shows up more often OUTSIDE quotes in the header record (tie/none => `,`). */
export function detectDelimiter(text: string): ',' | ';' {
  let inQuotes = false;
  let commas = 0;
  let semis = 0;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === '\n' || ch === '\r') break;
      if (ch === ',') commas++;
      else if (ch === ';') semis++;
    }
  }
  return semis > commas ? ';' : ',';
}

/** `rarity` cell -> tier: the tier code (any case; spaces/hyphens => `_`) or a raw rarity text. */
export function resolveRarity(raw: string): PackTier | null {
  const code = raw
    .trim()
    .replace(/[\s-]+/gu, '_')
    .toUpperCase();
  const asTier = PACK_TIERS.find((t) => t === code);
  if (asTier) return asTier;
  return mapPackTier(raw);
}

/** Same detectors the audit guard uses (e-mail, phone, id document, card number, secrets). */
const auditUnsafe = (field: string, v: string): boolean =>
  sanitizeAuditPayload({ [field]: v }, 'lenient', '$').issues.length > 0;

/**
 * Parses and validates a whole CSV. Never throws on admin input: every problem becomes a
 * `{row, field, code, message}` entry (all rows, one pass). `existingNumbers` = numbers already in
 * the set (clash reported on the file row, `DUPLICATE_NUMBER`).
 */
export function parseCsv(
  buffer: Buffer,
  opts: { existingNumbers?: ReadonlySet<string> } = {},
): CsvParseResult {
  const text = decodeUtf8(buffer);
  if (text === null)
    return fileErr('ENCODING', 'The file must be UTF-8 (with or without BOM).');
  if (text.trim().length === 0)
    return fileErr('EMPTY', 'The file has no header and no rows.');
  const maxRows = csvMaxRows();

  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      delimiter: detectDelimiter(text),
      skip_empty_lines: true,
      relax_column_count: true,
      // header + maxRows + 1: enough to tell "too many" without materialising a huge file
      to: maxRows + 2,
    });
  } catch (e) {
    if (e instanceof CsvError)
      return fileErr(
        'MALFORMED_CSV',
        `The file is not valid CSV (${e.code}${typeof e.lines === 'number' ? `, near line ${e.lines}` : ''}); check quotes.`,
      );
    throw e;
  }
  if (records.length === 0)
    return fileErr('EMPTY', 'The file has no header and no rows.');
  if (records.length - 1 > maxRows)
    return fileErr(
      'TOO_MANY_ROWS',
      `At most ${maxRows} data rows are allowed per file.`,
    );

  const errors: CsvRowError[] = [];
  const header = records[0];
  const colIndex = new Map<Column, number>();
  header.forEach((raw, i) => {
    const col = byKey.get(normHeader(raw));
    if (!col) {
      errors.push(
        err(1, raw.trim().slice(0, 60), 'UNKNOWN_COLUMN', 'Unknown column.'),
      );
    } else if (colIndex.has(col)) {
      errors.push(err(1, col, 'DUPLICATE_COLUMN', 'Repeated column.'));
    } else colIndex.set(col, i);
  });
  for (const c of REQUIRED)
    if (!colIndex.has(c))
      errors.push(err(1, c, 'MISSING_COLUMN', 'Required column is missing.'));
  const data = records.slice(1);
  if (data.length === 0 && errors.length === 0)
    return fileErr('EMPTY', 'The file has a header but no data rows.');
  if (errors.length > 0)
    return { rows: [], errors, dataRows: data.length, numbers: [] };

  const rows: CsvCardRow[] = [];
  const numbers: { row: number; number: string }[] = [];
  const seen = new Set<string>();
  const cell = (r: string[], c: Column): string =>
    (colIndex.has(c) ? (r[colIndex.get(c)!] ?? '') : '').trim();

  data.forEach((rec, i) => {
    const row = i + 2;
    const before = errors.length;
    if (rec.length !== header.length) {
      errors.push(
        err(
          row,
          'row',
          'COLUMN_COUNT',
          `Expected ${header.length} columns, found ${rec.length}.`,
        ),
      );
      return;
    }
    const name = cell(rec, 'name');
    if (name.length === 0)
      errors.push(err(row, 'name', 'REQUIRED', 'name is required.'));
    else if (name.length > CSV_NAME_MAX)
      errors.push(
        err(row, 'name', 'TOO_LONG', `name exceeds ${CSV_NAME_MAX} chars.`),
      );
    else if (FORMULA_RE.test(name))
      errors.push(
        err(
          row,
          'name',
          'FORMULA',
          'name must not start with = + - @ (spreadsheet formula injection).',
        ),
      );

    const tier = resolveRarity(cell(rec, 'rarity'));
    if (tier === null)
      errors.push(
        err(
          row,
          'rarity',
          'INVALID_RARITY',
          'Unknown rarity (use a tier code such as DOUBLE_RARE or a rarity text such as "Illustration Rare").',
        ),
      );

    const rawNumber = cell(rec, 'number');
    let number: string | null = null;
    if (rawNumber.length > 0) {
      if (rawNumber.length > CSV_NUMBER_MAX)
        errors.push(
          err(
            row,
            'number',
            'TOO_LONG',
            `number exceeds ${CSV_NUMBER_MAX} chars.`,
          ),
        );
      else if (FORMULA_RE.test(rawNumber))
        errors.push(
          err(row, 'number', 'FORMULA', 'number must not start with = + - @.'),
        );
      else if (auditUnsafe('number', rawNumber))
        errors.push(
          err(
            row,
            'number',
            'UNSAFE_TEXT',
            'number must not look like an email, phone, ID document, card number or secret.',
          ),
        );
      else {
        number = rawNumber;
        numbers.push({ row, number });
        if (seen.has(number))
          errors.push(
            err(
              row,
              'number',
              'DUPLICATE_NUMBER',
              'number repeated in the file.',
            ),
          );
        else if (opts.existingNumbers?.has(number))
          errors.push(
            err(
              row,
              'number',
              'DUPLICATE_NUMBER',
              'number already exists in the set.',
            ),
          );
        seen.add(number);
      }
    }

    const rawUrl = cell(rec, 'imageUrl');
    let imageUrl: string | null = null;
    if (rawUrl.length > 0) {
      if (!isValidImageUrl(rawUrl))
        errors.push(
          err(
            row,
            'imageUrl',
            'INVALID_URL',
            'imageUrl must be an own /uploads/public/(simulator|landing)/ path or an https:// URL (max 300, no credentials).',
          ),
        );
      else if (auditUnsafe('imageUrl', rawUrl))
        errors.push(
          err(
            row,
            'imageUrl',
            'UNSAFE_TEXT',
            'imageUrl must not look like PII or a secret.',
          ),
        );
      else imageUrl = rawUrl;
    }

    const rawPrice = cell(rec, 'marketPriceUsd');
    let price: string | null = null;
    if (rawPrice.length > 0) {
      if (!PRICE_RE.test(rawPrice) || !isValidPriceUsd(Number(rawPrice)))
        errors.push(
          err(
            row,
            'marketPriceUsd',
            'INVALID_PRICE',
            'marketPriceUsd must be 0..99999999.99 with a dot and at most 2 decimals.',
          ),
        );
      else price = rawPrice;
    }

    if (errors.length === before && tier !== null)
      rows.push({
        row,
        name,
        rarityTier: tier,
        number,
        imageUrl,
        marketPriceUsd: price,
      });
  });
  return { rows, errors, dataRows: data.length, numbers };
}

/** Appends `DUPLICATE_NUMBER` for file rows whose number already exists in the set (row order). */
export function withExistingDuplicates(
  result: CsvParseResult,
  existing: ReadonlySet<string>,
): CsvParseResult {
  const flagged = new Set(
    result.errors
      .filter((e) => e.code === 'DUPLICATE_NUMBER')
      .map((e) => e.row),
  );
  const extra = result.numbers
    .filter((n) => existing.has(n.number) && !flagged.has(n.row))
    .map((n) =>
      err(
        n.row,
        'number',
        'DUPLICATE_NUMBER',
        'number already exists in the set.',
      ),
    );
  if (extra.length === 0) return result;
  const bad = new Set(extra.map((e) => e.row));
  return {
    ...result,
    rows: result.rows.filter((r) => !bad.has(r.row)),
    errors: [...result.errors, ...extra].sort((a, b) => a.row - b.row),
  };
}
