export const DIFF_CONTEXT_LINES: number;
export interface DiffHunk {
  type: 'added' | 'removed' | 'context';
  lines: string[];
  oldStart: number;
  newStart: number;
}
export function diffMarkdown(
  from: string,
  to: string,
): { stats: { added: number; removed: number }; hunks: DiffHunk[] };
