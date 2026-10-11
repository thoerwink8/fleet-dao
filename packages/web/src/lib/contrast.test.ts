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

/** 一套主题块里的 --xxx: NN% 读成 0–1；没写就抛（新加主题忘了校准，不当成没事）。 */
function percent(body: string, name: string, where: string): number {
  const m = body.match(new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)%`));
  if (!m) throw new Error(`${where} 缺 --${name}`);
  return Number(m[1]) / 100;
}

export type UiGroup = 'muted' | 'input' | 'ring' | 'destructive';
/** 三组闸的门槛：文字 4.5（WCAG 2.2 1.4.3），界面部件 3（1.4.11）。 */
export const UI_MIN: Record<UiGroup, number> = { muted: 4.5, input: 3, ring: 3, destructive: 4.5 };

/**
 * #1847 扩的三组，和 app.css 的派生公式一一对应：
 * - muted：次要文字 = color-mix(fg muted-ink, bg)，在页面底、卡片、浮层、muted、侧栏上取最差；
 * - input：控件边框 = fg 按 input-ink 透明叠在卡片上，对卡片；ring：聚焦圈 = brand 按 ring-ink 透明叠在页面底上，对页面底；
 * - destructive：危险按钮的字（--destructive-foreground）对危险按钮的底（状态红的墨色）。
 */
export function checkUiContrast(css: string): { where: string; group: UiGroup; ratio: number }[] {
  const out: { where: string; group: UiGroup; ratio: number }[] = [];
  for (const [, palette, mode, body = ''] of css.matchAll(
    /\[data-palette="(\w+)"\]\[data-mode="(\w+)"\]\s*\{([^}]*)\}/g,
  )) {
    const where = `${palette}/${mode}`;
    const colors = new Map(
      [...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], hex(m[2] ?? '')]),
    );
    const need = (name: string): Rgb => {
      const c = colors.get(name);
      if (!c) throw new Error(`${where} 缺 --${name}`);
      return c;
    };
    const [fg, bg, surface, elev, panel, brand] = ['fg', 'bg', 'surface', 'elev', 'panel', 'brand'].map(
      need,
    ) as Rgb[];
    const muted = mixOklab(fg as Rgb, surface as Rgb, MUTED);
    const mutedFg = mixOklab(fg as Rgb, bg as Rgb, percent(body, 'muted-ink', where));
    const round = (r: number) => Math.round(r * 100) / 100;
    out.push({
      where,
      group: 'muted',
      ratio: round(Math.min(...[bg, surface, elev, muted, panel].map((b) => contrast(mutedFg, b as Rgb)))),
    });
    const input = over(fg as Rgb, percent(body, 'input-ink', where), surface as Rgb);
    out.push({ where, group: 'input', ratio: round(contrast(input, surface as Rgb)) });
    const ring = over(brand as Rgb, percent(body, 'ring-ink', where), bg as Rgb);
    out.push({ where, group: 'ring', ratio: round(contrast(ring, bg as Rgb)) });
    const inkFail = body.match(/--ink-fail:\s*(\d+)%/);
    const destructive = mixOklab(need('st-fail'), fg as Rgb, inkFail ? Number(inkFail[1]) / 100 : 1);
    out.push({
      where,
      group: 'destructive',
      ratio: round(contrast(need('destructive-foreground'), destructive)),
    });
  }
  return out;
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

describe('次要文字、控件边框、聚焦圈、危险按钮的字（#1847）', () => {
  const all = checkUiContrast(css);
  const failing = (group: UiGroup, list = all) =>
    list.filter((f) => f.group === group && f.ratio < UI_MIN[group]).map((f) => `${f.where} ${f.ratio}`);

  test('16 套主题每组都算到了', () => {
    const expected = PALETTES.flatMap((p) => [`${p.id}/dark`, `${p.id}/light`]).sort();
    for (const group of Object.keys(UI_MIN) as UiGroup[]) {
      expect(
        all
          .filter((f) => f.group === group)
          .map((f) => f.where)
          .sort(),
        group,
      ).toEqual(expected);
    }
  });

  test('muted-foreground 在页面底、卡片、浮层、muted、侧栏上都 ≥ 4.5', () => {
    expect(failing('muted')).toEqual([]);
  });
  test('input 对卡片、ring 对页面底都 ≥ 3', () => {
    expect(failing('input')).toEqual([]);
    expect(failing('ring')).toEqual([]);
  });
  test('destructive-foreground 对 destructive ≥ 4.5', () => {
    expect(failing('destructive')).toEqual([]);
  });

  // 故意造一套不够的主题：每组闸都要拦下来。
  const weak = `[data-palette="x"][data-mode="light"] {
  --bg: #ffffff; --surface: #ffffff; --elev: #ffffff; --panel: #ffffff; --fg: #111111; --brand: #8fb8ff;
  --st-fail: #ff8a8a; --destructive-foreground: #ffffff;
  --muted-ink: 40%; --input-ink: 15%; --ring-ink: 55%;
}`;
  const sample = checkUiContrast(weak);

  test('【故意造红】次要文字只混 40%：拦', () => {
    expect(failing('muted', sample)).toHaveLength(1);
  });
  test('【故意造红】控件边框 15%、浅色品牌色的聚焦圈：拦', () => {
    expect(failing('input', sample)).toHaveLength(1);
    expect(failing('ring', sample)).toHaveLength(1);
  });
  test('【故意造红】浅红底上白字：拦', () => {
    expect(failing('destructive', sample)).toHaveLength(1);
  });
  test('【故意造红】主题块没给校准值：直接报错，不当成通过', () => {
    expect(() => checkUiContrast(weak.replace('--muted-ink: 40%;', ''))).toThrow('缺 --muted-ink');
  });
});
