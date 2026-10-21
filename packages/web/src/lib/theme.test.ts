// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';
import { applyTheme, DEFAULT_THEME, parseThemePref, THEME_BOOT_SCRIPT, THEME_KEY } from './theme';

// 首屏脚本（THEME_BOOT_SCRIPT）和 parseThemePref 是两份独立实现：
// 这里用同一批输入跑两边，结果必须一致，否则「减少动效」会先动一下再停。
function runBootScript(stored: string | null) {
  const root = document.documentElement;
  delete root.dataset.motion;
  if (stored === null) localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, stored);
  new Function(THEME_BOOT_SCRIPT)();
  return root.dataset.motion ?? 'system';
}

const SAMPLES: (string | null)[] = [
  null,
  '{"motion":"system"}',
  '{"motion":"reduced"}',
  // 老存档：带着已删掉的主题色、深浅、密度字段，motion 照样认
  '{"palette":"dracula","mode":"dark","motion":"reduced","density":"compact"}',
  '{"palette":"nord","mode":"light"}',
  '{"motion":"Reduced"}',
  'null',
  '这不是 JSON',
];

afterEach(() => localStorage.clear());

describe('首屏脚本与偏好解析一致', () => {
  for (const stored of SAMPLES) {
    test(`存的是 ${stored ?? '（空）'}`, () => {
      expect(runBootScript(stored)).toBe(parseThemePref(stored).motion);
    });
  }
});

describe('减少动效', () => {
  test('默认跟系统', () => {
    expect(DEFAULT_THEME).toEqual({ motion: 'system' });
    expect(parseThemePref(null)).toEqual({ motion: 'system' });
  });
  test('老存档只留 motion，不再带主题色、深浅、密度', () => {
    expect(parseThemePref('{"palette":"nord","mode":"dark","motion":"reduced","density":"compact"}')).toEqual(
      {
        motion: 'reduced',
      },
    );
  });
  test('applyTheme 写 <html data-motion>，切回来就去掉', () => {
    const root = document.createElement('html');
    applyTheme({ motion: 'reduced' }, root);
    expect(root.dataset.motion).toBe('reduced');
    applyTheme({ motion: 'system' }, root);
    expect(root.dataset.motion).toBeUndefined();
  });
});
