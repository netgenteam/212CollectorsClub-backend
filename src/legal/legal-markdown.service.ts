import { createHash } from 'node:crypto';
import {
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { LEGAL_TEMPLATE_NOTICE } from './legal-placeholders.js';
import {
  DEFAULT_POOL_OPTIONS,
  MarkdownWorkerPool,
  type DiffResult,
  PoolFailure,
  type MarkdownFact,
  type MarkdownPoolOptions,
  type MarkdownPoolStats,
} from './legal-markdown-pool.js';

export interface LegalTocEntry {
  depth: 2 | 3;
  text: string;
  id: string;
}

export interface LegalMarkdownIssue {
  line: number;
  reason: string;
}

const ALLOWED_SCHEMES = new Set(['https', 'mailto', 'tel']);
// Browsers drop tabs/newlines inside a URL and ignore leading C0/space chars.
const CONTROL_OR_SPACE = new RegExp(
  '[\\x00-\\x20\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + ']',
);

/**
 * Why a link/definition URL is not acceptable, or null when it is allowed:
 * `https:`, `mailto:`, `tel:`, an anchor `#x` or an internal path `/x`
 * (never `//host`, nor `/\host` which browsers read as `//host`).
 */
export function urlRejection(raw: string): string | null {
  if (CONTROL_OR_SPACE.test(raw)) {
    return 'URL with whitespace or control characters';
  }
  if (raw.startsWith('#')) return raw.length > 1 ? null : 'empty anchor';
  if (raw.startsWith('/')) {
    return raw[1] === '/' || raw[1] === '\\'
      ? 'protocol-relative URL (//) is not allowed'
      : null;
  }
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (!m)
    return 'link without an allowed scheme (use https:, mailto:, tel:, #anchor or /path)';
  const scheme = m[1].toLowerCase();
  return ALLOWED_SCHEMES.has(scheme)
    ? null
    : `URL scheme "${scheme}:" is not allowed`;
}

/** Lower-case, accent-stripped, hyphenated; never empty. */
export function slugifyHeading(text: string): string {
  const s = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'seccion';
}

/**
 * Story 19.1 fix (QA D1, AD-90, FR-109): bounds enforced BEFORE parsing, in one
 * O(n) pass. remark/micromark is super-linear on a few pathological shapes
 * (measured on 200 KB inputs: `'## A\n'.repeat(30000)` 37 s, 500 nested list
 * levels 4.5 s, `'>'.repeat(5000)` RangeError, `'a.'.repeat(100000)` and
 * `'[a]('.repeat(30000)` > 10 s) and it runs synchronously on the event loop,
 * so the validator must refuse them with 400 instead. Realistic legal text
 * (200 KB of prose: ~0.3 s; 100 KB with 4-level lists) is far below every limit.
 */
export const LEGAL_MD_LIMITS = {
  /** Same cap as the draft body (architecture AD-88). */
  maxBytes: 200 * 1024,
  /** Longest single line. A very long paragraph is ~5 KB. */
  maxLineChars: 20_000,
  /** Longest run of non-whitespace (a URL is < 2 KB): stops `a.a.a.…` / `[a](…` blobs. */
  maxUnbrokenRun: 2_000,
  /** ATX headings plus setext underlines. A long legal text has ~100. */
  maxHeadings: 500,
  /** Quote/list markers stacked in one line prefix (`> - > - x`). */
  maxPrefixDepth: 4,
  /** Lines in the document (200 KB of real text is ~1500). */
  maxLines: 6_000,
  /**
   * Nested list/quote items (each marker after the first in a line, plus each
   * indented marker). micromark is quadratic in these: 1000 nested items
   * ~0.3 s, 8000 ~ 2 s, 16000 ~ 8 s. A long legal text has < 200.
   */
  maxNestedItems: 800,
  /** Leading indentation in columns (tab = 4): 2 columns open a nested list level. */
  maxIndentCols: 40,
  /** Characters of one block (lines between blank lines): a table of ~400 rows. */
  maxBlockChars: 60_000,
  /** Inline delimiters `[]()*_~`<>!|&@:` in one block (a 100-row link table is ~2000). */
  maxBlockDelimiters: 3_000,
  /**
   * Same, whole document. Dense inline markup costs ~12 us per delimiter, so
   * this bounds the worst case at ~0.3 s; very dense real prose is ~10 000.
   */
  maxDocDelimiters: 20_000,
} as const;

