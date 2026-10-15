// queries 里不许用 Promise.all 并行库查询（#2181 那类）：一条失败函数就返回，其余查询还在别的连接上占着锁，
// 紧接着的写或清表会交叉等锁。并行查询用 allSettledOrThrow。不包库查询的 Promise.all（纯计算）不拦。
// 注释和字符串里写到 Promise.all 不算。Promise.allSettled 会等全部落地，也不算。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const DB = join(import.meta.dirname, '..');
const QUERIES = join(DB, 'src', 'queries');

const HINT = 'Promise.all 包着库查询会在一条失败时提前返回，其余查询还占着连接和锁。改用 allSettledOrThrow。';

/** db/tx 是连接，sql 是片段；select/insert/update/delete/execute 是查询动词。Array.from 不算。 */
const DB_MARKER = /\b(?:db|tx)\b|\bsql\b|\.(?:select|insert|update|delete|execute)\s*\(/;

const SKIP_NAMES = new Set([
  'if',
  'else',
  'return',
  'await',
  'async',
  'new',
  'typeof',
  'instanceof',
  'void',
  'true',
  'false',
  'null',
  'undefined',
  'const',
  'let',
  'var',
  'function',
  'class',
  'of',
  'in',
  'as',
  'satisfies',
  'import',
  'export',
  'from',
  'this',
  'super',
  'throw',
  'try',
  'catch',
  'finally',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'default',
  'delete',
  'extends',
  'yield',
  'static',
  'get',
  'set',
  'type',
  'interface',
  'enum',
  'readonly',
  'infer',
  'keyof',
  'never',
  'unknown',
  'any',
  'string',
  'number',
  'boolean',
  'object',
  'bigint',
  'Promise',
  'Array',
  'Object',
  'Math',
  'Number',
  'String',
  'Boolean',
  'Date',
  'JSON',
  'Error',
  'Map',
  'Set',
  'NaN',
  'Infinity',
]);

type Binding = { kind: 'function' | 'value'; body: string; awaited: boolean };
type Hit = { file: string; line: number; message: string };

function maskCommentsAndStrings(code: string): string {
  let out = '';
  let i = 0;
  const masked = (from: number, to: number) => {
    for (let j = from; j < to; j++) out += code[j] === '\n' ? '\n' : ' ';
  };
  while (i < code.length) {
    const c = code[i] ?? '';
    const n = code[i + 1] ?? '';
    if (c === '/' && n === '/') {
      const nl = code.indexOf('\n', i);
      const end = nl === -1 ? code.length : nl;
      masked(i, end);
      i = end;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = code.indexOf('*/', i + 2);
      const to = end === -1 ? code.length : end + 2;
      masked(i, to);
      i = to;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = endOfQuote(code, i);
      masked(i, end);
      i = end;
      continue;
    }
    if (c === '`') {
      out += ' ';
      i++;
      while (i < code.length) {
        const ch = code[i] ?? '';
        if (ch === '\\') {
          masked(i, Math.min(code.length, i + 2));
          i += 2;
          continue;
        }
        if (ch === '`') {
          out += ' ';
          i++;
          break;
        }
        if (ch === '$' && code[i + 1] === '{') {
          const expr = readBalanced(code, i + 1, '{', '}');
          out += '${';
          out += maskCommentsAndStrings(expr.body);
          out += '}';
          i = expr.end;
          continue;
        }
        out += ch === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function endOfQuote(code: string, open: number): number {
  const quote = code[open] ?? '';
  let i = open + 1;
  while (i < code.length) {
    const c = code[i] ?? '';
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === '\n') return i;
    i++;
  }
  return i;
}

function readBalanced(
  code: string,
  open: number,
  openCh: string,
  closeCh: string,
): { body: string; end: number } {
  let depth = 0;
  let i = open;
  const start = open + 1;
  while (i < code.length) {
    const c = code[i] ?? '';
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return { body: code.slice(start, i), end: i + 1 };
    }
    i++;
  }
  return { body: code.slice(start), end: code.length };
}

function skipWs(code: string, i: number): number {
  while (i < code.length && (code[i] === ' ' || code[i] === '\n' || code[i] === '\t' || code[i] === '\r'))
    i++;
  return i;
}

function skipTypeTo(code: string, i: number, goal: '{' | '=>'): number {
  let depth = 0;
  i++;
  while (i < code.length) {
    const c = code[i] ?? '';
    if (depth === 0 && c === ';') return -1;
    if (depth === 0 && goal === '=>' && code.startsWith('=>', i)) return i;
    // 返回类型可以是对象类型 `{ a: string }`，后面才是函数体。对象类型整段跳过，后面还有 `{` 时那个才是函数体。
    if (depth === 0 && c === '{') {
      if (goal === '{') {
        const block = readBalanced(code, i, '{', '}');
        const after = skipWs(code, block.end);
        return code[after] === '{' ? after : i;
      }
      depth++;
      i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') {
      if (depth === 0) return -1;
      depth--;
    }
    i++;
  }
  return -1;
}

function parseFunctionFromParams(code: string, i: number): Binding | undefined {
  i = skipWs(code, i);
  if (code[i] !== '(') return undefined;
  const params = readBalanced(code, i, '(', ')');
  let j = skipWs(code, params.end);
  if (code[j] === ':') {
    j = skipTypeTo(code, j, '{');
    if (j < 0) return undefined;
  }
  if (code[j] !== '{') return undefined;
  const block = readBalanced(code, j, '{', '}');
  return { kind: 'function', body: block.body, awaited: false };
}

function readExpr(code: string, i: number): { body: string; end: number } {
  const start = i;
  let depth = 0;
  while (i < code.length) {
    const c = code[i] ?? '';
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') {
      if (depth === 0) break;
      depth--;
    } else if (c === ';' && depth === 0) return { body: code.slice(start, i), end: i };
    i++;
  }
  return { body: code.slice(start, i), end: i };
}

function parseArrowBody(code: string, i: number): Binding {
  i = skipWs(code, i);
  if (code[i] === '{') {
    const block = readBalanced(code, i, '{', '}');
    return { kind: 'function', body: block.body, awaited: false };
  }
  const expr = readExpr(code, i);
  return { kind: 'function', body: expr.body, awaited: false };
}

function parseAfterEquals(code: string, i: number): Binding | undefined {
  i = skipWs(code, i);
  if (code.startsWith('async', i) && /[\s(]/.test(code[i + 5] ?? '')) {
    const after = skipWs(code, i + 5);
    if (code.startsWith('function', after) || code[after] === '(' || /^[A-Za-z_$]/.test(code[after] ?? '')) {
      i = after;
    }
  }
  if (code.startsWith('function', i) && !/[\w$]/.test(code[i + 8] ?? '')) {
    let j = skipWs(code, i + 8);
    if (/^[A-Za-z_$]/.test(code[j] ?? '')) {
      while (j < code.length && /[\w$]/.test(code[j] ?? '')) j++;
    }
    return parseFunctionFromParams(code, j);
  }
  if (code[i] === '(') {
    const params = readBalanced(code, i, '(', ')');
    const j = skipWs(code, params.end);
    if (code[j] === ':') {
      const arrow = skipTypeTo(code, j, '=>');
      if (arrow >= 0 && code.startsWith('=>', arrow)) return parseArrowBody(code, arrow + 2);
    }
    if (code.startsWith('=>', j)) return parseArrowBody(code, j + 2);
    const expr = readExpr(code, i);
    return { kind: 'value', body: expr.body, awaited: /\bawait\b/.test(expr.body) };
  }
  const identArrow = /^[A-Za-z_$][\w$]*\s*=>/.exec(code.slice(i));
  if (identArrow) return parseArrowBody(code, i + identArrow[0].length);
  const expr = readExpr(code, i);
  return { kind: 'value', body: expr.body, awaited: /\bawait\b/.test(expr.body) };
}

function skipToEquals(code: string, i: number): number {
  let depth = 0;
  while (i < code.length) {
    const c = code[i] ?? '';
    const prev = code[i - 1] ?? '';
    const next = code[i + 1] ?? '';
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') {
      if (depth === 0) return -1;
      depth--;
    } else if (c === '=' && next !== '=' && prev !== '!' && prev !== '<' && prev !== '>' && depth === 0) {
      return i + 1;
    } else if (c === ';' && depth === 0) return -1;
    i++;
  }
  return -1;
}

function parseVarAfterName(code: string, i: number): Binding | undefined {
  const eq = skipToEquals(code, i);
  if (eq < 0) return undefined;
  return parseAfterEquals(code, eq);
}

function collectBindings(code: string): Map<string, Binding[]> {
  const map = new Map<string, Binding[]>();
  const re =
    /\b(?:async\s+function|function)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g;
  for (const m of code.matchAll(re)) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    const binding =
      m[1] !== undefined
        ? parseFunctionFromParams(code, (m.index ?? 0) + m[0].length)
        : parseVarAfterName(code, (m.index ?? 0) + m[0].length);
    if (!binding) continue;
    const list = map.get(name) ?? [];
    list.push(binding);
    map.set(name, list);
  }
  // `pending.push(q)` 往数组里塞查询，也算 pending 的值。
  for (const m of code.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\.\s*(?:push|unshift)\s*\(/g)) {
    const name = m[1];
    if (!name) continue;
    const args = readBalanced(code, (m.index ?? 0) + m[0].length - 1, '(', ')');
    const list = map.get(name) ?? [];
    list.push({ kind: 'value', body: args.body, awaited: /\bawait\b/.test(args.body) });
    map.set(name, list);
  }
  return map;
}

function referencedNames(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\b/g)) {
    const name = m[2];
    if (!name || SKIP_NAMES.has(name)) continue;
    names.push(name);
  }
  return names;
}

