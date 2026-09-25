// 主题 = 主题色 × 深浅 × 动效。存在浏览器本地，切换即时生效。
import { brand } from '#brand';

export type PaletteId =
  | 'graphite'
  | 'celadon'
  | 'nord'
  | 'tokyo'
  | 'dracula'
  | 'one'
  | 'solarized'
  | 'darcula';
export type ModePref = 'light' | 'dark' | 'system';
export type MotionPref = 'system' | 'reduced';
export type ResolvedMode = 'light' | 'dark';

export interface ThemePref {
  palette: PaletteId;
  mode: ModePref;
  motion: MotionPref;
}

export const THEME_KEY = `${brand.storagePrefix}theme`;

export const DEFAULT_THEME: ThemePref = { palette: 'graphite', mode: 'system', motion: 'system' };

export const PALETTES: { id: PaletteId; name: string; en: string; blurb: string }[] = [
  { id: 'graphite', name: '石墨', en: 'Graphite', blurb: '默认。框架只用黑白灰，颜色全部留给状态。' },
  { id: 'celadon', name: '青瓷', en: 'Celadon', blurb: '温润的青绿釉色，看久了不累。' },
  { id: 'nord', name: '北境', en: 'Nord', blurb: '极地的蓝灰与霜色，冷静克制。' },
  { id: 'tokyo', name: '东京夜', en: 'Tokyo Night', blurb: '霓虹夜色，蓝紫调子。' },
  { id: 'dracula', name: '德古拉', en: 'Dracula', blurb: '高饱和的紫与粉，经典暗色。' },
  { id: 'one', name: '原子', en: 'One', blurb: 'Atom 编辑器的经典配色。' },
  { id: 'solarized', name: '日晒', en: 'Solarized', blurb: '精确计算的低对比，护眼。' },
  { id: 'darcula', name: '炉火', en: 'Darcula', blurb: '炭灰底上的一点橙。' },
];

const PALETTE_IDS = PALETTES.map((p) => p.id);

export function parseThemePref(raw: string | null): ThemePref {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Record<keyof ThemePref, unknown>>) : {};
    return {
      palette: PALETTE_IDS.includes(v.palette as PaletteId)
        ? (v.palette as PaletteId)
        : DEFAULT_THEME.palette,
      mode: v.mode === 'light' || v.mode === 'dark' || v.mode === 'system' ? v.mode : DEFAULT_THEME.mode,
      motion: v.motion === 'reduced' ? 'reduced' : 'system',
    };
  } catch {
    return DEFAULT_THEME;
  }
}

export function resolveMode(mode: ModePref, systemDark: boolean): ResolvedMode {
  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
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

export function applyTheme(
  pref: ThemePref,
  systemDark: boolean,
  root: HTMLElement = document.documentElement,
) {
  const mode = resolveMode(pref.mode, systemDark);
  const same =
    root.dataset.palette === pref.palette &&
    root.dataset.mode === mode &&
    (root.dataset.motion === 'reduced') === (pref.motion === 'reduced');
  if (same) return;
  root.setAttribute('data-theme-swap', '');
  root.dataset.palette = pref.palette;
  root.dataset.mode = mode;
  if (pref.motion === 'reduced') root.dataset.motion = 'reduced';
  else delete root.dataset.motion;
  // 等新颜色画完再把过渡还回去。
  requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute('data-theme-swap')));
}

/**
 * 页面第一次绘制前就挂上主题，避免先闪一下默认色。
 * 这段和 parseThemePref / resolveMode 是两份独立实现，theme.test.ts 核对两者结果一致。
 */
export const THEME_BOOT_SCRIPT = [
  '(function(){',
  'var d=document.documentElement,p={};',
  // 存的不是 JSON（或读不了本地存储）时按默认值继续，而不是整段放弃——放弃就会先闪一帧默认深色。
  `try{var v=JSON.parse(localStorage.getItem(${JSON.stringify(THEME_KEY)})||'null');if(v&&typeof v==='object')p=v}catch(e){}`,
  'try{',
  `var ids=${JSON.stringify(PALETTE_IDS)};`,
  `d.dataset.palette=ids.indexOf(p.palette)>=0?p.palette:${JSON.stringify(DEFAULT_THEME.palette)};`,
  "d.dataset.mode=p.mode==='light'||p.mode==='dark'?p.mode:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');",
  "if(p.motion==='reduced')d.dataset.motion='reduced';",
  '}catch(e){}',
  '})();',
].join('');
