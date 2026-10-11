import { describe, expect, test } from 'vitest';
import { iconOf, inkClass, LAYOUT_TONES, lineClass, softClass, solidClass } from './tone';

describe('tone 映射', () => {
  test('八种状态每张表都齐，类名是完整的令牌名', () => {
    expect(LAYOUT_TONES).toHaveLength(8);
    for (const t of LAYOUT_TONES) {
      expect(inkClass[t]).toBe(`text-ink-${t}`);
      expect(solidClass[t]).toBe(`bg-st-${t}`);
      expect(softClass[t]).toBe(`bg-st-${t}-soft`);
      expect(lineClass[t]).toBe(`border-st-${t}-line`);
      expect(iconOf(t)).toBeTruthy();
    }
  });
});
