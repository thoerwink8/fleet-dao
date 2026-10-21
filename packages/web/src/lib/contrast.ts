// 颜色算法：oklab 混色、sRGB 叠色、WCAG 相对亮度和对比度。
// 令牌的对比度测试（theme/contrast.test.ts）用它算 app.css 两块令牌。不读页面，纯函数。

export type Rgb = [number, number, number];

/** '#rrggbb' → 0–1 的 sRGB 三元组；格式不对就抛，不当成黑色。 */
export function hex(h: string): Rgb {
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) throw new Error(`颜色不是 #rrggbb：${h}`);
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16) / 255) as Rgb;
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const delin = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(lin) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 对比度（1–21）。 */
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

function toOklab(rgb: Rgb): Rgb {
  const [R, G, B] = rgb.map(lin) as Rgb;
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.min(1, Math.max(0, delin(c)))) as Rgb;
}

/** color-mix(in oklab, a p, b)，p 是 a 的份量（0–1）。 */
export function mixOklab(a: Rgb, b: Rgb, p: number): Rgb {
  const A = toOklab(a);
  const B = toOklab(b);
  return fromOklab(A.map((v, i) => v * p + (B[i] as number) * (1 - p)) as Rgb);
}

/** 前景色按 alpha 透明叠在底色上。 */
export function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((v, i) => v * alpha + (bg[i] as number) * (1 - alpha)) as Rgb;
}