/**
 * 参数本身，或它调用的本地函数（再进一层）会发查询，或它拿着还没 await 的查询。
 * 没 await 的变量接着往里追（`const pending = [q]`、`pending.push(q)` 里的 q），await 过的是查完的行，不追。
 */
function wrapsQuery(file: string, arg: string): boolean {
  if (DB_MARKER.test(arg)) return true;
  const binds = collectBindings(file);
  const seen = new Set<string>();
  const queue = referencedNames(arg).map((name) => ({ name, depth: 0 }));
  while (queue.length > 0) {
    const item = queue.pop();
    if (!item || seen.has(item.name)) continue;
    seen.add(item.name);
    const list = binds.get(item.name);
    if (!list) continue;
    for (const binding of list) {
      if (binding.kind === 'value' && binding.awaited) continue;
      if (DB_MARKER.test(binding.body)) return true;
      if (item.depth < 2) {
        for (const name of referencedNames(binding.body)) queue.push({ name, depth: item.depth + 1 });
      }
    }
  }
  return false;
}

/** 扫一份源码。file 只写进报错，方便指到哪一行。 */
function promiseAllQueryHits(file: string, code: string): Hit[] {
  const masked = maskCommentsAndStrings(code);
  const hits: Hit[] = [];
  for (const m of masked.matchAll(/Promise\s*\.\s*all(?![\w$])/g)) {
    const index = m.index ?? 0;
    let i = skipWs(masked, index + m[0].length);
    if (masked[i] === '<') {
      const gen = readBalanced(masked, i, '<', '>');
      i = skipWs(masked, gen.end);
    }
    if (masked[i] !== '(') continue;
    const arg = readBalanced(masked, i, '(', ')');
    if (!wrapsQuery(masked, arg.body)) continue;
    const line = masked.slice(0, index).split('\n').length;
    hits.push({ file, line, message: `${file}:${line} ${HINT}` });
  }
  return hits;
}

