// 本包的测试也扫：起子进程一律走 child.ts（#264），别处不许再抄 execFileSync 那套。
// 递归扫 test/ 下所有 .ts（含 e2e/）。只豁免 test/ 根上的 child.ts 和这份 static.test.ts；
// 子目录里同名文件照样扫，不按文件名跳过。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST = join(import.meta.dirname);

/** 去掉注释再判：注释里讲旧写法是说明，不是调用。命中就返回 true。 */
function hasSyncChildSpawn(code: string): boolean {
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  return /\bspawnSync\b|\bexecFileSync\b|\bexecSync\b/.test(stripped);
}

/** 相对 test/ 的路径正好是根上这两份才豁免。`e2e/child.ts` 这类不算。 */
function isExempt(file: string): boolean {
  const rel = relative(TEST, file);
  return rel === 'child.ts' || rel === 'static.test.ts';
}

/** test/ 下所有 .ts 的绝对路径。豁免只认 isExempt 里那两个相对路径。 */
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
  it('spawnSync / execFileSync / execSync 只许在 test/child.ts（#264）', () => {
    const files = testSources();
    // 一个都没扫到、或者没扫进 e2e/，不能当「没问题」
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => relative(TEST, file).startsWith(`e2e${sep}`))).toBe(true);
    expect(isExempt(join(TEST, 'child.ts'))).toBe(true);
    expect(isExempt(join(TEST, 'static.test.ts'))).toBe(true);
    expect(isExempt(join(TEST, 'e2e', 'child.ts'))).toBe(false);
    expect(isExempt(join(TEST, 'e2e', 'static.test.ts'))).toBe(false);
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
