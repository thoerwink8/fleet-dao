// 对比度现算（陈列页 /_design 用）：把浏览器算好的颜色（getComputedStyle 的结果）换成 sRGB，按 WCAG 2.x 算两色的对比度。
// 认三种写法：rgb()/rgba()、color(srgb r g b / a)、#rrggbb。认不出的返回 undefined，调用方写「算不出」，不拿 0 或 1 冒充。

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function parseColor(input: string): Rgb | undefined {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{6})$/.exec(s);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: alpha(rgb[4]) };
  }
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (srgb) {
    return {
      r: clamp01(Number(srgb[1])) * 255,
      g: clamp01(Number(srgb[2])) * 255,
      b: clamp01(Number(srgb[3])) * 255,
      a: alpha(srgb[4]),
    };
  }
  return undefined;
}

function alpha(v: string | undefined): number {
  if (v === undefined) return 1;
  return v.endsWith('%') ? Number.parseFloat(v) / 100 : Number(v);
}

/** 把半透明的前景叠在不透明的底上。 */
export function over(fg: Rgb, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function lum({ r, g, b }: Rgb): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 对比度（1–21）。前景有透明度时先叠在底上。 */
export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const solid = fg.a < 1 ? over(fg, bg) : fg;
  const [hi, lo] = [lum(solid), lum(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
