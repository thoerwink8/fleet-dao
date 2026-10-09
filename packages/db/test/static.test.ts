// 本包 test/ 顶层不许直接同步起子进程（#264 这一片）：spawnSync / execFileSync / execSync 只留在 child.ts。
// 注释和引号里的字是在提这个词，不是调用，去掉再扫。只扫顶层 .ts，子目录（fixtures/）本片不碰。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
