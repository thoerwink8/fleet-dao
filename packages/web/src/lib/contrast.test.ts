// 状态色当小字用时的对比度闸：每套主题 × 深浅 × 七个状态，墨色（app.css 的 --st-*-ink）
// 在页面上实际出现过的每种底上都要 ≥ 4.5:1（WCAG AA，11px 小字）：卡片、页面底、浮层、侧栏、muted，
// 以及叠在卡片、页面底、浮层、muted 上的同色淡底（状态标签 12–14%，时间线的「在跑」15%，按最深的 15% 算）。
// 复审实测漏过的两处——页面底上的「在干活」标签、时间线的「在跑」——都在这个范围里。
// 这里的颜色算法（oklab 混色、sRGB 叠色、相对亮度）是独立写的，不读页面算出来的值。
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { PALETTES } from './theme';

const TONES = ['run', 'wait', 'human', 'stall', 'fail', 'done', 'stop'] as const;
/** 状态色淡底最深用到多少：status.ts 的 toneSoft 是 12% 或 14%，run-timeline 的「在跑」是 15%。 */
const TINT_MAX = 0.15;
/** bg-muted：前景色 5% 叠在卡片上。 */
const MUTED = 0.05;

type Rgb = [number, number, number];

function hex(h: string): Rgb {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16) / 255) as Rgb;
}
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const delin = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(lin) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
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
function mixOklab(a: Rgb, b: Rgb, p: number): Rgb {
  const A = toOklab(a);
  const B = toOklab(b);
  return fromOklab(A.map((v, i) => v * p + (B[i] as number) * (1 - p)) as Rgb);
}
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((v, i) => v * alpha + (bg[i] as number) * (1 - alpha)) as Rgb;
}

interface Finding {
  where: string;
  ratio: number;
}

/** 读出 app.css 里每个「主题 × 深浅」块，算每个状态色墨色的最差对比度。 */
export function checkInkContrast(css: string): { blocks: string[]; findings: Finding[] } {
  const blocks: string[] = [];
  const findings: Finding[] = [];
  for (const [, palette, mode, body] of css.matchAll(
    /\[data-palette="(\w+)"\]\[data-mode="(\w+)"\]\s*\{([^}]*)\}/g,
  )) {
    const where = `${palette}/${mode}`;
    blocks.push(where);
    const colors = new Map(
      [...(body ?? '').matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], hex(m[2] ?? '')]),
    );
    const inks = new Map(
      [...(body ?? '').matchAll(/--ink-(\w+):\s*(\d+)%/g)].map((m) => [m[1], Number(m[2]) / 100]),
    );
    const need = (name: string): Rgb => {
      const c = colors.get(name);
      if (!c) throw new Error(`${where} 缺 --${name}`);
      return c;
    };
    const [fg, bg, surface, elev, panel] = [
      need('fg'),
      need('bg'),
      need('surface'),
      need('elev'),
      need('panel'),
    ];
    const muted = over(fg, MUTED, surface);
    for (const t of TONES) {
      const fill = need(`st-${t}`);
      const ink = mixOklab(fill, fg, inks.get(t) ?? 1);
      const tinted = [surface, bg, elev, muted].map((b) => over(fill, TINT_MAX, b));
      const worst = Math.min(...[surface, bg, elev, panel, muted, ...tinted].map((b) => contrast(ink, b)));
      findings.push({ where: `${where}/${t}`, ratio: Math.round(worst * 100) / 100 });
    }
  }
  return { blocks, findings };
}

const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

describe('状态色当小字用，对比度够 4.5:1', () => {
  test('八套主题 × 深浅都扫到了（扫到 0 套不算通过）', () => {
    const { blocks } = checkInkContrast(css);
    const expected = PALETTES.flatMap((p) => [`${p.id}/dark`, `${p.id}/light`]).sort();
    expect([...blocks].sort()).toEqual(expected);
  });

  test('每套主题每个状态的墨色在每种底上都 ≥ 4.5', () => {
    const bad = checkInkContrast(css).findings.filter((f) => f.ratio < 4.5);
    expect(bad).toEqual([]);
  });

  test('故意造一套不够的主题：闸要拦下来', () => {
    const sample = `[data-palette="x"][data-mode="light"] {
  --bg: #ffffff; --surface: #ffffff; --elev: #ffffff; --panel: #ffffff; --fg: #111111;
  --st-run: #1d6ff2; --st-wait: #6b7280; --st-human: #7c3aed; --st-stall: #f5d90a;
  --st-fail: #dc2f36; --st-done: #13925a; --st-stop: #d4d4d8;
  --ink-run: 80%; --ink-wait: 84%; --ink-human: 92%; --ink-fail: 80%; --ink-done: 74%;
}`;
    const bad = checkInkContrast(sample).findings.filter((f) => f.ratio < 4.5);
    expect(bad.map((f) => f.where)).toEqual(['x/light/stall', 'x/light/stop']);
  });
});
