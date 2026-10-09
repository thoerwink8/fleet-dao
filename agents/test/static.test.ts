// 本目录 test/ 不许直接同步起子进程（#264 第 5 片）：spawnSync / execFileSync / execSync 只留在根上的 child.ts。
// 递归扫 test/ 下所有 .ts（含 rules/ 以外的子目录），去掉注释和引号里的字符串再找这三个名字：引号里的字
// （'spawnSync git ENOENT' 那种假错误）是在提这个词，不是调用。
// 只豁免 test/ 根上的 child.ts 和这份 static.test.ts；子目录里同名文件照样扫。
// rules/ 下四个文件（改标准路径）本片不迁：先用下面一份写死的已知名单豁免，迁完由下一片（#1474）删掉这份名单。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST = import.meta.dirname;

/** rules/ 下还没迁的四个文件（相对 test/ 的路径，用 / 写）。整份名单是临时的，#1474 迁完就删。 */
const KNOWN_UNMIGRATED_RULES = [
  'rules/foreground-wait.rules.test.ts',
  'rules/pretool.rules.test.ts',
  'rules/prompt-log.rules.test.ts',
  'rules/stop.rules.test.ts',
];

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

/** 只有 test/ 根上的这两份豁免；`x/child.ts` 这类不算。rules/ 的已知名单另算。 */
function isExempt(file: string): boolean {
  const r = rel(file);
  return r === 'child.ts' || r === 'static.test.ts' || KNOWN_UNMIGRATED_RULES.includes(r);
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
  it('spawnSync / execFileSync / execSync 只许在根上的 child.ts（#264 第 5 片）', () => {
    const files = testSources();
    // 一个都没扫到、或者没扫进 rules/，不能当「没问题」
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => rel(file).startsWith('rules/'))).toBe(true);
    expect(isExempt(join(TEST, 'child.ts'))).toBe(true);
    expect(isExempt(join(TEST, 'static.test.ts'))).toBe(true);
    expect(isExempt(join(TEST, 'rules', 'child.ts'))).toBe(false);
    expect(isExempt(join(TEST, 'rules', 'static.test.ts'))).toBe(false);
    const hits = files.filter(
      (file) => !isExempt(file) && scanSyncChildSpawns(readFileSync(file, 'utf8')).length > 0,
    );
    expect(hits.map(rel)).toEqual([]);
  });

  it('rules/ 的已知名单里每个文件都还在、还确实有直接调用（迁完了就该从名单里删）', () => {
    for (const name of KNOWN_UNMIGRATED_RULES) {
      const code = readFileSync(join(TEST, name), 'utf8');
      expect(scanSyncChildSpawns(code), name).not.toEqual([]);
    }
  });

  it('故意放一行违规的样本，扫得出来；引号和注释里提到的不算', () => {
    expect(scanSyncChildSpawns(`execFileSync('git', []);`)).toEqual(['execFileSync']);
    expect(scanSyncChildSpawns(`import { spawnSync } from 'node:child_process';`)).toEqual(['spawnSync']);
    expect(scanSyncChildSpawns(`const e = new Error('spawnSync git ENOENT'); // execSync`)).toEqual([]);
  });
});