function querySources(): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile() && ent.name.endsWith('.ts')) {
        out.push({ file: relative(DB, abs), code: readFileSync(abs, 'utf8') });
      }
    }
  };
  walk(QUERIES);
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

describe('queries 里不许 Promise.all 包库查询', () => {
  it('扫得到 queries 目录（没扫到不能当没问题）', () => {
    expect(querySources().length).toBeGreaterThan(30);
  });

  it('现有查询没有 Promise.all 包库查询', () => {
    const hits = querySources().flatMap(({ file, code }) => promiseAllQueryHits(file, code));
    expect(hits.map((h) => h.message)).toEqual([]);
  });

  it('直接包着 db.select 的 Promise.all 要拦，并提示 allSettledOrThrow', () => {
    const code = [
      'export async function load(db: Db) {',
      '  return Promise.all([db.select().from(t), db.select().from(u)]);',
      '}',
    ].join('\n');
    const hits = promiseAllQueryHits('sample.ts', code);
    expect(hits.map((h) => h.line)).toEqual([2]);
    expect(hits[0]?.message).toContain('allSettledOrThrow');
  });

  it('本地函数才去查库、Promise.all 只调用它（scheduleHealth 的 latestPer）要拦', () => {
    const code = [
      'export async function scheduleHealth(db: Db) {',
      '  const latestPer = (only?: readonly string[]) =>',
      '    db.select().from(scheduleRuns).where(only);',
      '  return Promise.all([latestPer(), latestPer(["ok"])]);',
      '}',
    ].join('\n');
    expect(promiseAllQueryHits('sample.ts', code).map((h) => h.line)).toEqual([4]);
  });

  it('查询已经发出去、还没 await，放进 Promise.all 要拦', () => {
    const code = [
      'export async function load(db: Db) {',
      '  const q1 = db.select().from(t);',
      '  const q2 = db.select().from(u);',
      '  return Promise.all([q1, q2]);',
      '}',
    ].join('\n');
    expect(promiseAllQueryHits('sample.ts', code)).toHaveLength(1);
  });

  it('查询先放进变量数组再交给 Promise.all，要拦', () => {
    const code = [
      'export async function load(db: Db) {',
      '  const q = db.select().from(t);',
      '  const pending = [q];',
      '  await Promise.all(pending);',
      '}',
    ].join('\n');
    const hits = promiseAllQueryHits('sample.ts', code);
    expect(hits.map((h) => h.line)).toEqual([4]);
    expect(hits[0]?.message).toContain('allSettledOrThrow');
  });

  it('查询 push 进数组再交给 Promise.all，要拦', () => {
    const code = [
      'export async function load(db: Db, ids: string[]) {',
      '  const pending: Promise<unknown>[] = [];',
      '  for (const id of ids) pending.push(db.select().from(t).where(id));',
      '  await Promise.all(pending);',
      '}',
    ].join('\n');
    expect(promiseAllQueryHits('sample.ts', code).map((h) => h.line)).toEqual([4]);
  });

  it('数组里放的是 map 出来的查询函数调用，要拦', () => {
    const code = [
      'function loadOne(db: Db, id: string) {',
      '  return db.select().from(t).where(id);',
      '}',
      'export async function load(db: Db, ids: string[]) {',
      '  const pending = ids.map((id) => loadOne(db, id));',
      '  return Promise.all(pending);',
      '}',
    ].join('\n');
    expect(promiseAllQueryHits('sample.ts', code)).toHaveLength(1);
  });

  it('数组里是 await 完的行再做纯计算，不拦', () => {
    const code = [
      'function hash(s: string) {',
      '  return s.length;',
      '}',
      'export async function go(db: Db) {',
      '  const rows = await db.select().from(t);',
      '  const pending = rows.map((row) => hash(row.id));',
      '  return Promise.all(pending);',
      '}',
    ].join('\n');
    expect(promiseAllQueryHits('sample.ts', code)).toEqual([]);
  });

  it('返回类型写成对象类型的本地查询函数也要拦', () => {
    const code = [
      'function load(db: Db): { rows: string[] } {',
      '  return { rows: db.select().from(t) };',
      '}',
      'export async function go() {',
      '  return Promise.all([load(getDb())]);',
      '}',
    ].join('\n');
    expect(promiseAllQueryHits('sample.ts', code)).toHaveLength(1);
  });

  it('包一层再查的本地函数要拦', () => {
    const code = [
      'function load(db: Db) {',
      '  return db.select().from(t);',
      '}',
      'function wrap() {',
      '  return load(getDb());',
      '}',
      'export async function go() {',
      '  return Promise.all([wrap(), wrap()]);',
      '}',
    ].join('\n');
    expect(promiseAllQueryHits('sample.ts', code)).toHaveLength(1);
  });

  it('纯计算的 Promise.all 不拦', () => {
    const code = [
      'function hash(s: string) {',
      '  return s.length;',
      '}',
      'export async function go() {',
      '  return Promise.all([hash("a"), hash("b")]);',
      '}',
    ].join('\n');
    expect(promiseAllQueryHits('sample.ts', code)).toEqual([]);
  });

  it('行已经 await 完，再并行做纯计算，不拦', () => {
    const code = [
      'function hash(s: string) {',
      '  return s.length;',
      '}',
      'export async function go(db: Db) {',
      '  const rows = await db.select().from(t);',
      '  return Promise.all(rows.map((row) => hash(row.id)));',
      '}',
    ].join('\n');
    expect(promiseAllQueryHits('sample.ts', code)).toEqual([]);
  });

  it('注释、字符串、Promise.allSettled 不拦', () => {
    const code = [
      '// Promise.all([db.select().from(t)])',
      '/* Promise.all([db.select().from(u)]) */',
      'const note = "Promise.all([db.select().from(v)])";',
      'export async function go(db: Db) {',
      '  return Promise.allSettled([db.select().from(t), db.select().from(u)]);',
      '}',
    ].join('\n');
    expect(promiseAllQueryHits('sample.ts', code)).toEqual([]);
  });
});
