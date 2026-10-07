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
