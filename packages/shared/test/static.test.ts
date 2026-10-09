// 本包 test/ 不许直接同步起子进程（#264 这一片）：本包没有 child.ts，测试里也不许直接调。
// 递归扫 test/ 下所有 .ts。先去掉注释和引号里的字符串再找这三个名字：注释和引号里的字是在提这个词，不是调用。
// 只豁免 test/ 根上的这份 static.test.ts；子目录里同名文件照样扫，不按文件名跳过。
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
      // 留一个空格：`return/*注释*/execFileSync` 直接删掉会粘成 `returnexecFileSync`，\b 匹配不到。
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

/** 从模板内容起点读到闭合反引号；${} 里的源码拼进 inner，交给外层再扫。 */
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
      inner += expr.body;
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

/** 相对 test/ 的路径（统一用 /）。 */
function rel(file: string): string {
  return relative(TEST, file).split(sep).join('/');
}

/** 只有 test/ 根上的这份 static.test.ts 豁免。本包没有 child.ts，不另开豁免。 */
function isExempt(file: string): boolean {
  return rel(file) === 'static.test.ts';
}

/** test/ 下要扫的 .ts 绝对路径。豁免只认 isExempt 里那一个相对路径。 */
function testSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts') || isExempt(path)) continue;
      out.push(path);
    }
  };
  walk(TEST);
  return out;
}

describe('测试里不许同步起子进程', () => {
  it('本包 test/ 里不许直接 spawnSync / execFileSync / execSync', () => {
    const files = testSources();
    // 一个都没扫到不能当「没问题」：扫空也会得到空命中。
    expect(files.length).toBeGreaterThan(0);
    expect(files.map(rel)).toContain('util.test.ts');
    expect(isExempt(join(TEST, 'static.test.ts'))).toBe(true);
    expect(isExempt(join(TEST, 'child.ts'))).toBe(false);
    expect(isExempt(join(TEST, 'nested', 'static.test.ts'))).toBe(false);
    const hits = files
      .filter((file) => scanSyncChildSpawns(readFileSync(file, 'utf8')).length > 0)
      .map((file) => rel(file));
    expect(hits).toEqual([]);
  });

  it('故意放一行违规的样本，扫得出来', () => {
    expect(scanSyncChildSpawns(`execFileSync('git', []);`)).toEqual(['execFileSync']);
    // 块注释夹在词中间：去掉注释后仍是一次调用，不能因粘词漏掉。
    expect(scanSyncChildSpawns(`function f() { return/*注释*/execFileSync('git', []); }`)).toEqual([
      'execFileSync',
    ]);
    expect(scanSyncChildSpawns(`function f() { return/*注释*/spawnSync('git', []); }`)).toEqual([
      'spawnSync',
    ]);
    expect(scanSyncChildSpawns(`function f() { return/*注释*/execSync('git'); }`)).toEqual(['execSync']);
    expect(scanSyncChildSpawns(`const e = new Error('spawnSync git ENOENT'); // execSync`)).toEqual([]);
  });
});
