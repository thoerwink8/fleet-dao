// web-api.ts 只是入口（#901 ③）：只许有 `export * from './web-api/xxx.ts'`，web-api/ 下每个文件都要被它导出（internal.ts 除外）。
// 起因：这份接口约定被前端、后端、飞书网关、法国的测试各按原路径 import；拆成 16 个文件之后，漏导出一个文件就是悄悄丢一批名字
// （只被 .mjs 或测试读到的名字，编译看不见），往入口里直接写定义则会让「入口 + 目录」两处各有一份。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
/** 只在目录内共用、不经入口导出的内部件（Id、Time、Cursor、Same）。 */
const INTERNAL = 'internal';

/** 返回每一处违规的说法；空数组 = 入口和目录对得上。 */
export function barrelProblems(barrelText: string, files: readonly string[]): string[] {
  const out: string[] = [];
  const exported: string[] = [];
  for (const raw of barrelText.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) continue;
    const m = /^export \* from '\.\/web-api\/([\w-]+)\.ts';$/.exec(line);
    if (m) exported.push(m[1] ?? '');
    else out.push(`入口里只许有 export * from './web-api/…'，却有：${line}`);
  }
  const names = files.map((f) => f.replace(/\.ts$/, ''));
  for (const n of names) {
    if (n === INTERNAL) {
      if (exported.includes(n)) out.push(`${INTERNAL}.ts 是目录内部件，不许经入口导出`);
    } else if (!exported.includes(n)) out.push(`web-api/${n}.ts 没被入口导出`);
  }
  for (const e of exported) if (!names.includes(e)) out.push(`入口导出了不存在的 web-api/${e}.ts`);
  return out;
}

describe('web-api.ts 入口和 web-api/ 目录', () => {
  it('入口只有重导出，目录里每个文件都被导出', () => {
    const files = readdirSync(`${SRC}web-api`).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10); // 不是空扫一遍就算过
    expect(barrelProblems(readFileSync(`${SRC}web-api.ts`, 'utf8'), files)).toEqual([]);
  });

  it('【故意造出的失败】漏导出一个文件、往入口写定义、导出内部件、导出不存在的文件，都认得出', () => {
    const files = ['a.ts', 'b.ts', 'internal.ts'];
    const ok = "export * from './web-api/a.ts';\nexport * from './web-api/b.ts';\n";
    expect(barrelProblems(ok, files)).toEqual([]);
    expect(barrelProblems("export * from './web-api/a.ts';\n", files)).toEqual(['web-api/b.ts 没被入口导出']);
    expect(barrelProblems(`${ok}export const X = 1;\n`, files)).toHaveLength(1);
    expect(barrelProblems(`${ok}export * from './web-api/internal.ts';\n`, files)).toEqual([
      'internal.ts 是目录内部件，不许经入口导出',
    ]);
    expect(barrelProblems(`${ok}export * from './web-api/gone.ts';\n`, files)).toEqual([
      '入口导出了不存在的 web-api/gone.ts',
    ]);
  });

  it('注释和空行不算违规', () => {
    expect(barrelProblems("// 说明\n\nexport * from './web-api/a.ts';\n", ['a.ts'])).toEqual([]);
  });
});
