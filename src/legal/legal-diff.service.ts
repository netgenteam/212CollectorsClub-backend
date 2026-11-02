import { HttpStatus, Injectable } from '@nestjs/common';
import { diffLines } from 'diff';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  DiffHunkDto,
  DiffResponseDto,
  HistoryResponseDto,
} from './dto/legal-admin.dto.js';
import { findLegalDoc } from './legal-admin.common.js';

export const DIFF_CONTEXT_LINES = 3;

const toLines = (s: string): string[] => {
  const t = s.replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // trailing newline is not a line
  return lines;
};

/**
 * Pure line diff (jsdiff `diffLines`) trimmed to `DIFF_CONTEXT_LINES` of
 * context. Each hunk is a RUN of one type with the 1-based line where it
 * starts in the old and the new text. Unchanged stretches longer than twice
 * the context are cut (the gap is implicit in the `oldStart`/`newStart` jump).
 */
export function diffMarkdown(
  from: string,
  to: string,
): Pick<DiffResponseDto, 'stats' | 'hunks'> {
  // Normalize the end of file so "a" vs "a\n" is not reported as a change.
  const norm = (s: string) => {
    const l = toLines(s);
    return l.length > 0 ? l.join('\n') + '\n' : '';
  };
  const parts = diffLines(norm(from), norm(to));
  type Run = { type: DiffHunkDto['type']; lines: string[] };
  const runs: Run[] = parts
    .map((p): Run => ({
      type: p.added ? 'added' : p.removed ? 'removed' : 'context',
      lines: toLines(p.value),
    }))
    .filter((r) => r.lines.length > 0);

  const hunks: DiffHunkDto[] = [];
  const stats = { added: 0, removed: 0 };
  let oldLine = 1;
  let newLine = 1;
  runs.forEach((r, i) => {
    const start = { oldStart: oldLine, newStart: newLine };
    const n = r.lines.length;
    if (r.type === 'added') stats.added += n;
    if (r.type === 'removed') stats.removed += n;
    if (r.type !== 'added') oldLine += n;
    if (r.type !== 'removed') newLine += n;
    if (r.type !== 'context') {
      hunks.push({ type: r.type, lines: r.lines, ...start });
      return;
    }
    const first = i === 0;
    const last = i === runs.length - 1;
    if (first && last) return; // identical texts: nothing changed
    if (first || last) {
      const keep = r.lines.length > DIFF_CONTEXT_LINES ? DIFF_CONTEXT_LINES : n;
      if (first) {
        const skip = n - keep;
        hunks.push({
          type: 'context',
          lines: r.lines.slice(skip),
          oldStart: start.oldStart + skip,
          newStart: start.newStart + skip,
        });
      } else {
        hunks.push({
          type: 'context',
          lines: r.lines.slice(0, keep),
          ...start,
        });
      }
      return;
    }
    if (n <= 2 * DIFF_CONTEXT_LINES) {
      hunks.push({ type: 'context', lines: r.lines, ...start });
    } else {
      hunks.push({
        type: 'context',
        lines: r.lines.slice(0, DIFF_CONTEXT_LINES),
        ...start,
      });
      const skip = n - DIFF_CONTEXT_LINES;
      hunks.push({
        type: 'context',
        lines: r.lines.slice(skip),
        oldStart: start.oldStart + skip,
        newStart: start.newStart + skip,
      });
    }
  });
  return { stats, hunks };
}

/** Story 19.2 (AD-91, FR-107): history and diff. READ ONLY. */
@Injectable()
export class LegalDiffService {
  constructor(private readonly prisma: PrismaService) {}

  async history(slug: string): Promise<HistoryResponseDto> {
    const doc = await findLegalDoc(this.prisma, slug);
    const rows = await this.prisma.$queryRaw<
      {
        versionNumber: number;
        publishedByEmail: string | null;
        publishedAt: Date;
        effectiveFrom: Date;
        changeSummary: string;
        isSubstantial: boolean;
        restoredFromVersion: number | null;
        inForce: boolean;
      }[]
    >`
      SELECT "versionNumber", "publishedByEmail", "publishedAt", "effectiveFrom", "changeSummary",
             "isSubstantial", "restoredFromVersion", ("effectiveFrom" <= now()) AS "inForce"
      FROM "Legal_Document_Versions" WHERE "documentId" = ${doc.id}::uuid
      ORDER BY "versionNumber" DESC`;
    const currentNumber = rows.find((r) => r.inForce)?.versionNumber ?? null;
    return {
      slug: doc.slug,
      title: doc.title,
      versions: rows.map((r) => ({
        versionNumber: r.versionNumber,
        publishedByEmail: r.publishedByEmail,
        publishedAt: r.publishedAt.toISOString(),
        effectiveFrom: r.effectiveFrom.toISOString(),
        changeSummary: r.changeSummary,
        isSubstantial: r.isSubstantial,
        restoredFromVersion: r.restoredFromVersion,
        isCurrent: r.versionNumber === currentNumber,
        isScheduled: !r.inForce,
      })),
    };
  }

  async diff(slug: string, from: number, to: number): Promise<DiffResponseDto> {
    const doc = await findLegalDoc(this.prisma, slug);
    const rows = await this.prisma.$queryRaw<
      { versionNumber: number; bodyMd: string }[]
    >`
      SELECT "versionNumber", "bodyMd" FROM "Legal_Document_Versions"
      WHERE "documentId" = ${doc.id}::uuid AND "versionNumber" IN (${from}, ${to})`;
    const body = (n: number) => rows.find((r) => r.versionNumber === n)?.bodyMd;
    const a = body(from);
    const b = body(to);
    if (a === undefined || b === undefined) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'LEGAL_VERSION_NOT_FOUND',
        'One of the versions does not exist.',
        { missing: [from, to].filter((n) => body(n) === undefined) },
      );
    }
    return { from, to, ...diffMarkdown(a, b) };
  }
}
