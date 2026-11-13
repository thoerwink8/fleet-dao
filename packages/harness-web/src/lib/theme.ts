const KEY = 'fleet.next.theme';

export type Theme = 'light' | 'dark';

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    /* 读不到就跟系统 */
  }
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    return 'dark';
  return 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* 记不住就只管这一次 */
  }
}

/** 已经画在页面上的主题。按钮跟这个走，不另读一次 localStorage。 */
export function themeFromClass(isDark: boolean): Theme {
  return isDark ? 'dark' : 'light';
}

/**
 * 按钮写要点过去的主题。
 * 以前只写「浅色」「深色」，浅色页面上若状态还停在 dark，按钮就显示「浅色」，分不清是现在还是要切过去。
 */
export function themeToggleLabel(theme: Theme): string {
  return theme === 'dark' ? '切到浅色' : '切到深色';
}