const L = LEGAL_MD_LIMITS;
const kb = (n: number) => `${Math.round(n / 1024)} KB`;

/**
 * First limit the document breaks, or null. Single pass, O(n), no regex over
 * unbounded input, never throws.
 */
export function precheckMarkdown(md: string): LegalMarkdownIssue | null {
  if (md.length > L.maxBytes || Buffer.byteLength(md, 'utf8') > L.maxBytes) {
    return {
      line: 1,
      reason: `The document is larger than ${kb(L.maxBytes)}`,
    };
  }
  const n = md.length;
  let line = 1;
  let pos = 0;
  let headings = 0;
  let nested = 0;
  let docDelims = 0;
  let blockChars = 0;
  let blockDelims = 0;
  let prevBlank = true;
  while (pos <= n) {
    // Locate the end of this line (LF, CRLF and lone CR all end a line).
    let end = pos;
    let delims = 0;
    let run = 0;
    while (end < n) {
      const c = md.charCodeAt(end);
      if (c === 10 || c === 13) break;
      if (c === 32 || c === 9) {
        run = 0;
      } else if (++run > L.maxUnbrokenRun) {
        return {
          line,
          reason: `A run of more than ${L.maxUnbrokenRun} characters without spaces (break the text up)`,
        };
      }
      // [ ] ( ) * _ ~ ` < > !
      if (
        c === 91 ||
        c === 93 ||
        c === 40 ||
        c === 41 ||
        c === 42 ||
        c === 95 ||
        c === 126 ||
        c === 96 ||
        c === 60 ||
        c === 62 ||
        c === 33 ||
        c === 124 ||
        c === 38 ||
        c === 64 ||
        c === 58
      ) {
        delims++;
      }
      end++;
    }
    const len = end - pos;
    if (line > L.maxLines) {
      return { line, reason: `More than ${L.maxLines} lines` };
    }
    if (len > L.maxLineChars) {
      return {
        line,
        reason: `The line is longer than ${L.maxLineChars} characters (break it up)`,
      };
    }

    // Line prefix: indentation, then stacked `>` / list markers.
    let i = pos;
    let cols = 0;
    while (i < end && (md.charCodeAt(i) === 32 || md.charCodeAt(i) === 9)) {
      cols += md.charCodeAt(i) === 9 ? 4 - (cols % 4) : 1;
      i++;
    }
    const blank = i === end;
    if (cols > L.maxIndentCols) {
      return {
        line,
        reason: `Indentation deeper than ${L.maxIndentCols} columns (lists nested too deeply)`,
      };
    }
    if (!blank) {
      const firstCol = cols;
      let depth = 0;
      for (;;) {
        const c = md.charCodeAt(i);
        let skip = 0;
        if (c === 62) {
          skip = 1; // >
        } else if (c === 45 || c === 42 || c === 43) {
          // - * +  followed by space/tab/EOL
          const d = i + 1 < end ? md.charCodeAt(i + 1) : 32;
          if (d === 32 || d === 9) skip = 1;
        } else if (c >= 48 && c <= 57) {
          let j = i;
          while (
            j < end &&
            j - i < 10 &&
            md.charCodeAt(j) >= 48 &&
            md.charCodeAt(j) <= 57
          )
            j++;
          const m = j < end ? md.charCodeAt(j) : 0;
          if (j - i <= 9 && (m === 46 || m === 41)) {
            const d = j + 1 < end ? md.charCodeAt(j + 1) : 32;
            if (d === 32 || d === 9) skip = j + 1 - i;
          }
        }
        if (skip === 0) break;
        if (++depth > L.maxPrefixDepth) {
          return {
            line,
            reason: `Lists or block quotes nested more than ${L.maxPrefixDepth} levels`,
          };
        }
        i += skip;
        while (i < end && (md.charCodeAt(i) === 32 || md.charCodeAt(i) === 9))
          i++;
      }
      if (depth > 0) {
        nested += depth - 1 + (firstCol > 0 ? 1 : 0);
        if (nested > L.maxNestedItems) {
          return {
            line,
            reason: `More than ${L.maxNestedItems} nested list items or block quotes`,
          };
        }
      }

      // Headings: `# x` (up to 3 spaces of indent) or a setext underline.
      if (firstCol <= 3) {
        let k = pos;
        while (k < end && md.charCodeAt(k) === 32) k++;
        const ch = md.charCodeAt(k);
        if (ch === 35) {
          let h = k;
          while (h < end && md.charCodeAt(h) === 35) h++;
          const after = h < end ? md.charCodeAt(h) : 32;
          if (h - k <= 6 && (after === 32 || after === 9)) headings++;
        } else if ((ch === 61 || ch === 45) && !prevBlank) {
          let h = k;
          while (h < end && md.charCodeAt(h) === ch) h++;
          while (h < end && (md.charCodeAt(h) === 32 || md.charCodeAt(h) === 9))
            h++;
          if (h === end) headings++;
        }
        if (headings > L.maxHeadings) {
          return {
            line,
            reason: `More than ${L.maxHeadings} headings`,
          };
        }
      }
    }

    if (blank) {
      blockChars = 0;
      blockDelims = 0;
    } else {
      blockChars += len + 1;
      blockDelims += delims;
      docDelims += delims;
      if (docDelims > L.maxDocDelimiters) {
        return {
          line,
          reason: `Too many Markdown symbols in the document (more than ${L.maxDocDelimiters})`,
        };
      }
      if (blockChars > L.maxBlockChars || blockDelims > L.maxBlockDelimiters) {
        return {
          line,
          reason:
            blockChars > L.maxBlockChars
              ? `A block of consecutive lines is larger than ${kb(L.maxBlockChars)} (separate it with blank lines)`
              : `Too many Markdown symbols in one block (more than ${L.maxBlockDelimiters}); separate it with blank lines`,
        };
      }
    }
    prevBlank = blank;

    // Next line.
    if (end >= n) break;
    pos =
      md.charCodeAt(end) === 13 && md.charCodeAt(end + 1) === 10
        ? end + 2
        : end + 1;
    line++;
  }
  return null;
}

