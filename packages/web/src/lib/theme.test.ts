// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';
import { parseThemePref, resolveMode, THEME_BOOT_SCRIPT, THEME_KEY } from './theme';

// 首屏脚本（THEME_BOOT_SCRIPT）和 parseThemePref/resolveMode 是两份独立实现：
// 这里用同一批输入跑两边，结果必须一致，否则页面会先闪一种颜色再跳成另一种。
function runBootScript(stored: string | null, systemDark: boolean) {
  const root = document.documentElement;
  delete root.dataset.palette;
  delete root.dataset.mode;
  delete root.dataset.motion;
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
  return { palette: root.dataset.palette, mode: root.dataset.mode, motion: root.dataset.motion ?? 'system' };
}

const SAMPLES: (string | null)[] = [
  null,
  '{"palette":"nord","mode":"light","motion":"system"}',
  '{"palette":"dracula","mode":"dark","motion":"reduced"}',
  '{"palette":"tokyo","mode":"system"}',
  '{"palette":"不存在的主题","mode":"dark"}',
  '{"mode":"sepia"}',
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
        });
      });
    }
  }
});
