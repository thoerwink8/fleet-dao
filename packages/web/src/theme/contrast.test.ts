// app.css 的颜色闸（#3509，方案第三节第 6、7 条）：
// 1. 亮、暗两块令牌按 WCAG 2 相对亮度算 25 对「字色 × 底色」，都要 ≥4.5:1（和设计稿 canvas/check.mjs 同一张配对表）；
// 2. 令牌块以外不许写色值（#hex、rgb()、hsl()）；
// 3. 不许把填充色当字色（color: var(--brand|--success|--warn|--fail)），字色要用 --brand-ink、--success-ink 这类。
// 只读 app.css 的文字，不读页面算出来的值；页面上真实渲染的组合另由体检的 axe 兜底。
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { contrast, hex } from '../lib/contrast';

const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

const LIGHT_HEAD = '/* ---------- 令牌：亮色';
const DARK_HEAD = '/* ---------- 令牌：暗色';

/** 从 start 起找第一个 `{`，返回到配对的 `}` 为止的 [开头, 结尾)。 */
function braceBlock(src: string, start: number): [number, number] {
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return [start, i + 1];
  }
  throw new Error('令牌块的大括号没配上');
}

/** 两块令牌在 app.css 里的位置：亮色是注释后面的 :root {…}，暗色是注释后面的 @media (prefers-color-scheme: dark) {…}。 */
function tokenBlocks(src: string): { light: [number, number]; dark: [number, number] } {
  const l = src.indexOf(LIGHT_HEAD);
  const d = src.indexOf(DARK_HEAD);
  if (l < 0 || d < 0) throw new Error('app.css 里找不到亮色或暗色令牌块的标题注释');
  const lightAt = src.indexOf(':root', l);
  const darkAt = src.indexOf('@media (prefers-color-scheme: dark)', d);
  if (lightAt < 0 || darkAt < 0) throw new Error('令牌块不是 :root 和 @media (prefers-color-scheme: dark)');
  return { light: braceBlock(src, lightAt), dark: braceBlock(src, darkAt) };
}

/** 一块令牌里的「--名字: #rrggbb」。 */
function hexTokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]),
  );
}

/** 方案第三节第 6 条的 25 对（字色, 底色），和 canvas/check.mjs 的 PAIRS 同一张表。 */
const PAIRS: [string, string][] = [
  ...['ink', 'ink-2', 'ink-3'].flatMap((t) =>
    ['card', 'fill-1', 'fill-2', 'brand-1'].map((b): [string, string] => [t, b]),
  ),
  // 蓝字（链接、选中菜单、页签、分段、头像）一律用 --brand-ink；--brand 只给填充
  ...['card', 'fill-1', 'fill-2', 'brand-1'].map((b): [string, string] => ['brand-ink', b]),
  ['link-hover', 'card'],
  ['success-ink', 'success-1'],
  ['warn-ink', 'warn-1'],
  ['fail-ink', 'fail-1'],
  ['success-ink', 'card'],
  ['warn-ink', 'card'],
  ['fail-ink', 'card'],
  ['on-brand', 'brand'],
  ['on-brand', 'badge'],
];

/** 不够 4.5 的对，写成一句话。 */
function weakPairs(set: Record<string, string>, name: string): string[] {
  const out: string[] = [];
  for (const [fg, bg] of PAIRS) {
    const a = set[fg];
    const b = set[bg];
    if (!a || !b) {
      out.push(`${name}缺令牌 --${fg} 或 --${bg}`);
      continue;
    }
    const r = contrast(hex(a), hex(b));
    if (r < 4.5) out.push(`${name} --${fg} 放在 --${bg} 上对比度只有 ${r.toFixed(2)}（要 ≥4.5）`);
  }
  return out;
}

/** 去掉注释（注释里的「#3509」「#hex」不是色值），并把两块令牌换成空白（保留换行好报行号）。 */
function outsideTokens(src: string): string {
  const { light, dark } = tokenBlocks(src);
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let out = src.slice(0, light[0]) + blank(src.slice(light[0], light[1])) + src.slice(light[1]);
  out = out.slice(0, dark[0]) + blank(out.slice(dark[0], dark[1])) + out.slice(dark[1]);
  return out.replace(/\/\*[\s\S]*?\*\//g, (c) => blank(c));
}

/** 令牌块以外的色值，带行号。 */
function strayColors(src: string): string[] {
  const out: string[] = [];
  outsideTokens(src)
    .split('\n')
    .forEach((line, i) => {
      const m = line.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/);
      if (m) out.push(`app.css:${i + 1} 写死了色值 ${m[0]}（要用令牌）`);
    });
  return out;
}