/** Unique heading ids in O(n): per-base counter (`a`, `a-2`, `a-3`; `A-2` after `a-2` is `a-2-2`). */
class HeadingIds {
  private readonly used = new Set<string>();
  private readonly next = new Map<string, number>();

  take(base: string): string {
    let n = this.next.get(base) ?? 1;
    let id = n === 1 ? base : `${base}-${n}`;
    while (this.used.has(id)) {
      n++;
      id = `${base}-${n}`;
    }
    this.next.set(base, n + 1);
    this.used.add(id);
    return id;
  }
}

/** Keeps the first `MAX_REPORTED_ISSUES`; `omitted` appears only when some were dropped. */
function capIssues(issues: LegalMarkdownIssue[]): {
  issues: LegalMarkdownIssue[];
  omitted?: number;
} {
  if (issues.length <= MAX_REPORTED_ISSUES) return { issues };
  return {
    issues: issues.slice(0, MAX_REPORTED_ISSUES),
    omitted: issues.length - MAX_REPORTED_ISSUES,
  };
}

const PARSE_FAILED: LegalMarkdownIssue = {
  line: 1,
  reason:
    'The Markdown is too complex to be processed (simplify its structure)',
};
const PARSE_TIMEOUT: LegalMarkdownIssue = {
  line: 1,
  reason:
    'The server could not analyze it in time (the machine may be busy). Try again; if it persists, simplify the structure (e.g. unclosed [ brackets in long paragraphs)',
};

