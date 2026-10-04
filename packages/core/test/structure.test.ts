// core 只放纯判断：只许 import 同包的文件、@fleet-dao/shared 和 zod；碰网络、库、文件系统的一律不许进来
// （docs/decisions/0003-fusion-flow.md 第 12 条）。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));
const ALLOWED = [/^\.\/[a-z-]+\.ts$/, /^@fleet-dao\/shared$/, /^zod$/];

function specifiers(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+'([^']+)'/g))
    out.push(m[1] ?? '');
  for (const m of code.matchAll(/\bimport\s*\(\s*'([^']+)'\s*\)/g)) out.push(m[1] ?? '');
  for (const m of code.matchAll(/\brequire\s*\(\s*'([^']+)'\s*\)/g)) out.push(m[1] ?? '');
  return out;
}

describe('core 只放纯判断', () => {
  it('扫到了 src 下的文件（不是空扫一遍就算过）', () => {
    expect(files.sort()).toEqual([
      'alert-work.ts',
      'ask.ts',
      'brief.ts',
      'criteria.ts',
      'dispatch.ts',
      'index.ts',
      'names.ts',
      'verdict.ts',
    ]);
  });

  it.each(files)('%s 只引同包、shared 和 zod', (file) => {
    const bad = specifiers(readFileSync(`${DIR}${file}`, 'utf8')).filter(
      (s) => !ALLOWED.some((re) => re.test(s)),
    );
    expect(bad).toEqual([]);
  });

  it('【故意造出的失败】引了 node:fs 能被认出来', () => {
    const code = "import { readFileSync } from 'node:fs';\nexport const x = 1;";
    const bad = specifiers(code).filter((s) => !ALLOWED.some((re) => re.test(s)));
    expect(bad).toEqual(['node:fs']);
  });
});
