// 本包的测试也扫：起子进程一律走 child.ts（#264 第六片），别处不许再抄 execFileSync 那套。
// 递归扫 test/ 下所有 .ts（含 real/）。child.ts 自己就是起子进程的那层，static.test.ts 里是这条规则本身：都豁免。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST = join(import.meta.dirname);

const EXEMPT = new Set(['child.ts', 'static.test.ts']);

/** 去掉注释再判：注释里讲旧写法是说明，不是调用。命中就返回 true。 */
function hasSyncChildSpawn(code: string): boolean {
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  return /\bspawnSync\b|\bexecFileSync\b|\bexecSync\b/.test(stripped);
}

/** test/ 下所有 .ts 的绝对路径，按文件名豁免 child.ts 和 static.test.ts。 */
function testSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts') || EXEMPT.has(entry.name)) continue;
      out.push(path);
    }
  };
  walk(TEST);
  return out;
}

describe('测试里不许同步起子进程', () => {
  it('spawnSync / execFileSync / execSync 只许在 child.ts（#264 第六片）', () => {
    const files = testSources();
    // 一个都没扫到、或者没扫进 real/，不能当「没问题」
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => relative(TEST, file).startsWith(`real${sep}`))).toBe(true);
    const hits = files
      .filter((file) => hasSyncChildSpawn(readFileSync(file, 'utf8')))
      .map((file) => relative(TEST, file));
    expect(hits).toEqual([]);
  });

  it('故意造出的违规样本', () => {
    const sample = "execFileSync('git', []);";
    expect(hasSyncChildSpawn(sample)).toBe(true);
  });
});
