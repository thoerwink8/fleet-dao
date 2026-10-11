// 设计规范检查（#1847，并入了 #182 / #1446 的 lint-arbitrary）。扫描脚本在 packages/web/scripts/lint-design.ts，
// 规则表在 docs/design/驾驶舱界面.md 第八节。本测试盯三块：
//   1) 每条规则 R0–R10：一条故意造红的写法要报出来，一条合规写法要放过；
//   2) 旧账清单的判法：不在清单的文件一条都不许有，清单里的条数只许减（减了要改清单）；
//   3) 整个 packages/web/src 对着 design-legacy.json 没有新违规。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  ALLOWLIST,
  check,
  checkLegacy,
  countHits,
  formatHit,
  type Hit,
  lex,
  RULE_IDS,
  type RuleId,
  scanSource,
  utilityOf,
} from '../../scripts/lint-design.ts';

const PAGE = 'src/routes/sample.tsx';

function rulesOf(source: string, file = PAGE): RuleId[] {
  return scanSource(source, file).map((h) => h.rule);
}
function classesOf(source: string, file = PAGE): string[] {
  return scanSource(source, file).map((h) => h.cls);
}

describe('每条规则：造红的报、合规的放', () => {
  test('R0 任意值：text-[13px]、2xl:max-w-[380px] 报', () => {
    expect(classesOf(`<div className="text-[13px] 2xl:max-w-[380px] grid-cols-[240px_1fr]" />`)).toEqual([
      'text-[13px]',
      '2xl:max-w-[380px]',
      'grid-cols-[240px_1fr]',
    ]);
  });
  test('R0 放行：引 CSS 变量的、data-[…] 变体', () => {
    expect(
      rulesOf(`<div className="shadow-[0_1px_0_var(--border)] data-[spacing=0]:rounded-none" />`),
    ).toEqual([]);
  });

  test('R1 颜色：默认色板、white、black、语义色上的透明度都报', () => {
    expect(rulesOf(`cn('bg-red-500 text-white bg-black/50 bg-st-fail/10 border-st-fail/[0.4]')`)).toEqual([
      'R1',
      'R1',
      'R1',
      'R1',
      'R1',
    ]);
  });
  test('R1 放行：语义色、状态淡底和描边令牌、ui/ 里的聚焦圈', () => {
    expect(
      rulesOf(`cn('bg-st-fail-soft border-st-fail-line text-ink-fail bg-scrim text-muted-foreground')`),
    ).toEqual([]);
    expect(rulesOf(`cn('focus-visible:ring-ring/50')`, 'src/components/ui/button.tsx')).toEqual([]);
    // 同一个聚焦圈写在页面里不放行
    expect(rulesOf(`cn('focus-visible:ring-ring/50')`)).toEqual(['R1']);
  });

  test('R2 字号：Tailwind 默认字号、#182 旧名、画布外的 text-canvas 报', () => {
    expect(rulesOf(`"text-xs text-sm text-caption text-stat-num text-2xl text-canvas"`)).toEqual([
      'R2',
      'R2',
      'R2',
      'R2',
      'R2',
      'R2',
    ]);
  });
  test('R2 放行：六档字号；text-canvas 在画布目录里', () => {
    expect(
      rulesOf(`"text-meta text-body text-heading text-title text-display text-left text-ink-run"`),
    ).toEqual([]);
    expect(rulesOf(`"text-canvas"`, 'src/components/home/board/nodes.tsx')).toEqual([]);
  });

  test('R3 字重：font-bold、font-light 报', () => {
    expect(rulesOf(`"font-bold md:font-light"`)).toEqual(['R3', 'R3']);
  });
  test('R3 放行：normal、medium、semibold、字体族', () => {
    expect(rulesOf(`"font-normal font-medium font-semibold font-mono"`)).toEqual([]);
  });

  test('R4 间距：p-3.5、gap-7、-mt-9 报', () => {
    expect(classesOf(`"p-3.5 gap-7 -mt-9 lg:pt-7"`)).toEqual(['p-3.5', 'gap-7', '-mt-9', 'lg:pt-7']);
  });
  test('R4 放行：档位里的、auto、专用名', () => {
    expect(rulesOf(`"p-0 px-4 py-2.5 gap-1.5 space-y-6 -mx-px m-auto pl-timeline-label"`)).toEqual([]);
  });

  test('R5 圆角：rounded、rounded-xl、rounded-2xl、rounded-2 报', () => {
    expect(classesOf(`"rounded rounded-xl rounded-t-2xl rounded-2"`)).toEqual([
      'rounded',
      'rounded-xl',
      'rounded-t-2xl',
      'rounded-2',
    ]);
  });
  test('R5 放行：sm、md、lg、full、none 和方向变体', () => {
    expect(rulesOf(`"rounded-sm rounded-md rounded-lg rounded-full rounded-none rounded-t-lg"`)).toEqual([]);
  });

  test('R6 阴影：shadow-sm、shadow-lg、旧名 shadow-card-edge 报', () => {
    expect(rulesOf(`"shadow-sm shadow-lg shadow-card-edge shadow"`)).toEqual(['R6', 'R6', 'R6', 'R6']);
  });
  test('R6 放行：xs、card、overlay、modal 和三个特效', () => {
    expect(
      rulesOf(`"shadow-xs shadow-card shadow-overlay shadow-modal shadow-row-selected shadow-none"`),
    ).toEqual([]);
  });

  test('R7 行高字距：leading-4、tracking-tight 报', () => {
    expect(rulesOf(`"leading-4 tracking-tight"`)).toEqual(['R7', 'R7']);
  });
  test('R7 放行：leading-none、tight、snug、normal、relaxed', () => {
    expect(rulesOf(`"leading-none leading-tight leading-snug leading-normal leading-relaxed"`)).toEqual([]);
  });

  test('R8 手写版式：页面里 border + bg-card、border-dashed + text-center 报', () => {
    expect(classesOf(`<section className="rounded-lg border bg-card" />`)).toEqual(['border + bg-card']);
    expect(classesOf(`<p className="border-dashed text-center" />`)).toEqual(['border-dashed + text-center']);
  });
  test('R8 放行：layout/、ui/ 里写；页面里只有其一', () => {
    expect(rulesOf(`"rounded-lg border bg-card"`, 'src/components/layout/section.tsx')).toEqual([]);
    expect(rulesOf(`"rounded-lg border bg-card"`, 'src/components/ui/card.tsx')).toEqual([]);
    expect(rulesOf(`"border bg-muted"`)).toEqual([]);
  });

  test('R9 原生控件：页面里 <select>、带图标的 <input> 报', () => {
    const src = [
      `import { Search } from 'lucide-react';`,
      '<select value={x}>',
      '<label>',
      '  <Search aria-hidden />',
      '  <input type="search" />',
      '</label>',
    ].join('\n');
    expect(scanSource(src, PAGE).map((h) => [h.rule, h.line])).toEqual([
      ['R9', 2],
      ['R9', 5],
    ]);
  });
  test('R9 放行：ui/ 里的 select；没有图标的 input；字符串里的 <select', () => {
    expect(rulesOf('<select value={x}>', 'src/components/ui/native-select.tsx')).toEqual([]);
    expect(rulesOf(`<input type="checkbox" />`)).toEqual([]);
    expect(rulesOf(`const s = '<select>';`)).toEqual([]);
  });

  test('R10 组件令牌：页面里 h-control、p-section、gap-stack、任意值里的 var(--spacing-row) 报', () => {
    expect(
      classesOf(
        `<div className="h-control p-section gap-stack md:gap-section-gap min-h-[var(--spacing-row)]" />`,
      ),
    ).toEqual(['h-control', 'p-section', 'gap-stack', 'md:gap-section-gap', 'min-h-[var(--spacing-row)]']);
    expect(rulesOf(`"h-row"`, 'src/components/home/board/card.tsx')).toEqual(['R10']);
  });
  test('R10 放行：layout/、ui/ 里写；flex-row、grid-flow-row 这类撞了名字的不算', () => {
    expect(rulesOf(`"h-control p-section gap-stack min-h-row"`, 'src/components/layout/section.tsx')).toEqual(
      [],
    );
    expect(rulesOf(`"h-control size-row"`, 'src/components/ui/button.tsx')).toEqual([]);
    expect(rulesOf(`"flex-row grid-flow-row h-8 gap-3"`)).toEqual([]);
  });
});

