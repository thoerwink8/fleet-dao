// 本目录 test/ 不许直接同步起子进程（#264 第 5、6 片）：spawnSync / execFileSync / execSync 只留在根上的 child.ts。
// 递归扫 test/ 下所有 .ts（含 rules/ 等子目录），去掉注释和引号里的字符串再找这三个名字：引号里的字
// （'spawnSync git ENOENT' 那种假错误）是在提这个词，不是调用。
// 只豁免 test/ 根上的 child.ts 和这份 static.test.ts；子目录里同名文件照样扫。rules/ 没有另外的豁免（#1474 迁完删了）。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST = import.meta.dirname;

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
      out += ' ';
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

const BANNED = /\b(spawnSync|execFileSync|execSync)\b/;

/** 一段源码里命中的调用名（先去掉注释和引号字符串）。 */
function scanSyncChildSpawns(code: string): string[] {
  const found = stripCommentsAndStrings(code).match(BANNED);
  return found?.[0] === undefined ? [] : [found[0]];
}

/** 拼出 `${name}`，避免测试源码里的 ${} 被当成自己的插值。 */
function slot(name: string): string {
  return '$' + '{' + name + '}';
}

/** 验收样本：`const s = \`${prefix}${…}\`;`。 */
function gluedTemplate(expr: string): string {
  return 'const s = `' + slot('prefix') + slot(expr) + '`;';
}

/** 相对 test/ 的路径（统一用 /）。 */
function rel(file: string): string {
  return relative(TEST, file).split(sep).join('/');
}

/** 只有 test/ 根上的这两份豁免；`x/child.ts` 这类不算。 */
function isExempt(file: string): boolean {
  const r = rel(file);
  return r === 'child.ts' || r === 'static.test.ts';
}

/** test/ 下所有 .ts 的绝对路径（含被豁免的，豁免交给 isExempt 判）。 */
function testSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path);
    }
  };
  walk(TEST);
  return out;
}

describe('测试里不许同步起子进程', () => {
  it('spawnSync / execFileSync / execSync 只许在根上的 child.ts（#264 第 5、6 片，rules/ 也扫）', () => {
    const files = testSources();
    // 一个都没扫到、或者没扫进 rules/，不能当「没问题」
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => rel(file).startsWith('rules/'))).toBe(true);
    expect(isExempt(join(TEST, 'child.ts'))).toBe(true);
    expect(isExempt(join(TEST, 'static.test.ts'))).toBe(true);
    expect(isExempt(join(TEST, 'rules', 'child.ts'))).toBe(false);
    expect(isExempt(join(TEST, 'rules', 'static.test.ts'))).toBe(false);
    // rules/ 下的规矩测试一个都不豁免（#1474 前有份写死的名单，迁完删了）
    expect(isExempt(join(TEST, 'rules', 'stop.rules.test.ts'))).toBe(false);
    const hits = files.filter(
      (file) => !isExempt(file) && scanSyncChildSpawns(readFileSync(file, 'utf8')).length > 0,
    );
    expect(hits.map(rel)).toEqual([]);
  });

  it('故意放一行违规的样本，扫得出来；引号和注释里提到的不算', () => {
    expect(scanSyncChildSpawns(`execFileSync('git', []);`)).toEqual(['execFileSync']);
    expect(scanSyncChildSpawns(`import { spawnSync } from 'node:child_process';`)).toEqual(['spawnSync']);
    expect(scanSyncChildSpawns(`const e = new Error('spawnSync git ENOENT'); // execSync`)).toEqual([]);
  });

  it.each(['execFileSync', 'spawnSync', 'execSync'])('模板插值紧挨着前缀时，仍然命中 %s', (name) => {
    expect(scanSyncChildSpawns(gluedTemplate(`${name}('git', [])`))).toEqual([name]);
  });

  it('模板里只有普通文字和不含这三个词的插值时，不误报', () => {
    const sample = 'const s = `普通文字 ' + slot('prefix') + slot('name') + '`;';
    expect(scanSyncChildSpawns(sample)).toEqual([]);
  });

  it('标签模板里的插值同样扫得出来', () => {
    expect(scanSyncChildSpawns('const s = tag`x' + slot("execSync('git')") + '`;')).toEqual(['execSync']);
  });

  it('块注释夹在词中间，两边当成两个词，不粘成一个调用名', () => {
    expect(scanSyncChildSpawns('spawn/* x */Sync();')).toEqual([]);
    expect(scanSyncChildSpawns('/* x */execSync();')).toEqual(['execSync']);
    expect(scanSyncChildSpawns('const s = `' + slot('exec/* x */Sync()') + '`;')).toEqual([]);
  });
});
