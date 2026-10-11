// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';
import {
  applyTheme,
  DEFAULT_THEME,
  parseThemePref,
  resolveMode,
  THEME_BOOT_SCRIPT,
  THEME_KEY,
} from './theme';

// 首屏脚本（THEME_BOOT_SCRIPT）和 parseThemePref/resolveMode 是两份独立实现：
// 这里用同一批输入跑两边，结果必须一致，否则页面会先闪一种颜色再跳成另一种。
function runBootScript(stored: string | null, systemDark: boolean) {
  const root = document.documentElement;
  delete root.dataset.palette;
  delete root.dataset.mode;
  delete root.dataset.motion;
  delete root.dataset.density;
  if (stored === null) localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, stored);
  const original = window.matchMedia;
  window.matchMedia = ((q: string) =>
    ({ matches: systemDark && q.includes('dark') }) as MediaQueryList) as typeof window.matchMedia;
  try {
    new Function(THEME_BOOT_SCRIPT)();
  } finally {
    window.matchMedia = original;
  }
  return {
    palette: root.dataset.palette,
    mode: root.dataset.mode,
    motion: root.dataset.motion ?? 'system',
    density: root.dataset.density,
  };
}

const SAMPLES: (string | null)[] = [
  null,
  '{"palette":"nord","mode":"light","motion":"system"}',
  '{"palette":"dracula","mode":"dark","motion":"reduced"}',
  '{"palette":"tokyo","mode":"system"}',
  '{"palette":"不存在的主题","mode":"dark"}',
  '{"mode":"sepia"}',
  '{"palette":"nord","mode":"dark","density":"compact"}',
  '{"density":"cozy"}',
  '这不是 JSON',
];

afterEach(() => localStorage.clear());

describe('首屏主题脚本与主题解析逻辑一致', () => {
  for (const stored of SAMPLES) {
    for (const systemDark of [true, false]) {
      test(`存的是 ${stored ?? '（空）'}，系统${systemDark ? '深色' : '浅色'}`, () => {
        const pref = parseThemePref(stored);
        const got = runBootScript(stored, systemDark);
        expect(got).toEqual({
          palette: pref.palette,
          mode: resolveMode(pref.mode, systemDark),
          motion: pref.motion,
          density: pref.density,
        });
      });
    }
  }
});

describe('密度', () => {
  test('默认标准', () => {
    expect(DEFAULT_THEME.density).toBe('comfortable');
    expect(parseThemePref(null).density).toBe('comfortable');
    expect(parseThemePref('{}').density).toBe('comfortable');
  });
  test('认得 compact', () => {
    expect(parseThemePref('{"density":"compact"}').density).toBe('compact');
  });
  test('认不出的值回到 comfortable，不拿它当紧凑', () => {
    for (const bad of ['"cozy"', '"Compact"', '1', 'null', 'true', '{}']) {
      expect(parseThemePref(`{"density":${bad}}`).density).toBe('comfortable');
    }
  });
  test('老存档（没有 density 字段）读出来是标准，其余字段不丢', () => {
    const pref = parseThemePref('{"palette":"nord","mode":"dark","motion":"reduced"}');
    expect(pref).toEqual({ palette: 'nord', mode: 'dark', motion: 'reduced', density: 'comfortable' });
  });
  test('applyTheme 写到 <html data-density>，切回来也写', () => {
    const root = document.createElement('html');
    applyTheme({ ...DEFAULT_THEME, density: 'compact' }, false, root);
    expect(root.dataset.density).toBe('compact');
    applyTheme({ ...DEFAULT_THEME, density: 'comfortable' }, false, root);
    expect(root.dataset.density).toBe('comfortable');
  });
});
