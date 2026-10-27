// 自定义尺寸 token 要放在 Tailwind v4 那个工具类认的命名空间下，不然类名静默不生效、不报错。
// 起因（驾驶舱改版 2026-10-07）：顶栏高、侧栏宽写成 --size-topbar / --size-sidebar，h-topbar、w-sidebar 整个没生效，
// 顶栏塌成 33px、侧栏按字宽缩到 170px，长期没人发现；max-h-command-list 这类放在 --container-* 下的也一样。
// 这里把 app.css 里 @theme 定义的名字和 src 下用到的类名对一遍：用到了自定义名、却不在那个工具认的命名空间里，就红。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Tailwind v4.3 各尺寸工具类认哪些命名空间（tailwindcss/dist/lib.js 里的 themeKeys）。 */
const UTILITY_NAMESPACES: Record<string, string[]> = {
  w: ['width', 'spacing', 'container'],
  'min-w': ['min-width', 'spacing', 'container'],
  'max-w': ['max-width', 'spacing', 'container'],
  h: ['height', 'spacing'],
  'min-h': ['min-height', 'height', 'spacing'],
  'max-h': ['max-height', 'height', 'spacing'],
  size: ['size', 'spacing'],
};
const SIZE_NAMESPACES = [
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'size',
  'spacing',
  'container',
];

/** @theme 里定义的尺寸类 token：名字 → 它在哪些命名空间下。 */
function themeSizeTokens(css: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = new RegExp(`--(${SIZE_NAMESPACES.join('|')})-([a-z][a-z0-9-]*)\\s*:`, 'g');
  for (const m of css.matchAll(re)) {
    const [, ns, name] = m as unknown as [string, string, string];
    if (!out.has(name)) out.set(name, new Set());
    out.get(name)?.add(ns);
  }
  return out;
}

/** 扫一段代码：用了自定义尺寸名、但那个工具类不认它所在的命名空间的类名。 */
function brokenSizeClasses(code: string, tokens: Map<string, Set<string>>): string[] {
  const broken: string[] = [];
  const re = /(?<![\w-])(min-w|max-w|min-h|max-h|w|h|size)-([a-z][a-z0-9-]*)(?![\w-])/g;
  for (const m of code.matchAll(re)) {
    const [cls, util, name] = m as unknown as [string, string, string];
    const where = tokens.get(name);
    if (!where) continue; // 不是自定义名（w-full、h-8 之类），不归这里管
    const accepted = UTILITY_NAMESPACES[util] ?? [];
    if (![...where].some((ns) => accepted.includes(ns))) broken.push(cls);
  }
  return broken;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) yield* sourceFiles(abs);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield abs;
  }
}

const css = readFileSync(join(srcDir, 'app.css'), 'utf8');

/** 「--名字: 值;」读成像素。尺寸一律写 px（#3697），不是 px 就是 NaN。 */
function tokenPx(name: string): number {
  const v = css.match(new RegExp(`--${name}:\\s*([\\d.]+)px;`))?.[1];
  return v === undefined ? Number.NaN : Number.parseFloat(v);
}