describe('词法和报错', () => {
  test('注释里的类名不算；模板串的静态段和插值里的字符串都算', () => {
    const src = [
      '// 原来是 text-xs',
      '/* rounded-xl */',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 样例本身就是一段带插值的源码
      'const a = `px-4 text-sm ${on ? "font-bold" : ""} rounded`;',
    ].join('\n');
    expect(classesOf(src)).toEqual(['text-sm', 'font-bold', 'rounded']);
  });
  test('JSX 正文里的撇号不当字符串开头', () => {
    const src = [`<p>it's fine</p>`, `<div className="text-xs" />`].join('\n');
    expect(scanSource(src, PAGE).map((h) => [h.cls, h.line])).toEqual([['text-xs', 2]]);
  });
  test('正则字面量里的引号不打乱字符串', () => {
    const src = `const re = /['"]/g; const c = "rounded-xl";`;
    expect(classesOf(src)).toEqual(['rounded-xl']);
    expect(lex(src).segments.map((s) => s.text)).toEqual(['rounded-xl']);
  });
  test('去变体：md:hover:、data-[state=open]:、!、负号', () => {
    expect(utilityOf('md:hover:bg-accent')).toBe('bg-accent');
    expect(utilityOf('data-[state=open]:text-xs')).toBe('text-xs');
    expect(utilityOf('!p-3.5')).toBe('p-3.5');
    expect(utilityOf('-mt-9')).toBe('mt-9');
  });
  test('报错写清文件、行、类名、换成什么、规范第几节', () => {
    const [hit] = scanSource('\n<div className="text-xs" />', PAGE);
    expect(hit).toBeDefined();
    const msg = formatHit(hit as Hit);
    expect(msg).toContain('src/routes/sample.tsx:2');
    expect(msg).toContain('text-xs');
    expect(msg).toContain('text-meta');
    expect(msg).toContain('docs/design/驾驶舱界面.md 第 6.2 节');
  });
  test('白名单每一项都写了理由', () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0);
    for (const a of ALLOWLIST) {
      expect(RULE_IDS).toContain(a.rule);
      expect(a.reason.trim().length).toBeGreaterThan(10);
    }
  });
});