/** 把填充色当字色用的声明，带行号。 */
function fillAsText(src: string): string[] {
  const out: string[] = [];
  src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n')
    .forEach((line, i) => {
      // 图标不是文字，按 3:1 的非文字对比算，放过（同 canvas/check.mjs）
      if (/\.icon\b/.test(line)) return;
      const m = line.match(
        /(?:^|[\s;{])color:\s*var\(--(brand|brand-hover|brand-active|success|warn|fail)\)/,
      );
      if (m)
        out.push(`app.css:${i + 1} 把填充色 --${m[1]} 当字色用了（要用 --brand-ink、--success-ink 这类）`);
    });
  return out;
}

const { light, dark } = tokenBlocks(css);
const lightSet = hexTokens(css.slice(...light));
// 暗色块没写的令牌（--badge）沿用亮色的值，和浏览器里 :root 的层叠一样。
const darkSet = { ...lightSet, ...hexTokens(css.slice(...dark)) };

describe('令牌两块：亮色 :root、暗色跟随系统', () => {
  test('两块都读得到，而且有契约里的颜色（读不到就红，不当成「没有问题」）', () => {
    const names = [
      'page',
      'card',
      'fill-1',
      'fill-2',
      'fill-3',
      'line',
      'line-2',
      'ink',
      'ink-2',
      'ink-3',
      'brand',
      'brand-hover',
      'brand-active',
      'brand-1',
      'brand-ink',
      'link-hover',
      'on-brand',
      'success',
      'success-1',
      'success-ink',
      'warn',
      'warn-1',
      'warn-ink',
      'fail',
      'fail-1',
      'fail-ink',
      'badge',
    ];
    for (const n of names) {
      expect(lightSet[n], `亮色 --${n}`).toBeDefined();
      expect(darkSet[n], `暗色 --${n}`).toBeDefined();
    }
    // 暗色块真的覆盖了底和字，不是空块
    expect(darkSet.page).not.toBe(lightSet.page);
    expect(darkSet.ink).not.toBe(lightSet.ink);
  });

  test('阴影和遮罩的 rgba 在令牌块里', () => {
    for (const [from, to] of [light, dark]) {
      const block = css.slice(from, to);
      for (const n of ['pop', 'pop-side', 'mask'])
        expect(block, `--${n}`).toMatch(new RegExp(`--${n}:[^;]*rgba\\(`));
    }
  });

  test('暗色跟随系统：@custom-variant dark 用 prefers-color-scheme，:root 写 color-scheme: light dark', () => {
    expect(css).toContain('@custom-variant dark (@media (prefers-color-scheme: dark));');
    expect(css.slice(...light)).toContain('color-scheme: light dark;');
    expect(css).not.toMatch(/data-mode|data-palette|data-density|data-theme-swap/);
  });
});

describe('对比度：25 对，亮暗都 ≥4.5:1（WCAG 2）', () => {
  test('配对表是 25 对', () => {
    expect(PAIRS).toHaveLength(25);
  });
  test('亮色', () => {
    expect(weakPairs(lightSet, '亮色')).toEqual([]);
  });
  test('暗色', () => {
    expect(weakPairs(darkSet, '暗色')).toEqual([]);
  });
  test('【故意造出的失败】暗色下拿 #165DFF 当蓝字放在卡片上，不够 4.5', () => {
    expect(weakPairs({ ...darkSet, 'brand-ink': '#165DFF' }, '暗色')).toEqual([
      expect.stringContaining('暗色 --brand-ink 放在 --card 上'),
      expect.stringContaining('--brand-ink 放在 --fill-1 上'),
      expect.stringContaining('--brand-ink 放在 --fill-2 上'),
      expect.stringContaining('--brand-ink 放在 --brand-1 上'),
    ]);
  });
  test('【故意造出的失败】缺令牌照实报，不当成过了', () => {
    const { badge: _drop, ...rest } = lightSet;
    expect(weakPairs(rest, '亮色')).toEqual(['亮色缺令牌 --on-brand 或 --badge']);
  });
});

describe('app.css 闸：令牌块以外没有色值，填充色不当字色', () => {
  test('令牌块以外没有 #hex、rgb()、hsl()', () => {
    expect(strayColors(css)).toEqual([]);
  });
  test('没有 color: var(--brand|--success|--warn|--fail)', () => {
    expect(fillAsText(css)).toEqual([]);
  });
  test('【故意造出的失败】令牌块外写一个 #86909C、一个 rgba()，都报出来；注释里的 #3509 不算', () => {
    const bad = `${css}\n/* #3509 */\n.x { color: #86909C; }\n.y { box-shadow: 0 0 1px rgba(0,0,0,.1); }\n`;
    const hits = strayColors(bad);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toContain('#86909C');
    expect(hits[1]).toContain('rgba(');
  });
  test('【故意造出的失败】color: var(--brand) 报出来，color: var(--brand-ink) 和图标放过', () => {
    const sample =
      '.a { color: var(--brand); }\n.b { color: var(--brand-ink); }\n.icon { color: var(--warn); }';
    expect(fillAsText(sample)).toEqual([expect.stringContaining('app.css:1 把填充色 --brand')]);
  });
});
