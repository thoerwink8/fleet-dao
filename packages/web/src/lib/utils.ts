import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * 字号档位（app.css @theme 里的 --text-*，#182）。改这里之前必须知道：tailwind-merge 只认自带的字号（text-xs、text-sm……），
 * 不告诉它这些自定义档位，它会把 text-caption 当成文字颜色，和 text-ink-fail 这类颜色放进同一个 cn() 时把字号吞掉
 * （额度页用满时的大数字、带颜色的指标卡都因此丢过字号）。app.css 加减档位，这里跟着改（utils.test.ts 对着 app.css 钉住）。
 */
export const FONT_SIZE_TOKENS = [
  'micro',
  'caption',
  'sub',
  'label',
  'strong',
  'stat-num',
  'title',
  'stat',
] as const;

/** 聚焦圈宽（app.css 的 --ring-width-*）。不登记的话 cn() 不把它当宽度，后写的 ring-2 盖不住。 */
export const RING_WIDTH_TOKENS = ['focus'] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: [...FONT_SIZE_TOKENS] }],
      'ring-w': [{ ring: [...RING_WIDTH_TOKENS] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
