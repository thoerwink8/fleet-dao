// 外观偏好只剩「减少动效」一项（#3509）：主题只有一套，亮暗跟随系统，主题色、深浅、密度的切换都删了。
// 存在浏览器本地，切换即时生效。键名沿用原来的 theme：老存档里的 motion 照样认得，别的字段不再读。
import { brand } from '#brand';

export type MotionPref = 'system' | 'reduced';
export type ResolvedMode = 'light' | 'dark';

export interface ThemePref {
  motion: MotionPref;
}

export const THEME_KEY = `${brand.storagePrefix}theme`;

export const DEFAULT_THEME: ThemePref = { motion: 'system' };

export function parseThemePref(raw: string | null): ThemePref {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Record<keyof ThemePref, unknown>> | null) : null;
    return { motion: v && typeof v === 'object' && v.motion === 'reduced' ? 'reduced' : 'system' };
  } catch {
    return DEFAULT_THEME;
  }
}

export function readThemePref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(THEME_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(pref));
  } catch {
    // 隐私模式或存储被禁用：这次照样生效，只是下次不记得。
  }
}

/** 把偏好写到 <html data-motion>：app.css 按它停掉动效。 */
export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement) {
  if (pref.motion === 'reduced') root.dataset.motion = 'reduced';
  else delete root.dataset.motion;
}

/**
 * 页面第一次绘制前就挂上「减少动效」，免得先动一下再停。
 * 这段和 parseThemePref 是两份独立实现，theme.test.ts 核对两者结果一致。
 */
export const THEME_BOOT_SCRIPT = [
  '(function(){',
  'var d=document.documentElement;',
  `try{var v=JSON.parse(localStorage.getItem(${JSON.stringify(THEME_KEY)})||'null');`,
  "if(v&&typeof v==='object'&&v.motion==='reduced')d.dataset.motion='reduced';}catch(e){}",
  '})();',
].join('');
