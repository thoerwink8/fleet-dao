// 本包的静态检查，两条：
// 1. test/ 顶层不许直接同步起子进程（#264 这一片）：spawnSync / execFileSync / execSync 只留在 child.ts。只扫顶层 .ts，子目录（fixtures/）本片不碰。
// 2. src/ 里不许用 Promise.all / race / any 并行（#2261）：一条失败（或一条先落定）就返回，其余库查询还在别的连接上占着锁，
//    紧接着的写或清表交叉等锁，真 Postgres 报 deadlock detected（#2181）。并行查询用 src/queries/all-settled.ts 的 allSettledOrThrow。
// 注释和引号里的字是在提这个词，不是调用，去掉再扫。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST = import.meta.dirname;
const SRC = join(TEST, '..', 'src');

/** 去掉注释和引号里的字符串（反引号 ${} 里的代码留下：那是代码，不是字面量）。 */
function stripCommentsAndStrings(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i] ?? '';
    const n = code[i + 1] ?? '';
    if (c === '/' && n === '/') {
      const nl = code.indexOf('\n', i);
      i = nl === -1 ? code.length : nl;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = endOfQuote(code, i + 1, c);
      continue;
    }
    if (c === '`') {
      const template = readTemplate(code, i + 1);
      out += stripCommentsAndStrings(template.inner);
      i = template.end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function endOfQuote(code: string, i: number, quote: string): number {
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

/**
 * 从模板内容起点读到闭合反引号；${} 里的源码拼进 inner，交给外层再扫。
 * 表达式前后各留一个空格：`${prefix}${execFileSync(...)}` 不能粘成 `prefixexecFileSync`，否则词边界扫不到。
 */
function readTemplate(code: string, i: number): { inner: string; end: number } {
  let inner = '';
  while (i < code.length) {
    const c = code[i] ?? '';
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return { inner, end: i + 1 };
    if (c === '$' && code[i + 1] === '{') {
      const expr = readBalanced(code, i + 1);
      inner += ` ${expr.body} `;
      i = expr.end;
      continue;
    }
    i++;
  }
  return { inner, end: i };
}

function readBalanced(code: string, open: number): { body: string; end: number } {
  let depth = 0;
  let i = open;
  const start = open + 1;
  while (i < code.length) {
    const c = code[i] ?? '';
    if (c === "'" || c === '"') {
      i = endOfQuote(code, i + 1, c);
      continue;
    }
    if (c === '`') {
      i = readTemplate(code, i + 1).end;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      i = nl === -1 ? code.length : nl;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: code.slice(start, i), end: i + 1 };
    }
    i++;
  }
  return { body: code.slice(start), end: i };
}

/**
 * 扫同步起子进程的调用：先去掉注释和引号里的字符串，再找 spawnSync / execFileSync / execSync。
 * 传入源码时返回命中的调用名；不传时扫本包 test/ 顶层的 .ts（豁免 child.ts 和 static.test.ts 自己），返回命中的文件名。
 */
function scanSyncChildSpawns(code: string): string[];
function scanSyncChildSpawns(): string[];
function scanSyncChildSpawns(code?: string): string[] {
  const banned = /\b(spawnSync|execFileSync|execSync)\b/;
  const callsIn = (text: string): string[] => {
    const found = stripCommentsAndStrings(text).match(banned);
    return found?.[0] === undefined ? [] : [found[0]];
  };
  if (code !== undefined) return callsIn(code);
  return readdirSync(TEST)
    .filter((name) => name.endsWith('.ts') && name !== 'child.ts' && name !== 'static.test.ts')
    .filter((name) => callsIn(readFileSync(join(TEST, name), 'utf8')).length > 0);
}

/** 拼出 `${name}`，避免测试源码里的 ${} 被当成自己的插值。 */
function slot(name: string): string {
  return '$' + '{' + name + '}';
}

/** 验收样本：`const s = \`${prefix}${…}\`;`。 */
function gluedTemplate(expr: string): string {
  return 'const s = `' + slot('prefix') + slot(expr) + '`;';
}

describe('测试里不许同步起子进程', () => {
  it('spawnSync / execFileSync / execSync 只许在 child.ts', () => {
    expect(scanSyncChildSpawns()).toEqual([]);
  });

  it('故意放一行违规的样本，扫得出来', () => {
    // 扫的是这行代码本身，用普通字符串传进去。
    const sample = "execFileSync('git', []);";
    expect(scanSyncChildSpawns(sample)).not.toEqual([]);
  });

  it('模板插值紧挨着前缀时，仍然命中 execFileSync', () => {
    expect(scanSyncChildSpawns(gluedTemplate("execFileSync('git', [])"))).toEqual(['execFileSync']);
  });

  it('模板插值紧挨着前缀时，仍然命中 spawnSync', () => {
    expect(scanSyncChildSpawns(gluedTemplate("spawnSync('git', [])"))).toEqual(['spawnSync']);
  });

  it('模板插值紧挨着前缀时，仍然命中 execSync', () => {
    expect(scanSyncChildSpawns(gluedTemplate("execSync('git', [])"))).toEqual(['execSync']);
  });

  it('模板里只有普通文字和不含这三个词的插值时，不误报', () => {
    const sample = 'const s = `普通文字 ' + slot('prefix') + slot('name') + '`;';
    expect(scanSyncChildSpawns(sample)).toEqual([]);
  });
});

/** 会提前返回、把其余还在跑的 Promise 丢下的组合子。allSettled 等全部落定，不在内。 */
const EARLY_RETURN = /\bPromise\s*\.\s*(?:all|race|any)\b/g;

const EARLY_RETURN_HINT =
  'Promise.all / race / any 并行库查询会在一条失败（或先落定）时提前返回，其余查询还占着连接和锁（#2181、#2261）。' +
  "改用 src/queries/all-settled.ts 的 allSettledOrThrow（import { allSettledOrThrow } from './all-settled.ts'）。";

/** 一段源码里提前返回的组合子调用（去掉注释和字符串后）。 */
function earlyReturnCalls(code: string): string[] {
  return [...stripCommentsAndStrings(code).matchAll(EARLY_RETURN)].map((m) => m[0].replace(/\s+/g, ''));
}

/** 扫 src/ 下全部 .ts（含子目录），返回「相对路径：命中的写法」。 */
function scanSrcEarlyReturn(): string[] {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  if (files.length === 0) throw new Error(`没扫到 ${SRC} 下的 .ts，路径不对`);
  return files.flatMap((f) => {
    const calls = earlyReturnCalls(readFileSync(join(SRC, f), 'utf8'));
    return calls.length === 0 ? [] : [`${f.replaceAll('\\', '/')}：${calls.join('、')}`];
  });
}

describe('src 里并行查询不许提前返回', () => {
  it('src/ 下没有 Promise.all / race / any', () => {
    expect(scanSrcEarlyReturn(), EARLY_RETURN_HINT).toEqual([]);
  });

  it('扫到的文件里有 queries/（路径对、真的在扫）', () => {
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).map((f) => f.replaceAll('\\', '/'));
    expect(files).toContain('queries/pool-runs.ts');
    expect(files).toContain('queries/all-settled.ts');
  });

  it('故意放几行违规的样本，扫得出来', () => {
    expect(earlyReturnCalls('const [a, b] = await Promise.all([db.select().from(t), q2]);')).toEqual([
      'Promise.all',
    ]);
    expect(earlyReturnCalls('const pending = [q1, q2];\nconst rows = await Promise.all(pending);')).toEqual([
      'Promise.all',
    ]);
    expect(earlyReturnCalls('await Promise.all(ids.map((id) => readRow(db, id)));')).toEqual(['Promise.all']);
    expect(earlyReturnCalls('const all = Promise.all.bind(Promise);')).toEqual(['Promise.all']);
    expect(earlyReturnCalls('await Promise\n  .race([q1, timeout]);')).toEqual(['Promise.race']);
    expect(earlyReturnCalls('await Promise.any([q1, q2]);')).toEqual(['Promise.any']);
    expect(earlyReturnCalls('const s = `' + slot('await Promise.all([q])') + '`;')).toEqual(['Promise.all']);
  });

  it('allSettled、注释和字符串里提到的不算', () => {
    expect(earlyReturnCalls('const s = await Promise.allSettled([q1, q2]);')).toEqual([]);
    expect(earlyReturnCalls('// 以前用 Promise.all：一条失败就立刻返回')).toEqual([]);
    expect(earlyReturnCalls('/** 和 Promise.race 的区别 */')).toEqual([]);
    expect(earlyReturnCalls("const msg = 'Promise.all 不许用';")).toEqual([]);
  });
});