/** Options token (tests tune the pool; production uses the defaults). */
export const LEGAL_MARKDOWN_OPTIONS = 'LEGAL_MARKDOWN_OPTIONS';
export type LegalMarkdownOptions = Partial<MarkdownPoolOptions> & {
  /** Entries of the toc cache (content-addressed). */
  tocCacheSize?: number;
  /** How long a failed (timeout/crash) toc analysis is remembered. */
  negativeTtlMs?: number;
  /** Clock (ms). Only tests override it. */
  now?: () => number;
};

/**
 * A failed toc analysis (TIMEOUT/FAILED) is remembered for this long, then
 * retried. One minute: a pathological body saved by hand costs at most one
 * `timeoutMs` (3 s) worker per minute per distinct body instead of 3 s on every
 * public GET, while a transient failure (a loaded host, a worker crash, a
 * too-short timeout that was later raised) heals itself within a minute
 * instead of leaving a valid document without index until restart (FR-103).
 */
export const NEGATIVE_TOC_TTL_MS = 60_000;

/**
 * Most issues returned in a 400. 19 900 `www.a.com ` autolinks in 200 KB used
 * to answer 3.8 MB; the editor shows lines, and 50 is more than anyone fixes
 * in one pass. `details.omitted` says how many were left out.
 */
export const MAX_REPORTED_ISSUES = 50;

type TocEntryCache = { toc: LegalTocEntry[]; expiresAt?: number };

/** Story 19.3a: a residual marker or template notice in the visible text. */
export interface LegalResidual {
  token: string;
  line: number;
}

type Analysis = {
  issues: LegalMarkdownIssue[];
  toc: LegalTocEntry[];
  residuals: LegalResidual[];
};

/**
 * Story 19.1 (AD-90, FR-109): server-side Markdown validation on the AST
 * (unified + remark-parse + remark-gfm). The frontend renders with its own
 * allow-list; this keeps forbidden constructs out of the database.
 *
 * ATTEMPT 3 (QA D1): NOTHING parses Markdown on the API event loop. The cheap
 * O(n) `precheckMarkdown` is the first barrier; whatever passes it is parsed by
 * `MarkdownWorkerPool` (bounded `worker_thread`s with a hard deadline), so a
 * pattern nobody has thought of can burn at most one worker for `timeoutMs`
 * and never blocks other requests. Hence `validate`/`buildToc` are async.
 *
 * READ PATH (public GET): `buildToc` is also worker-based, and its result is
 * cached by SHA-256 of the body (versions are immutable, so the key never
 * goes stale and a changed body simply hashes differently): the normal read
 * is a Map lookup, no parse and no thread hop. `validate` primes the cache
 * with the toc it just computed, so a document published after validation is
 * a cache hit on its first read. A miss (process restart, content inserted
 * without validation) is parsed in the pool, concurrent misses of the same
 * body share ONE job. If the body cannot be analyzed in time, the toc
 * degrades to `[]` (the body is still served). That outcome is NOT a property
 * of the content (it depends on load, timeout, crashes), so a TIMEOUT/FAILED is
 * remembered as a NEGATIVE entry with a short TTL (`NEGATIVE_TOC_TTL_MS`) in
 * the same LRU: inside the TTL no worker is launched, after it the analysis is
 * retried and a success replaces it permanently. Only the precheck verdict
 * (pure function of the text) is cached permanently as `[]`; `BUSY`/`CLOSED`
 * are never cached. Positive results stay until evicted by the LRU.
 */
@Injectable()
export class LegalMarkdownService implements OnModuleDestroy {
  private readonly pool: MarkdownWorkerPool;
  private readonly tocCache = new Map<string, TocEntryCache>();
  private readonly inflight = new Map<string, Promise<LegalTocEntry[]>>();
  private readonly tocCacheSize: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;

