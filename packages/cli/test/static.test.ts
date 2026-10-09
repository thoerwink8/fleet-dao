// 本包 test/ 不许直接同步起子进程（#264 这一片）：本包没有 child.ts，spawnSync / execFileSync / execSync 不许出现。
// 递归扫 test/ 下所有 .ts。先去掉注释和引号里的字符串再按词找：引号里的字是在提这个词，不是调用。
// 反引号整段当字符串丢掉，不另扫 ${} 里的调用（和 adapters 现成扫描同一边界）。
// 只豁免 test/ 根上的这份 static.test.ts；子目录里同名文件照样扫，不按文件名跳过。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST = import.meta.dirname;

/** 去掉注释和引号里的字符串。反引号整段丢掉，不进入 ${}。 */
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
      i = endOfTemplate(code, i + 1);
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

/** 从模板内容起点读到闭合反引号。不拆 ${}，里面的调用留在字符串里。 */
function endOfTemplate(code: string, i: number): number {
  while (i < code.length) {
    const c = code[i] ?? '';
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return i + 1;
    i++;
  }
  return i;
}

const BANNED = /\b(spawnSync|execFileSync|execSync)\b/;

/**
 * 扫同步起子进程的调用：先去掉注释和引号里的字符串，再找 spawnSync / execFileSync / execSync。
 * 传入源码时返回命中的调用名；不传时递归扫本包 test/ 下的 .ts（只豁免根上的 static.test.ts），返回命中的相对路径。
 */
function scanSyncChildSpawns(code: string): string[];
function scanSyncChildSpawns(): string[];
function scanSyncChildSpawns(code?: string): string[] {
  const callsIn = (text: string): string[] => {
    const found = stripCommentsAndStrings(text).match(BANNED);
    return found?.[0] === undefined ? [] : [found[0]];
  };
  if (code !== undefined) return callsIn(code);
  return testSources()
    .filter((file) => callsIn(readFileSync(file, 'utf8')).length > 0)
    .map((file) => rel(file));
}

/** 相对 test/ 的路径（统一用 /）。 */
function rel(file: string): string {
  return relative(TEST, file).split(sep).join('/');
}

/** 只有 test/ 根上的 static.test.ts 豁免；本包没有 child.ts，子目录里的同名文件也不算。 */
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
  it('本包 test/ 里没有 spawnSync / execFileSync / execSync', () => {
    const files = testSources();
    // 一个都没扫到不能当「没问题」：扫空也会得到空命中。
    expect(files.length).toBeGreaterThan(0);
    expect(isExempt(join(TEST, 'static.test.ts'))).toBe(true);
    expect(isExempt(join(TEST, 'child.ts'))).toBe(false);
    expect(isExempt(join(TEST, 'nested', 'static.test.ts'))).toBe(false);
    expect(scanSyncChildSpawns()).toEqual([]);
  });

  it('故意放一行违规的样本，扫得出来', () => {
    expect(scanSyncChildSpawns("execFileSync('git', []);")).toEqual(['execFileSync']);
  });
});
