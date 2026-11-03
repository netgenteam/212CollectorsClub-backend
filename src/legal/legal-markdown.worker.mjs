// Story 19.2 (QA D1): this worker also runs the legal line diff (job type
// 'diff', see legal-diff.core.mjs), so the pool is shared. A message without
// `type` (or type 'markdown') is the Markdown analysis below. Answers are
// `{ id, ok: true, result }` or `{ id, ok: false, error }`.
//
// Story 19.1 (attempt 3, QA D1): Markdown parsing runs HERE, in a worker_thread,
// never on the API event loop. remark/micromark is super-linear on some inputs
// (a stray `[` followed by long text: 13 s for 177 KB), so the pool terminates
// this thread if it exceeds a hard deadline.
//
// This file is plain ESM JavaScript on purpose: a Worker cannot load `.ts`
// (vitest/vite-node transpile in-process, not in worker threads), and plain JS
// is byte-identical in `src/` (vitest/e2e) and `dist/` (nest build copies it
// as an asset). It only extracts RAW FACTS from the AST; every policy decision
// (allowed URL schemes, slugs, messages) stays in the TypeScript service.
//
// Facts (in document order):
//   ['html', line] | ['image', line]
//   ['url', 'link'|'definition', url, written, line]   (written: source text of a link, '' otherwise)
//   ['h', depth(2|3), text, line]
//   ['residual', 'marker'|'notice', token, line]   (Story 19.3a, see legal-residual.core.mjs)
import { parentPort } from 'node:worker_threads';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString as nodeToString } from 'mdast-util-to-string';
import { diffMarkdown } from './legal-diff.core.mjs';
import { findResiduals } from './legal-residual.core.mjs';

const MAX_WRITTEN = 2100;

// Story 19.3a: node types that are inline (everything else starts a block and
// separates the visible text pieces collected for the residual check).
const PHRASING = new Set([
  'text',
  'emphasis',
  'strong',
  'delete',
  'inlineCode',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'break',
  'html',
  'footnoteReference',
]);

function analyze(md) {
  const root = unified().use(remarkParse).use(remarkGfm).parse(md);
  const facts = [];
  // Visible text of the document as the public will read it (what the AST
  // keeps: entities decoded, `\\[` unescaped, no `>` prefixes, no emphasis /
  // link syntax), as [text, firstLine] pieces in document order.
  const pieces = [];
  // Iterative pre-order walk: a deep AST cannot overflow the stack.
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    const line = node.position?.start.line ?? 1;
    if (node !== root && !PHRASING.has(node.type)) pieces.push(['\n', line]);
    switch (node.type) {
      case 'text':
      case 'inlineCode':
        pieces.push([node.value, line]);
        break;
      case 'code': {
        const c = md.charAt(node.position?.start.offset ?? 0);
        pieces.push([node.value, line + (c === '`' || c === '~' ? 1 : 0)]);
        break;
      }
      case 'break':
        pieces.push(['\n', line]);
        break;
      case 'html':
        pieces.push([node.value, line]);
        facts.push(['html', line]);
        break;
      case 'image':
      case 'imageReference':
        facts.push(['image', line]);
        break;
      case 'link':
      case 'definition': {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const written =
          node.type === 'link' && start !== undefined && end !== undefined
            ? md.slice(start, Math.min(end, start + MAX_WRITTEN))
            : '';
        facts.push(['url', node.type, node.url, written, line]);
        break;
      }
      case 'heading':
        if (node.depth === 2 || node.depth === 3) {
          facts.push(['h', node.depth, nodeToString(node).trim(), line]);
        }
        break;
      default:
    }
    if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }
  }
  for (const r of findResiduals(pieces)) facts.push(['residual', ...r]);
  return facts;
}

parentPort.on('message', (msg) => {
  const { id } = msg;
  try {
    const result =
      msg.type === 'diff' ? diffMarkdown(msg.from, msg.to) : analyze(msg.md);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