  constructor(
    @Optional()
    @Inject(LEGAL_MARKDOWN_OPTIONS)
    opts?: LegalMarkdownOptions,
  ) {
    const { tocCacheSize, negativeTtlMs, now, ...poolOpts } = opts ?? {};
    this.tocCacheSize = tocCacheSize ?? 256;
    this.negativeTtlMs = negativeTtlMs ?? NEGATIVE_TOC_TTL_MS;
    this.now = now ?? Date.now;
    this.pool = new MarkdownWorkerPool({
      ...DEFAULT_POOL_OPTIONS,
      ...poolOpts,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.close();
  }

  /** Worker pool counters (alive/busy/queued/spawned/terminated). */
  poolStats(): MarkdownPoolStats {
    return this.pool.stats();
  }

  /** Turns the raw facts of the worker into issues and the toc (cheap, O(n)). */
  private interpret(facts: MarkdownFact[]): Analysis {
    const issues: LegalMarkdownIssue[] = [];
    const toc: LegalTocEntry[] = [];
    const residuals: LegalResidual[] = [];
    const ids = new HeadingIds();
    for (const f of facts) {
      switch (f[0]) {
        case 'html':
          issues.push({ line: f[1], reason: 'Raw HTML is not allowed' });
          break;
        case 'image':
          issues.push({ line: f[1], reason: 'Images are not allowed' });
          break;
        case 'url': {
          const [, type, url, written, line] = f;
          const why = urlRejection(url);
          if (!why) break;
          // GFM literal autolink (`www.x.com`, `http://x.com` in prose): the
          // author never wrote a link, so say what to write instead.
          if (type === 'link' && written !== '' && !/^[[<]/.test(written)) {
            const shown =
              written.length > 60 ? `${written.slice(0, 57)}...` : written;
            issues.push({
              line,
              reason: `Line ${line}: "${shown}" is read as a link but only https:, mailto: and tel: links are allowed. Write the address with https:// (https://${written.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')}) or as [text](https://...)`,
            });
          } else {
            issues.push({ line, reason: why });
          }
          break;
        }
        case 'residual':
          residuals.push({
            token: f[1] === 'notice' ? LEGAL_TEMPLATE_NOTICE : f[2],
            line: f[3],
          });
          break;
        case 'h':
          toc.push({
            depth: f[1],
            text: f[2],
            id: ids.take(slugifyHeading(f[2])),
          });
          break;
      }
    }
    return { issues, toc, residuals };
  }

  /**
   * Prefilter + worker. Resolves with the analysis, or throws a `PoolFailure`
   * (TIMEOUT / FAILED / BUSY / CLOSED); returns the precheck issue when the
   * document breaks a limit.
   */
  private async analyze(
    md: string,
  ): Promise<{ pre: LegalMarkdownIssue } | { result: Analysis }> {
    const pre = precheckMarkdown(md);
    if (pre) return { pre };
    return { result: this.interpret(await this.pool.run(md)) };
  }

  /** Issues found in the document (empty when it is safe). */
  async findIssues(md: string): Promise<LegalMarkdownIssue[]> {
    try {
      const r = await this.analyze(md);
      return capIssues('pre' in r ? [r.pre] : r.result.issues).issues;
    } catch (e) {
      if (e instanceof PoolFailure && e.kind === 'BUSY') throw this.busy();
      return [
        e instanceof PoolFailure && e.kind === 'TIMEOUT'
          ? PARSE_TIMEOUT
          : PARSE_FAILED,
      ];
    }
  }

  /**
   * Line diff of two texts in the shared pool (Story 19.2, QA D1). Throws
   * `PoolFailure` (TIMEOUT / FAILED / BUSY / CLOSED); the caller maps it.
   */
  diff(from: string, to: string): Promise<DiffResult> {
    return this.pool.runDiff(from, to);
  }

  private busy(): ApiException {
    return new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'LEGAL_MARKDOWN_BUSY',
      'The Markdown validator is busy; retry in a few seconds.',
    );
  }

  private remember(key: string, toc: LegalTocEntry[], ttlMs?: number): void {
    this.tocCache.delete(key);
    this.tocCache.set(key, {
      toc,
      ...(ttlMs !== undefined ? { expiresAt: this.now() + ttlMs } : {}),
    });
    if (this.tocCache.size > this.tocCacheSize) {
      const oldest = this.tocCache.keys().next().value;
      if (oldest !== undefined) this.tocCache.delete(oldest);
    }
  }

  /**
   * Table of contents of the `##`/`###` headings, with unique ids (`-2`, `-3`…).
   * Never throws and never parses on the event loop (see the class comment).
   */
  async buildToc(md: string): Promise<LegalTocEntry[]> {
    const key = createHash('sha256').update(md).digest('base64');
    const hit = this.tocCache.get(key);
    if (hit) {
      if (hit.expiresAt === undefined || hit.expiresAt > this.now()) {
        this.tocCache.delete(key); // LRU touch (keeps the original expiry)
        this.tocCache.set(key, hit);
        return hit.toc;
      }
      this.tocCache.delete(key); // negative entry expired: retry below
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const job = (async () => {
      try {
        const r = await this.analyze(md);
        const toc = 'pre' in r ? [] : r.result.toc;
        this.remember(key, toc);
        return toc;
      } catch (e) {
        // BUSY/CLOSED are transient: do not remember them. TIMEOUT/FAILED
        // only for a short while (see NEGATIVE_TOC_TTL_MS).
        // A POSITIVE entry written meanwhile (validate() primes the cache while
        // a toc job of the same body is in flight) must never be overwritten
        // by the negative one: it is correct and permanent (QA 19.1).
        const settled = this.tocCache.get(key);
        if (settled && settled.expiresAt === undefined) return settled.toc;
        if (
          e instanceof PoolFailure &&
          e.kind !== 'BUSY' &&
          e.kind !== 'CLOSED'
        ) {
          this.remember(key, [], this.negativeTtlMs);
        }
        return [];
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, job);
    return job;
  }

  /**
   * Throws 400 `LEGAL_MARKDOWN_INVALID` with `details.issues[{line,reason}]`;
   * otherwise returns the toc. Never 500, never blocks the event loop: the
   * size and shape limits are checked before parsing, the parse runs in a
   * worker with a hard deadline (400 on timeout/crash), and when every worker
   * and the queue are taken it answers 503 `LEGAL_MARKDOWN_BUSY` at once.
   */
  async validate(
    md: string,
  ): Promise<{ toc: LegalTocEntry[]; residuals: LegalResidual[] }> {
    let issues: LegalMarkdownIssue[];
    let tooComplex = true;
    let timedOut = false;
    let toc: LegalTocEntry[] | undefined;
    let residuals: LegalResidual[] = [];
    try {
      const r = await this.analyze(md);
      if ('pre' in r) {
        issues = [r.pre];
      } else {
        issues = r.result.issues;
        toc = r.result.toc;
        residuals = r.result.residuals;
        tooComplex = false;
      }
    } catch (e) {
      if (
        e instanceof PoolFailure &&
        (e.kind === 'BUSY' || e.kind === 'CLOSED')
      ) {
        throw this.busy();
      }
      timedOut = e instanceof PoolFailure && e.kind === 'TIMEOUT';
      issues = [timedOut ? PARSE_TIMEOUT : PARSE_FAILED];
    }
    if (issues.length > 0 || !toc) {
      // Story 19.3b: a deadline can be the server's load, not the text: do not
      // blame the document. Same code and status (the admin UI depends on them).
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'LEGAL_MARKDOWN_INVALID',
        timedOut
          ? 'The server could not analyze the Markdown in time. Try again; if it persists, simplify its structure.'
          : tooComplex
            ? 'The Markdown is too large or too complex.'
            : 'The Markdown contains forbidden constructs.',
        capIssues(issues),
      );
    }
    this.remember(createHash('sha256').update(md).digest('base64'), toc);
    return { toc, residuals };
  }
}
