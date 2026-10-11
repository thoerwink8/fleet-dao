// 从种子算校准值，再拼成 CSS。scripts/gen-palettes.ts 写文件，theme/palettes.test.ts 在内存里重算一遍核对。
// 纯函数，不读文件、不读页面。算法和门槛的依据：WCAG 2.2 的 1.4.3（文字 4.5:1）、1.4.11（界面部件 3:1）。
import { contrast, hex, mixOklab, over, type Rgb } from '../lib/contrast.ts';
import type { PaletteSeed, Seeds } from './palettes.ts';

export const TONES = ['run', 'wait', 'human', 'stall', 'fail', 'done', 'stop'] as const;
export type Tone = (typeof TONES)[number];

/** WCAG 门槛：文字 4.5，界面部件（控件边框、聚焦圈）3。 */
export const TEXT_MIN = 4.5;
export const UI_MIN = 3;
/** 在门槛之上多留的对比度，免得算法和测试的小数误差踩线。 */
export const MARGIN = 0.1;
/** 状态色淡底最深用到多少：status.ts 的 toneSoft 是 12% 或 14%，run-timeline 的「在跑」是 15%。 */
export const TINT_MAX = 0.15;
/** bg-muted：前景色 5% 叠在卡片上。 */
export const MUTED = 0.05;

export interface Calibration {
  /** 七个状态墨色里状态色的份量（0–100 的整数，越小越往前景色靠）。 */
  ink: Record<Tone, number>;
  mutedInk: number;
  inputInk: number;
  ringInk: number;
  brandForeground: string;
  destructiveForeground: string;
}

/** 整数份量 0–100 里找最大的、仍满足 ok 的值（ok 随份量变大由真变假）。全都不满足就抛。 */
function largestPassing(ok: (p: number) => boolean, what: string): number {
  if (ok(100)) return 100;
  if (!ok(0)) throw new Error(`${what}：混到 0%（纯前景色）也过不了线，换种子`);
  let lo = 0; // 满足
  let hi = 100; // 不满足
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** 整数份量 0–100 里找最小的、仍满足 ok 的值（ok 随份量变大由假变真）。全都不满足就抛。 */
function smallestPassing(ok: (p: number) => boolean, what: string): number {
  if (!ok(100)) throw new Error(`${what}：用到 100% 也过不了线，换种子`);
  let lo = 0; // 不满足（0 份量等于没有）
  let hi = 100; // 满足
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** 按对比度高低在两个候选色里选一个：对比度取不同底色里的最差值。 */
function bestOf(candidates: [string, string], bgs: Rgb[]): string {
  const score = (c: string) => Math.min(...bgs.map((b) => contrast(hex(c), b)));
  return score(candidates[0]) >= score(candidates[1]) ? candidates[0] : candidates[1];
}

/** 一套主题的全部校准值。门槛都已含余量。 */
export function calibrate(s: Seeds, where: string): Calibration {
  const [fg, bg, surface, elev, panel, brand] = [s.fg, s.bg, s.surface, s.elev, s.panel, s.brand].map(
    hex,
  ) as Rgb[] as [Rgb, Rgb, Rgb, Rgb, Rgb, Rgb];
  const mutedBg = over(fg, MUTED, surface);

  // 按钮上的字只在本套主题自己的页面底和主要文字色里选，取对比度高的，不引入种子以外的颜色。
  const fgCandidates: [string, string] = [s.bg, s.fg];

  const ink = {} as Record<Tone, number>;
  for (const t of TONES) {
    const fill = hex(s[t]);
    const tinted = [surface, bg, elev, mutedBg].map((b) => over(fill, TINT_MAX, b));
    const backs = [surface, bg, elev, panel, mutedBg, ...tinted];
    ink[t] = largestPassing((p) => {
      const color = mixOklab(fill, fg, p / 100);
      if (Math.min(...backs.map((b) => contrast(color, b))) < TEXT_MIN + MARGIN) return false;
      // 失败色的墨色还要当危险按钮的底，按钮上的字（页面底或主要文字色）压在它上面也要 ≥ 4.5。
      if (t === 'fail')
        return Math.max(...fgCandidates.map((c) => contrast(hex(c), color))) >= TEXT_MIN + MARGIN;
      return true;
    }, `${where} 状态色 ${t} 的墨色`);
  }

  const mutedBacks = [bg, surface, elev, mixOklab(fg, surface, MUTED), panel];
  const mutedInk = smallestPassing(
    (p) => Math.min(...mutedBacks.map((b) => contrast(mixOklab(fg, bg, p / 100), b))) >= TEXT_MIN + MARGIN,
    `${where} 次要文字`,
  );
  const inputInk = smallestPassing(
    (p) => contrast(over(fg, p / 100, surface), surface) >= UI_MIN + MARGIN,
    `${where} 控件边框`,
  );
  const ringInk = smallestPassing(
    (p) => contrast(over(brand, p / 100, bg), bg) >= UI_MIN + MARGIN,
    `${where} 聚焦圈`,
  );

  const destructive = mixOklab(hex(s.fail), fg, ink.fail / 100);
  return {
    ink,
    mutedInk,
    inputInk,
    ringInk,
    brandForeground: bestOf(fgCandidates, [brand]),
    destructiveForeground: bestOf(fgCandidates, [destructive]),
  };
}

export const GENERATED_HEADER = `/*
 * 生成文件，别手改：改 palettes.ts 后跑 gen:palettes（pnpm --dir packages/web gen:palettes）。
 * 每套主题 = 13 个种子基色（原样来自 palettes.ts）+ 脚本按 WCAG 阈值算出的校准值：
 * --ink-*（状态墨色）、--muted-ink、--input-ink、--ring-ink、--brand-foreground、--destructive-foreground。
 * 每个份量取「刚好过线再加 ${MARGIN} 对比度余量」的最小混合比；theme/palettes.test.ts 核对本文件和重新生成的结果一致。
 */
`;

/** 一套主题的 CSS 块。 */
export function renderBlock(p: PaletteSeed): string {
  const s = p.seeds;
  const c = calibrate(s, `${p.id}/${p.mode}`);
  const lines = [
    `/* ${p.id} / ${p.mode} */`,
    `[data-palette="${p.id}"][data-mode="${p.mode}"] {`,
    `  --bg: ${s.bg};`,
    `  --panel: ${s.panel};`,
    `  --surface: ${s.surface};`,
    `  --elev: ${s.elev};`,
    `  --fg: ${s.fg};`,
    `  --brand: ${s.brand};`,
    `  --brand-foreground: ${c.brandForeground};`,
    ...TONES.map((t) => `  --st-${t}: ${s[t]};`),
    ...TONES.map((t) => `  --ink-${t}: ${c.ink[t]}%;`),
    `  --muted-ink: ${c.mutedInk}%;`,
    `  --input-ink: ${c.inputInk}%;`,
    `  --ring-ink: ${c.ringInk}%;`,
    `  --destructive-foreground: ${c.destructiveForeground};`,
    '}',
  ];
  return lines.join('\n');
}

/** 整个生成文件的内容（末尾带换行）。 */
export function renderPalettesCss(list: readonly PaletteSeed[]): string {
  return `${GENERATED_HEADER}\n${list.map(renderBlock).join('\n\n')}\n`;
}
