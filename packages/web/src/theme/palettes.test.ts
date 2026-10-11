// 主题种子表 → 生成文件：重新生成的结果必须和提交的 palettes.generated.css 一字不差。
// 改了种子没跑 pnpm --dir packages/web gen:palettes，这里就红；手改生成文件也红。
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { contrast, hex } from '../lib/contrast.ts';
import { PALETTES } from '../lib/theme.ts';
import { calibrate, GENERATED_HEADER, renderPalettesCss } from './derive.ts';
import { PALETTE_SEEDS, type PaletteSeed } from './palettes.ts';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const committed = read('./palettes.generated.css');

describe('种子表', () => {
  test('8 套主题 × 深浅 = 16 条，和设置页的主题清单一一对应', () => {
    const expected = PALETTES.flatMap((p) => [`${p.id}/dark`, `${p.id}/light`]).sort();
    expect(PALETTE_SEEDS.map((p) => `${p.id}/${p.mode}`).sort()).toEqual(expected);
  });

  test('每条正好 13 个基色，全是 #rrggbb', () => {
    for (const p of PALETTE_SEEDS) {
      const values = Object.values(p.seeds);
      expect(values, `${p.id}/${p.mode}`).toHaveLength(13);
      for (const v of values) expect(v, `${p.id}/${p.mode}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test('种子表里没有任何百分比：份量全交给脚本算', () => {
    const code = read('./palettes.ts')
      .split('\n')
      .filter(
        (l) =>
          !l.trimStart().startsWith('//') &&
          !l.trimStart().startsWith('*') &&
          !l.trimStart().startsWith('/**'),
      )
      .join('\n');
    expect(code).not.toMatch(/\d\s*%/);
  });
});

describe('生成文件', () => {
  test('文件头写着「生成文件，别手改」', () => {
    expect(committed.startsWith(GENERATED_HEADER)).toBe(true);
    expect(committed).toContain('生成文件，别手改');
  });

  test('重新生成的结果和提交的文件一致', () => {
    // 红了就跑：pnpm --dir packages/web gen:palettes，再把生成文件一起提交。
    expect(renderPalettesCss(PALETTE_SEEDS)).toBe(committed);
  });

  test('【故意造红】改一个种子不重新生成：比对要红', () => {
    const [first, ...rest] = PALETTE_SEEDS as [PaletteSeed, ...PaletteSeed[]];
    const edited: PaletteSeed[] = [{ ...first, seeds: { ...first.seeds, brand: '#fedcba' } }, ...rest];
    expect(renderPalettesCss(edited)).not.toBe(committed);
  });

  test('【故意造红】手改生成文件里的一个份量：比对要红', () => {
    const handEdited = committed.replace('--muted-ink: ', '--muted-ink: 1');
    expect(handEdited).not.toBe(committed);
    expect(renderPalettesCss(PALETTE_SEEDS)).not.toBe(handEdited);
  });

  test('app.css 不再手写主题块，改为引入生成文件', () => {
    const css = read('../app.css');
    expect(css).toContain('@import "./theme/palettes.generated.css";');
    expect(css).not.toMatch(/\[data-palette="\w+"\]\[data-mode=/);
  });
});

describe('算法', () => {
  test('按钮上的字：品牌色按钮上 ≥ 3:1（这一项没有 WCAG 文字门槛，只防倒退）', () => {
    for (const p of PALETTE_SEEDS) {
      const c = calibrate(p.seeds, `${p.id}/${p.mode}`);
      expect(
        contrast(hex(c.brandForeground), hex(p.seeds.brand)),
        `${p.id}/${p.mode}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  test('【故意造红】前景色和底色一样：混到哪都过不了线，直接报错，不吐一个假的份量', () => {
    const base = PALETTE_SEEDS[0] as PaletteSeed;
    const flat = { ...base.seeds, fg: base.seeds.bg, surface: base.seeds.bg };
    expect(() => calibrate(flat, 'x/dark')).toThrow('过不了线');
  });
});
