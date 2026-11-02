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
import { parentPort } from 'node:worker_threads';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString as nodeToString } from 'mdast-util-to-string';

const MAX_WRITTEN = 2100;

function analyze(md) {
  const root = unified().use(remarkParse).use(remarkGfm).parse(md);
  const facts = [];
  // Iterative pre-order walk: a deep AST cannot overflow the stack.
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    const line = node.position?.start.line ?? 1;
    switch (node.type) {
      case 'html':
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
  return facts;
}

parentPort.on('message', (msg) => {
  const { id, md } = msg;
  try {
    parentPort.postMessage({ id, ok: true, facts: analyze(md) });
  } catch (e) {
    parentPort.postMessage({
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