describe('自定义尺寸 token 放对命名空间', () => {
  const tokens = themeSizeTokens(css);

  test('app.css 里读得到自定义尺寸 token（读不到就红，不当成「没有问题」）', () => {
    expect(tokens.get('topbar')).toBeDefined();
    expect(tokens.get('sidebar')).toBeDefined();
    expect(tokens.get('cockpit')).toBeDefined();
  });

  test('src 下每个用到自定义尺寸名的类，都落在那个工具认的命名空间里', () => {
    const broken: string[] = [];
    for (const f of sourceFiles(srcDir)) {
      for (const cls of brokenSizeClasses(readFileSync(f, 'utf8'), tokens)) {
        broken.push(`${f.slice(srcDir.length + 1)}: ${cls}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test('【故意造出的失败】h-topbar 定义在 --size-* 下、max-h-list 定义在 --container-* 下：认出来是坏的', () => {
    const fake = themeSizeTokens('--size-topbar: 52px; --container-list: 300px; --spacing-ok: 4px;');
    expect(brokenSizeClasses('className="h-topbar max-h-list w-list h-ok size-topbar w-full"', fake)).toEqual(
      ['h-topbar', 'max-h-list'],
    );
  });
});

describe('组件令牌只有一套（Arco，#3509）', () => {
  const tokens = themeSizeTokens(css);

  test('六个令牌类落在 --spacing-* 下', () => {
    for (const name of ['control', 'row', 'row-tall', 'section', 'section-gap', 'stack']) {
      expect(tokens.get(name), name).toEqual(new Set(['spacing']));
    }
  });
  test('控件高 32、行高 40、两行的行 48、卡片内边距 20、区块间距 16、区块内间距 12，都写 px', () => {
    expect(
      ['control', 'row', 'row-tall', 'section', 'section-gap', 'stack'].map((n) => tokenPx(`spacing-${n}`)),
    ).toEqual([32, 40, 48, 20, 16, 12]);
  });
  test('密度切换删了：没有 data-density，也没有紧凑那一组', () => {
    expect(css).not.toMatch(/data-density|compact/);
  });
});

describe('字号五档加等宽 13（Arco，#3509）', () => {
  /** 一档字号读成「字号/行高（字重）」，像素。 */
  function step(n: string): string {
    const w = css.match(new RegExp(`--text-${n}--font-weight:\\s*(\\d+);`))?.[1];
    return `${tokenPx(`text-${n}`)}/${tokenPx(`text-${n}--line-height`)}${w ? ` ${w}` : ''}`;
  }
  test('meta 12/20、body 14/22、heading 16/24 500、title 20/28 600、display 24/32 600、mono 13/20、canvas 11/14', () => {
    expect(['meta', 'body', 'heading', 'title', 'display', 'mono', 'canvas'].map(step)).toEqual([
      '12/20',
      '14/22',
      '16/24 500',
      '20/28 600',
      '24/32 600',
      '13/20',
      '11/14',
    ]);
  });
  test('旧的 subtitle 并到 title，不再定义；手机桌面同一套，没有 --fs-* 覆盖', () => {
    expect(css).not.toMatch(/--text-subtitle\s*:/);
    expect(css).not.toMatch(/--fs-[a-z]/);
  });
});

describe('尺寸一律写 px，不跟根字号缩（#3697，替代 #3509 的 rem 写法）', () => {
  test('没有 --root-scale，html 不改字号', () => {
    expect(css).not.toMatch(/--root-scale/);
    expect(css).not.toMatch(/html\s*\{[^}]*font-size/);
  });
  test('顶栏 60、左菜单 220，都写 px', () => {
    expect(tokenPx('spacing-topbar')).toBe(60);
    expect(css).toMatch(/--spacing-sidebar:\s*220px;/);
    for (const name of ['spacing-sidebar-collapsed', 'spacing-drawer', 'container-cockpit']) {
      expect(css, name).toMatch(new RegExp(`--${name}:\\s*[\\d.]+px;`));
    }
  });
  test('圆角 2 / 4 / 8', () => {
    expect(['sm', 'md', 'lg'].map((n) => tokenPx(`radius-${n}`))).toEqual([2, 4, 8]);
  });
  test('app.css 里不再有写 rem 的值（注释里提到 rem 不算）', () => {
    const values = css
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/*'));
    expect(values.filter((line) => /[\d.]+rem\b/.test(line))).toEqual([]);
  });
});

describe('收口：@theme 关掉 Tailwind 默认的字号、圆角、阴影（#1855）', () => {
  test('三行 initial 都在', () => {
    for (const line of ['--text-*: initial;', '--radius-*: initial;', '--shadow-*: initial;']) {
      expect(css, line).toContain(line);
    }
  });
  test('#182 的旧字号名和 shadow-card-edge 不再定义，新档位还在', () => {
    for (const old of ['micro', 'caption', 'sub', 'label', 'strong', 'stat-num', 'stat', 'subtitle']) {
      expect(css, `--text-${old}`).not.toMatch(new RegExp(`--text-${old}\\s*:`));
    }
    expect(css).not.toMatch(/--shadow-card-edge\s*:/);
    for (const name of ['meta', 'body', 'heading', 'title', 'display', 'mono', 'canvas']) {
      expect(css, `--text-${name}`).toMatch(new RegExp(`--text-${name}\\s*:`));
    }
  });
  test('阴影：卡片无阴影，浮层和对话框用 --pop，抽屉用 --pop-side', () => {
    expect(css).toContain('--shadow-card: 0 0 transparent;');
    expect(css).toContain('--shadow-pop: var(--pop);');
    expect(css).toContain('--shadow-pop-side: var(--pop-side);');
    expect(css).toContain('--shadow-overlay: var(--pop);');
    expect(css).toContain('--shadow-modal: var(--pop);');
  });
});
