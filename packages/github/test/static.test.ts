// 源码扫描：移植来的坑用代码扫一遍兜住。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

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
});
