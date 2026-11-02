import { HttpStatus, Injectable } from '@nestjs/common';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString as nodeToString } from 'mdast-util-to-string';
import type { Nodes, Root } from 'mdast';
import { ApiException } from '../common/api-exception.js';

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

/** Order-preserving, pre-order, no recursion (a deep AST cannot overflow the stack). */
function* walkNodes(root: Nodes): Generator<Nodes> {
  const stack: Nodes[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    yield node;
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }
  }
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

const PARSE_FAILED: LegalMarkdownIssue = {
  line: 1,
  reason:
    'The Markdown is too complex to be processed (simplify its structure)',
};
const PARSE_ISSUES = [PARSE_FAILED];

/**
 * Story 19.1 (AD-90, FR-109): server-side Markdown validation on the AST
 * (unified + remark-parse + remark-gfm). The frontend renders with its own
 * allow-list; this keeps forbidden constructs out of the database.
 */
@Injectable()
export class LegalMarkdownService {
  private parse(md: string): Root {
    return unified().use(remarkParse).use(remarkGfm).parse(md);
  }

  private analyze(md: string): {
    issues: LegalMarkdownIssue[];
    toc: LegalTocEntry[];
  } {
    const issues: LegalMarkdownIssue[] = [];
    const toc: LegalTocEntry[] = [];
    const ids = new HeadingIds();
    for (const node of walkNodes(this.parse(md))) {
      const line = node.position?.start.line ?? 1;
      switch (node.type) {
        case 'html':
          issues.push({ line, reason: 'Raw HTML is not allowed' });
          break;
        case 'image':
        case 'imageReference':
          issues.push({ line, reason: 'Images are not allowed' });
          break;
        case 'link':
        case 'definition': {
          const why = urlRejection(node.url);
          if (!why) break;
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          const written =
            node.type === 'link' && start !== undefined && end !== undefined
              ? md.slice(start, end)
              : '';
          // GFM literal autolink (`www.x.com`, `http://x.com` in prose): the
          // author never wrote a link, so say what to write instead.
          if (written !== '' && !/^[[<]/.test(written)) {
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
        case 'heading':
          if (node.depth === 2 || node.depth === 3) {
            const text = nodeToString(node).trim();
            toc.push({
              depth: node.depth,
              text,
              id: ids.take(slugifyHeading(text)),
            });
          }
          break;
        default:
      }
    }
    return { issues, toc };
  }

  /** Issues found in the document (empty when it is safe). Pure. */
  findIssues(md: string): LegalMarkdownIssue[] {
    const pre = precheckMarkdown(md);
    if (pre) return [pre];
    try {
      return this.analyze(md).issues;
    } catch {
      return [PARSE_FAILED];
    }
  }

  /** Table of contents of the `##`/`###` headings, with unique ids (`-2`, `-3`…). */
  buildToc(md: string): LegalTocEntry[] {
    try {
      return this.analyze(md).toc;
    } catch {
      return [];
    }
  }

  /**
   * Throws 400 `LEGAL_MARKDOWN_INVALID` with `details.issues[{line,reason}]`;
   * otherwise returns the toc. Never 500 and never unbounded CPU: the size and
   * shape limits are checked before parsing, and a parser failure is a 400.
   */
  validate(md: string): { toc: LegalTocEntry[] } {
    let result: ReturnType<LegalMarkdownService['analyze']> | undefined;
    const pre = precheckMarkdown(md);
    let issues: LegalMarkdownIssue[] = pre ? [pre] : [];
    if (!pre) {
      try {
        result = this.analyze(md);
        issues = result.issues;
      } catch {
        issues = PARSE_ISSUES;
      }
    }
    if (issues.length > 0 || !result) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'LEGAL_MARKDOWN_INVALID',
        pre || issues === PARSE_ISSUES
          ? 'The Markdown is too large or too complex.'
          : 'The Markdown contains forbidden constructs.',
        { issues },
      );
    }
    return { toc: result.toc };
  }
}
