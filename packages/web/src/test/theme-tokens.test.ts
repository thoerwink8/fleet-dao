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

describe('自定义尺寸 token 放对命名空间', () => {
  const tokens = themeSizeTokens(readFileSync(join(srcDir, 'app.css'), 'utf8'));

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

describe('组件令牌和密度（规范 2.7）', () => {
  const css = readFileSync(join(srcDir, 'app.css'), 'utf8');
  const tokens = themeSizeTokens(css);
  const VARS = ['control-h', 'row-h', 'section-p', 'section-gap', 'stack-gap'] as const;

  /** 取一个选择器块里「--变量: 值」的字典。 */
  function block(selector: string): Record<string, string | undefined> {
    const at = css.indexOf(selector);
    expect(at, `app.css 里没有 ${selector}`).toBeGreaterThan(-1);
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    return Object.fromEntries([...body.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
  }

  test('五个令牌类认得：落在 --spacing-* 下', () => {
    for (const name of ['control', 'row', 'section', 'section-gap', 'stack']) {
      expect(tokens.get(name), name).toEqual(new Set(['spacing']));
    }
  });
  test('标准 32/40/16/24/12，紧凑 28/32/12/16/8，紧凑只在桌面（48rem）起生效', () => {
    const std = block(':root,\n[data-density="comfortable"]');
    const compact = block('[data-density="compact"]');
    expect(VARS.map((v) => std[v])).toEqual(['32px', '40px', '16px', '24px', '12px']);
    expect(VARS.map((v) => compact[v])).toEqual(['28px', '32px', '12px', '16px', '8px']);
    expect(css).toMatch(/@media \(width >= 48rem\) \{\s*\[data-density="compact"\]/);
  });
  test('紧凑不改字号', () => {
    expect(Object.keys(block('[data-density="compact"]')).filter((k) => k.startsWith('text'))).toEqual([]);
  });
});

describe('字号两组值：桌面苹果档、手机 14 起（#1882）', () => {
  const css = readFileSync(join(srcDir, 'app.css'), 'utf8');
  const NAMES = ['meta', 'body', 'heading', 'title'] as const;

  /** 取 :root 块里「--fs-xxx: 值」；desktop 取 @media (width >= 48rem) 里的那一块。 */
  function fsTokens(desktop: boolean): Record<string, string | undefined> {
    const at = desktop
      ? css.indexOf('@media (width >= 48rem) {\n  :root')
      : css.indexOf('\n:root {\n  --fs-meta');
    expect(at, `app.css 里没有${desktop ? '桌面' : '手机'}字号块`).toBeGreaterThan(-1);
    const body = css.slice(css.indexOf('{', at + (desktop ? 30 : 0)) + 1, css.indexOf('}', at));
    return Object.fromEntries([...body.matchAll(/--fs-([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
  }
  const pick = (t: Record<string, string | undefined>) => NAMES.flatMap((n) => [t[n], t[`${n}-lh`]]);

  test('手机（<48rem）：辅助 12/16、正文 14/20、小标题 16/24、页标题 20/28', () => {
    expect(pick(fsTokens(false))).toEqual([
      '0.75rem',
      '1rem',
      '0.875rem',
      '1.25rem',
      '1rem',
      '1.5rem',
      '1.25rem',
      '1.75rem',
    ]);
  });
  test('桌面（≥48rem）：辅助 12/16、正文 13/18、小标题 15/20、页标题 22/28', () => {
    expect(pick(fsTokens(true))).toEqual([
      '0.75rem',
      '1rem',
      '0.8125rem',
      '1.125rem',
      '0.9375rem',
      '1.25rem',
      '1.375rem',
      '1.75rem',
    ]);
  });
  test('@theme 的 text-* 引用这些变量，display 和 canvas 不随宽度变', () => {
    for (const n of NAMES) {
      expect(css).toMatch(new RegExp(`--text-${n}:\\s*var\\(--fs-${n}\\);`));
      expect(css).toMatch(new RegExp(`--text-${n}--line-height:\\s*var\\(--fs-${n}-lh\\);`));
    }
    expect(css).toMatch(/--text-display:\s*1\.75rem;/);
    expect(css).toMatch(/--text-canvas:\s*0\.6875rem;/);
  });
});

describe('收口：@theme 关掉 Tailwind 默认的字号、圆角、阴影（#1855）', () => {
  const css = readFileSync(join(srcDir, 'app.css'), 'utf8');

  test('三行 initial 都在', () => {
    for (const line of ['--text-*: initial;', '--radius-*: initial;', '--shadow-*: initial;']) {
      expect(css, line).toContain(line);
    }
  });
  test('#182 的旧字号名和 shadow-card-edge 不再定义，新档位还在', () => {
    for (const old of ['micro', 'caption', 'sub', 'label', 'strong', 'stat-num', 'stat']) {
      expect(css, `--text-${old}`).not.toMatch(new RegExp(`--text-${old}\\s*:`));
    }
    expect(css).not.toMatch(/--shadow-card-edge\s*:/);
    for (const name of ['meta', 'body', 'heading', 'title', 'display', 'canvas']) {
      expect(css, `--text-${name}`).toMatch(new RegExp(`--text-${name}\\s*:`));
    }
  });
});
