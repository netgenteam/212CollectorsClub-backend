import ts from 'typescript';

/**
 * Story 20.1 (QA round 3): static check for `AuditService.record(tx, ev)`.
 *
 * `record` takes the chain-head advisory lock and keeps it until the transaction
 * COMMITS, so nothing slow may run after it in the same transaction. This is a NET,
 * not a barrier: it reads one file at a time (TypeScript AST, no types), follows the
 * code that can run after the call and reports what it recognises as work.
 *
 * Recognised as an audit write (a "writer"):
 *   - `x.record(tx, ...)` and `x['record'](tx, ...)`;
 *   - an alias: `const rec = x.record` / `x.record.bind(x)` / `{ record } = x` /
 *     `{ record: rec } = x`, then `rec(tx, ...)`;
 *   - a helper of the same file that (transitively) contains a writer:
 *     `this.emit(tx, ev)` when `emit` calls `record`.
 *
 * Recognised as work AFTER a writer (reachable from it, same function):
 *   - an `await` that is not itself a writer (or `Promise.all([writers])`), a
 *     `for await`;
 *   - `.then(` / `.catch(` / `.finally(` chained on the writer or called later;
 *   - any other use of the transaction (`tx.x`, `other(tx)`), awaited or not;
 *   - a non-writer call next to the writer inside `Promise.all/allSettled/race/any`.
 *
 * Reachability follows the statements after the call, climbing out of its blocks,
 * and it respects: the other branch of an `if` / `?:` / `switch`, a `catch` of the
 * `try` the call is in, code after a `return` / `throw`, and loops (the whole loop
 * counts: the next iteration runs after this call). Comments and strings are never
 * code (the AST has no text to confuse).
 *
 * NOT recognised (say so, it is a net): a writer in ANOTHER file, work hidden in a
 * nested callback (`rows.map(async ...)`, not walked), a helper reached through a
 * variable, an unawaited call that starts slow work without using `tx`, and
 * `record` wrapped in a function that is exported and called from elsewhere.
 */
type Fn =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

const isFn = (n: ts.Node): n is Fn =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);

const isStatementNode = (n: ts.Node): boolean =>
  n.kind >= ts.SyntaxKind.FirstStatement &&
  n.kind <= ts.SyntaxKind.LastStatement;

const unparen = (n: ts.Expression): ts.Expression => {
  let e = n;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
};

/** Name of the member a callee ends in (`a.b.c` -> `c`, `a['c']` -> `c`, `c` -> `c`). */
const calleeName = (callee: ts.Expression): string | null => {
  const e = unparen(callee);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (
    ts.isElementAccessExpression(e) &&
    ts.isStringLiteralLike(e.argumentExpression)
  ) {
    return e.argumentExpression.text;
  }
  return null;
};

/** Walk `root` without entering nested functions (their code does not run inline). */
function walkInline(root: ts.Node, visit: (n: ts.Node) => void): void {
  const go = (n: ts.Node): void => {
    visit(n);
    ts.forEachChild(n, (c) => {
      if (!isFn(c)) go(c);
    });
  };
  ts.forEachChild(root, (c) => {
    if (!isFn(c)) go(c);
  });
}

const enclosingFn = (n: ts.Node): ts.Node => {
  for (let p = n.parent; p; p = p.parent) if (isFn(p)) return p;
  return n.getSourceFile();
};

const PROMISE_COMBINATORS = new Set(['all', 'allSettled', 'race', 'any']);
const isPromiseCombinator = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  ts.isIdentifier(n.expression.expression) &&
  n.expression.expression.text === 'Promise' &&
  PROMISE_COMBINATORS.has(n.expression.name.text);

