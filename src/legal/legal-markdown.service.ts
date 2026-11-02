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
 * Story 19.1 (AD-90, FR-109): server-side Markdown validation on the AST
 * (unified + remark-parse + remark-gfm). The frontend renders with its own
 * allow-list; this keeps forbidden constructs out of the database.
 */
@Injectable()
export class LegalMarkdownService {
  private parse(md: string): Root {
    return unified().use(remarkParse).use(remarkGfm).parse(md);
  }

  /** Issues found in the document (empty when it is safe). Pure. */
  findIssues(md: string): LegalMarkdownIssue[] {
    const issues: LegalMarkdownIssue[] = [];
    const walk = (node: Nodes): void => {
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
          if (why) issues.push({ line, reason: why });
          break;
        }
        default:
      }
      if ('children' in node) {
        for (const child of node.children) walk(child);
      }
    };
    walk(this.parse(md));
    return issues;
  }

  /** Table of contents of the `##`/`###` headings, with unique ids (`-2`, `-3`…). */
  buildToc(md: string): LegalTocEntry[] {
    const used = new Set<string>();
    const toc: LegalTocEntry[] = [];
    const walk = (node: Nodes): void => {
      if (node.type === 'heading' && (node.depth === 2 || node.depth === 3)) {
        const text = nodeToString(node).trim();
        const base = slugifyHeading(text);
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        toc.push({ depth: node.depth, text, id });
      }
      if ('children' in node) {
        for (const child of node.children) walk(child);
      }
    };
    walk(this.parse(md));
    return toc;
  }

  /**
   * Throws 400 `LEGAL_MARKDOWN_INVALID` with `details.issues[{line,reason}]`;
   * otherwise returns the toc.
   */
  validate(md: string): { toc: LegalTocEntry[] } {
    const issues = this.findIssues(md);
    if (issues.length > 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'LEGAL_MARKDOWN_INVALID',
        'The Markdown contains forbidden constructs.',
        { issues },
      );
    }
    return { toc: this.buildToc(md) };
  }
}
