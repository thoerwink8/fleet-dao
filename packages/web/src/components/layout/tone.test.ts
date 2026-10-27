import { describe, expect, test } from 'vitest';
import { iconOf, inkClass, LAYOUT_TONES, lineClass, softClass, solidClass } from './tone';

describe('tone 映射', () => {
  /** 完成态按决定 0121 第 2 条画中性灰，不走 st-done 绿。 */
  const NEUTRAL: Record<string, string> = {
    ink: 'text-ink-3',
    solid: 'bg-ink-3',
    soft: 'bg-fill-2',
    line: 'border-line-2',
  };
  test('八种状态每张表都齐，类名是完整的令牌名', () => {
    expect(LAYOUT_TONES).toHaveLength(8);
    for (const t of LAYOUT_TONES) {
      if (t === 'done') {
        expect(inkClass[t]).toBe(NEUTRAL.ink);
        expect(solidClass[t]).toBe(NEUTRAL.solid);
        expect(softClass[t]).toBe(NEUTRAL.soft);
        expect(lineClass[t]).toBe(NEUTRAL.line);
        expect(iconOf(t)).toBeTruthy();
        continue;
      }
      expect(inkClass[t]).toBe(`text-ink-${t}`);
      expect(solidClass[t]).toBe(`bg-st-${t}`);
      expect(softClass[t]).toBe(`bg-st-${t}-soft`);
      expect(lineClass[t]).toBe(`border-st-${t}-line`);
      expect(iconOf(t)).toBeTruthy();
    }
  });

  test('完成态一个绿类名都不出现（决定 0121 第 2 条）', () => {
    for (const cls of [inkClass.done, solidClass.done, softClass.done, lineClass.done]) {
      expect(cls).not.toMatch(/success|st-done/);
    }
  });
});