export function findRecordMisuse(src: string): string[] {
  const sf = ts.createSourceFile(
    'x.ts',
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  // 1. aliases of `.record`
  const aliases = new Set<string>();
  const isRecordMember = (e: ts.Expression): boolean => {
    let x = unparen(e);
    // x.record.bind(x)
    if (
      ts.isCallExpression(x) &&
      ts.isPropertyAccessExpression(x.expression) &&
      x.expression.name.text === 'bind'
    ) {
      x = unparen(x.expression.expression);
    }
    return calleeName(x) === 'record' && !ts.isIdentifier(x);
  };
  const collectAliases = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name) && isRecordMember(n.initializer)) {
        aliases.add(n.name.text);
      }
      if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) {
          const prop = el.propertyName ?? el.name;
          if (
            ts.isIdentifier(prop) &&
            prop.text === 'record' &&
            ts.isIdentifier(el.name)
          ) {
            aliases.add(el.name.text);
          }
        }
      }
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      isRecordMember(n.right)
    ) {
      aliases.add(n.left.text);
    }
    ts.forEachChild(n, collectAliases);
  };
  collectAliases(sf);

  // 2. helpers of this file that contain a writer (to a fixpoint)
  const writerNames = new Set<string>();
  const isDirectWriter = (n: ts.Node): n is ts.CallExpression => {
    if (!ts.isCallExpression(n) || n.arguments.length < 1) return false;
    const callee = unparen(n.expression);
    if (ts.isIdentifier(callee)) {
      return aliases.has(callee.text) || writerNames.has(callee.text);
    }
    const name = calleeName(callee);
    if (name === null) return false;
    return name === 'record' || writerNames.has(name);
  };
  const fnName = (f: Fn): string | null => {
    if (f.name && (ts.isIdentifier(f.name) || ts.isPrivateIdentifier(f.name))) {
      return f.name.text.replace(/^#/, '');
    }
    const p = f.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
    if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
    if (p && ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
    return null;
  };
  const fns: Fn[] = [];
  const collectFns = (n: ts.Node): void => {
    if (isFn(n)) fns.push(n);
    ts.forEachChild(n, collectFns);
  };
  collectFns(sf);
  for (let changed = true; changed;) {
    changed = false;
    for (const f of fns) {
      const name = fnName(f);
      if (name === null || name === 'record' || writerNames.has(name)) continue;
      let has = false;
      if (f.body) {
        walkInline(f.body, (n) => {
          if (isDirectWriter(n)) has = true;
        });
      }
      if (has) {
        writerNames.add(name);
        changed = true;
      }
    }
  }

  const isWriter = (n: ts.Node): n is ts.CallExpression => isDirectWriter(n);

  /** `await <writer>` or `await Promise.all([<writer>, ...])` is the same lock, not new work. */
  const benignOperand = (e: ts.Expression): boolean => {
    const x = unparen(e);
    if (isWriter(x)) return true;
    if (isPromiseCombinator(x) && x.arguments.length === 1) {
      const arr = unparen(x.arguments[0]);
      return (
        ts.isArrayLiteralExpression(arr) &&
        arr.elements.length > 0 &&
        arr.elements.every((el) => isWriter(unparen(el)))
      );
    }
    return false;
  };

  const out: string[] = [];
  const lineOf = (n: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const writers: ts.CallExpression[] = [];
  const findWriters = (n: ts.Node): void => {
    if (isWriter(n)) writers.push(n);
    ts.forEachChild(n, findWriters);
  };
  findWriters(sf);

  for (const w of writers) {
    // Only direct `record(tx, ...)` call sites are reported: a helper's own call
    // sites are the writers of its callers. A writer inside a helper is checked too.
    const fn = enclosingFn(w);
    const txArg = w.arguments[0];
    const txName = ts.isIdentifier(txArg) ? txArg.text : null;
    const reasons = new Set<string>();

    // Nodes whose inline code runs after `w`.
    const reachable: ts.Node[] = [];
    let stopped = false;
    const isExit = (s: ts.Node): boolean =>
      ts.isReturnStatement(s) || ts.isThrowStatement(s);

    let cur: ts.Node = w;
    while (cur.parent && cur !== fn && !stopped) {
      const p: ts.Node = cur.parent;
      if (isFn(p)) break;
      if (
        ts.isBlock(p) ||
        ts.isSourceFile(p) ||
        ts.isCaseClause(p) ||
        ts.isDefaultClause(p) ||
        ts.isModuleBlock(p)
      ) {
        const list = p.statements;
        const i = list.indexOf(cur as ts.Statement);
        if (isExit(cur)) break;
        for (const s of list.slice(i + 1)) {
          reachable.push(s);
          if (isExit(s)) {
            stopped = true;
            break;
          }
        }
      } else if (ts.isIfStatement(p)) {
        if (cur === p.expression) {
          reachable.push(p.thenStatement);
          if (p.elseStatement) reachable.push(p.elseStatement);
        }
      } else if (ts.isConditionalExpression(p)) {
        if (cur === p.condition) reachable.push(p.whenTrue, p.whenFalse);
      } else if (ts.isTryStatement(p)) {
        if (cur === p.tryBlock || cur === p.catchClause) {
          if (p.finallyBlock) reachable.push(p.finallyBlock);
        }
      } else if (
        ts.isForStatement(p) ||
        ts.isForOfStatement(p) ||
        ts.isForInStatement(p) ||
        ts.isWhileStatement(p) ||
        ts.isDoStatement(p)
      ) {
        // the next iteration runs after this call
        reachable.push(p);
        if (ts.isForOfStatement(p) && p.awaitModifier) {
          reasons.add('for await loop around record()');
        }
      } else if (ts.isPropertyAccessExpression(p) && p.expression === cur) {
        if (['then', 'catch', 'finally'].includes(p.name.text)) {
          reasons.add(`.${p.name.text}( chained on record()`);
        }
      }
      if (ts.isArrayLiteralExpression(p)) {
        const call = p.parent && unparen(p.parent as ts.Expression);
        if (call && isPromiseCombinator(call)) {
          for (const el of p.elements) {
            const e = unparen(el);
            if (e === cur || isWriter(e)) continue;
            let hasCall = false;
            const scan = (n: ts.Node): void => {
              if (ts.isCallExpression(n) || ts.isAwaitExpression(n)) {
                hasCall = true;
              }
              if (!isFn(n)) ts.forEachChild(n, scan);
            };
            scan(e);
            if (hasCall) reasons.add('work next to record() in Promise.all');
          }
        }
      }
      if (
        !isStatementNode(p) &&
        !ts.isConditionalExpression(p) &&
        !ts.isPropertyAccessExpression(p)
      ) {
        // expression: operands evaluated after `cur`
        const kids: ts.Node[] = [];
        ts.forEachChild(p, (c) => {
          if (c.pos >= cur.end && !isFn(c)) kids.push(c);
        });
        reachable.push(...kids);
      }
      cur = p;
    }

    for (const r of reachable) {
      const visit = (n: ts.Node): void => {
        if (ts.isAwaitExpression(n)) {
          if (!benignOperand(n.expression)) {
            reasons.add('await after record()');
          }
        } else if (ts.isForOfStatement(n) && n.awaitModifier) {
          reasons.add('for await after record()');
        } else if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          ['then', 'catch', 'finally'].includes(n.expression.name.text)
        ) {
          reasons.add(`.${n.expression.name.text}( after record()`);
        } else if (
          txName !== null &&
          ts.isIdentifier(n) &&
          n.text === txName &&
          !isShorthandOrDeclaration(n) &&
          !isArgOfWriter(n, isWriter)
        ) {
          reasons.add(`the transaction (${txName}) is used after record()`);
        }
      };
      const go = (n: ts.Node): void => {
        if (isFn(n)) return;
        visit(n);
        ts.forEachChild(n, go);
      };
      go(r);
    }

    if (reasons.size > 0) {
      out.push(
        `line ${lineOf(w)}: ${[...reasons].join('; ')} (the chain lock is held until commit)`,
      );
    }
  }
  return out;
}

function isShorthandOrDeclaration(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isParameter(p) && p.name === id) ||
    (ts.isVariableDeclaration(p) && p.name === id)
  );
}

/** `tx` passed to another writer (`record(tx, b)`) is the same lock. */
function isArgOfWriter(
  id: ts.Identifier,
  isWriter: (n: ts.Node) => boolean,
): boolean {
  const p = id.parent;
  return ts.isCallExpression(p) && p.arguments[0] === id && isWriter(p);
}
