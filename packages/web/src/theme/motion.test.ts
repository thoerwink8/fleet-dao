// 动效档位只有一份数（#3509）：src/theme/motion.ts 和 app.css 的时长、缓动必须一样，改一边就红。
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DURATION_MS, DURATION_S, EASE_ARCO, EASE_ARCO_CSS } from './motion';

const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

/** 把 cubic-bezier(…) 里的四个数读出来。 */
function bezier(text: string): number[] {
  return (text.match(/cubic-bezier\(([^)]*)\)/)?.[1] ?? '').split(',').map((n) => Number(n.trim()));
}

describe('动效档位：motion.ts 和 app.css 同一组数', () => {
  test('三档时长 100 / 200 / 300，app.css 的 --transition-duration-* 一一对上', () => {
    expect(Object.values(DURATION_MS)).toEqual([100, 200, 300]);
    expect(Object.values(DURATION_S)).toEqual([0.1, 0.2, 0.3]);
    const defined = [...css.matchAll(/--transition-duration-(\d+):\s*(\d+)ms;/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(defined).toEqual(Object.values(DURATION_MS).map((v) => [v, v]));
    expect(css).toContain(`--default-transition-duration: ${DURATION_MS.fast}ms;`);
  });

  test('缓动 ease-arco 是 cubic-bezier(0.34, 0.69, 0.1, 1)，app.css 里每一条 cubic-bezier 都是它', () => {
    expect([...EASE_ARCO]).toEqual([0.34, 0.69, 0.1, 1]);
    expect(EASE_ARCO_CSS).toBe('cubic-bezier(0.34, 0.69, 0.1, 1)');
    const arco = css.match(/--ease-arco:\s*([^;]+);/)?.[1];
    expect(arco, 'app.css 里没有 --ease-arco').toBeDefined();
    expect(bezier(arco ?? '')).toEqual([...EASE_ARCO]);
    const all = [...css.matchAll(/cubic-bezier\([^)]*\)/g)].map((m) => bezier(m[0]));
    expect(all.length).toBeGreaterThan(1);
    for (const b of all) expect(b).toEqual([...EASE_ARCO]);
  });

  test('【故意造出的失败】写成别的缓动会被认出来', () => {
    expect(bezier('cubic-bezier(0.2, 0.8, 0.2, 1)')).not.toEqual([...EASE_ARCO]);
  });
});
