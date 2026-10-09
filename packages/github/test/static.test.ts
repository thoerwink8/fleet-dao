// 源码扫描：移植来的坑用代码扫一遍兜住。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');
// 本包的测试也扫：起子进程一律走 child.ts（#264 第一片），别处不许再抄 execFileSync 那套
const TEST = join(import.meta.dirname);

function sources(): { file: string; code: string }[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .map((file) => ({
      file,
      // 去掉注释再扫：注释里讲「旧代码写死 master」是说明，不是代码
      code: readFileSync(join(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1'),
    }));
}

// child.ts 自己就是起子进程的那层，static.test.ts 里是这条规则本身：都豁免
function testSources(): { file: string; code: string }[] {
  return readdirSync(TEST)
    .filter((f) => f.endsWith('.ts') && f !== 'child.ts' && f !== 'static.test.ts')
    .map((file) => ({
      file,
      code: readFileSync(join(TEST, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1'),
    }));
}

describe('源码扫描', () => {
  it('扫得到文件（没扫到不能当「没问题」）', () => {
    expect(sources().length).toBeGreaterThan(10);
  });

  it('G1：不许出现字面量 master（分支一律读仓库的 default_branch）', () => {
    const hits = sources().flatMap(({ file, code }) =>
      code
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /\bmaster\b/i.test(line))
        .map(({ i }) => `${file}:${i + 1}`),
    );
    expect(hits).toEqual([]);
  });

  it('故意放一行违规样本，扫得出来', () => {
    const sample = "const branch = 'master';";
    expect(/\bmaster\b/i.test(sample.replace(/(^|[^:'"`])\/\/.*$/gm, '$1'))).toBe(true);
  });

  it('不走 gh 命令行：源码里不许起 gh 子进程', () => {
    const hits = sources().filter(({ code }) => /execFile\(\s*['"]gh['"]|spawn\(\s*['"]gh['"]/.test(code));
    expect(hits.map((h) => h.file)).toEqual([]);
  });

  it('测试里不许同步起子进程：spawnSync / execFileSync / execSync 只许在 child.ts（#264 第一片）', () => {
    const hits = testSources().filter(({ code }) => /\bspawnSync\b|\bexecFileSync\b|\bexecSync\b/.test(code));
    expect(hits.map((h) => h.file)).toEqual([]);
  });

  it('故意放一行同步起子进程的样本，扫得出来', () => {
    const sample = "execFileSync('git', []);";
    expect(/\bspawnSync\b|\bexecFileSync\b|\bexecSync\b/.test(sample)).toBe(true);
  });
});