describe('旧账清单：只减不加', () => {
  const hits = scanSource(`"text-xs text-sm rounded-xl"`, PAGE);
  const exists = () => true;

  test('条数和清单一样：通过', () => {
    expect(checkLegacy(hits, { [PAGE]: { R2: 2, R5: 1 } }, exists)).toEqual([]);
  });
  test('【故意造红】不在清单里的文件有一条就报', () => {
    expect(checkLegacy(hits, {}, exists)).toHaveLength(3);
  });
  test('【故意造红】条数涨了：报', () => {
    const errors = checkLegacy(hits, { [PAGE]: { R2: 1, R5: 1 } }, exists);
    expect(errors[0]).toContain('旧账冻结 1 条，现在 2 条');
  });
  test('【故意造红】条数降了没改清单：报，要求改小', () => {
    const errors = checkLegacy(hits, { [PAGE]: { R2: 3, R5: 1 } }, exists);
    expect(errors).toEqual([expect.stringContaining('改成 2')]);
  });
  test('【故意造红】文件干净了、文件没了、规则写错：都报', () => {
    expect(checkLegacy([], { [PAGE]: { R2: 2 } }, exists)).toEqual([expect.stringContaining('已经干净了')]);
    expect(checkLegacy([], { 'src/gone.tsx': { R2: 1 } }, () => false)).toEqual([
      expect.stringContaining('不存在了'),
    ]);
    expect(checkLegacy(hits, { [PAGE]: { R2: 2, R5: 1, R10: 1 } as never }, exists)).toEqual([
      expect.stringContaining('R10'),
    ]);
  });
  test('计数按文件、按规则', () => {
    expect(countHits(hits)).toEqual({ [PAGE]: { R2: 2, R5: 1 } });
  });
});

describe('令牌名不撞车', () => {
  test('app.css 里没有 --color-canvas：它会让 text-canvas 被当成文字颜色，字号类不生成（#1850）', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app.css'), 'utf8');
    expect(css).not.toMatch(/--color-canvas\s*:/);
    expect(css).toMatch(/--text-canvas\s*:/);
  });
});

describe('整个 packages/web/src', () => {
  test('对着 design-legacy.json 没有新违规（新文件一条都不许有）', () => {
    expect(check()).toEqual([]);
  });
});
