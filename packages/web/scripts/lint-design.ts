// 驾驶舱设计规范检查（#1847，规范 docs/design/驾驶舱界面.md 第八节）。并入了原来的 lint-arbitrary（#182、#1446）。
// 扫 packages/web/src 下非测试的 .ts/.tsx：取出所有字符串字面量和模板串的静态段（className、cn()、cva、映射表都在里面），
// 按空白切成类名，去掉变体前缀（md:、hover:、data-[…]:）后逐条按 R0–R10 判；.css 只判 R0。
// 严格模式：整个 src 一条违规都不许有，没有旧账清单、没有例外名单（例外只在本文件的 allowed() 里，写明理由）。
// 用法（在 packages/web 下）：
//   node scripts/lint-design.ts                 严格检查，有一条违规就退出 1
//   node scripts/lint-design.ts --report        每条规则的总数和违规最多的前 20 个文件（PR 正文贴前后两次）
//   node scripts/lint-design.ts --list          列出每一处
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(pkgDir, 'src');
const DOC = 'docs/design/驾驶舱界面.md';

export type RuleId = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10';

/** 每条规则：名字和规范节号（报错里带上，照着去查）。 */
export const RULES: Record<RuleId, { name: string; section: string }> = {
  R0: { name: '任意值', section: '8.1 R0、6.3' },
  R1: { name: '颜色', section: '6.1' },
  R2: { name: '字号', section: '6.2' },
  R3: { name: '字重', section: '6.2' },
  R4: { name: '间距', section: '6.3' },
  R5: { name: '圆角', section: '6.4' },
  R6: { name: '阴影', section: '6.5' },
  R7: { name: '行高字距', section: '6.2' },
  R8: { name: '手写版式', section: '7' },
  R9: { name: '原生控件', section: '7' },
  R10: { name: '组件令牌', section: '2.7' },
};
export const RULE_IDS = Object.keys(RULES) as RuleId[];

export interface Hit {
  /** 相对 packages/web，正斜杠，例如 src/routes/tasks.tsx。 */
  file: string;
  line: number;
  rule: RuleId;
  /** 命中的类名（含变体前缀），R8 是那一对类名，R9 是标签，R10 是组件令牌类。 */
  cls: string;
  /** 该换成什么。 */
  fix: string;
}

export function formatHit(h: Hit): string {
  return `${h.file}:${h.line}  ${h.rule} ${RULES[h.rule].name}：${h.cls} → ${h.fix}（${DOC} 第 ${RULES[h.rule].section} 节）`;
}

// ---------- 从 app.css 读语义令牌：颜色名、间距专用名 ----------

const appCss = readFileSync(join(srcDir, 'app.css'), 'utf8');
/** @theme 里定义的颜色名（--color-xxx）加上 Tailwind 内置的三个关键字。 */
export const SEMANTIC_COLORS: ReadonlySet<string> = new Set([
  ...[...appCss.matchAll(/--color-([a-z][a-z0-9-]*):/g)].map((m) => m[1] as string),
  'transparent',
  'current',
  'inherit',
]);

// ---------- 白名单：每一项写理由 ----------

export interface AllowRule {
  rule: RuleId;
  /** 对类名（去掉变体前缀后）判。 */
  pattern: RegExp;
  /** 只在这些文件里放行；不写就是哪都放行。 */
  files?: RegExp;
  reason: string;
}

export const ALLOWLIST: readonly AllowRule[] = [
  {
    rule: 'R0',
    pattern: /var\(--/,
    reason: '括号里的数字只是坐标或运算，尺寸源头是 CSS 变量（令牌），例如 shadow-[0_1px_0_var(--border)]。',
  },
  {
    rule: 'R1',
    pattern: /^(?:ring|outline|border)-(?:ring|destructive)\/\d+$/,
    files: /^src\/components\/ui\//,
    reason: '基础件的聚焦圈：shadcn 的聚焦圈就是 ring 色或危险色叠一层透明度，只在 components/ui/ 里写一次。',
  },
  {
    rule: 'R1',
    pattern: /^bg-(?:primary|destructive|secondary|accent)\/\d+$/,
    files: /^src\/components\/ui\//,
    reason: '基础件的悬停、按下：按钮在自己的底色上加深或变浅一档，只在 components/ui/ 里写一次。',
  },
];

function allowed(rule: RuleId, util: string, file: string): boolean {
  return ALLOWLIST.some((a) => a.rule === rule && a.pattern.test(util) && (!a.files || a.files.test(file)));
}

// ---------- 词法：取出字符串和模板串的静态段，另给一份抹掉字符串和注释的代码 ----------

interface Segment {
  text: string;
  /** 在源文件里的起始下标。 */
  start: number;
}

const REGEX_BEFORE = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
]);
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'void',
  'delete',
  'throw',
  'yield',
  'await',
]);

/**
 * 一个够用的 TS/TSX 词法：认注释、单双引号字符串（必须在同一行闭合，JSX 正文里的撇号不当字符串）、
 * 模板串（${} 里递归）、正则字面量（按前一个记号猜）。
 */
export function lex(src: string): { segments: Segment[]; code: string } {
  const segments: Segment[] = [];
  const code = src.split('');
  const n = src.length;
  let prev = '';
  let word = '';
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (code[k] !== '\n') code[k] = ' ';
  };

  function template(i: number): number {
    // src[i] === '`'
    let j = i + 1;
    let segStart = j;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '`') {
        segments.push({ text: src.slice(segStart, j), start: segStart });
        blank(segStart - 1, j + 1);
        return j + 1;
      }
      if (ch === '$' && src[j + 1] === '{') {
        segments.push({ text: src.slice(segStart, j), start: segStart });
        blank(segStart - 1, j + 2);
        j = scanCode(j + 2, true);
        segStart = j;
        continue;
      }
      j++;
    }
    return n;
  }

  function scanCode(start: number, untilBrace: boolean): number {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = src[i] as string;
      const next = src[i + 1];
      if (c === '/' && next === '/') {
        const j = src.indexOf('\n', i);
        const end = j < 0 ? n : j;
        blank(i, end);
        i = end;
        continue;
      }
      if (c === '/' && next === '*') {
        const j = src.indexOf('*/', i + 2);
        const end = j < 0 ? n : j + 2;
        blank(i, end);
        i = end;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        if (src[j] === c) {
          segments.push({ text: src.slice(i + 1, j), start: i + 1 });
          blank(i, j + 1);
          i = j + 1;
          prev = 'str';
          word = '';
          continue;
        }
        // 同一行没闭合：JSX 正文里的撇号，不是字符串
        i++;
        continue;
      }
      if (c === '`') {
        i = template(i);
        prev = 'str';
        word = '';
        continue;
      }
      if (c === '/' && (prev === '' || REGEX_BEFORE.has(prev) || REGEX_AFTER_WORD.has(word))) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== '\n') {
          const ch = src[j];
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) break;
          j++;
        }
        if (src[j] === '/') {
          blank(i, j + 1);
          i = j + 1;
          while (i < n && /[a-z]/.test(src[i] as string)) i++;
          prev = 're';
          word = '';
          continue;
        }
      }
      if (c === '{') depth++;
      if (c === '}') {
        if (untilBrace && depth === 0) return i + 1;
        depth--;
      }
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (/[\w$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(src[j] as string)) j++;
        word = src.slice(i, j);
        prev = 'word';
        i = j;
        continue;
      }
      prev = c;
      word = '';
      i++;
    }
    return n;
  }

  scanCode(0, false);
  return { segments, code: code.join('') };
}

// ---------- 类名拆解 ----------

/** 去掉变体前缀（按不在方括号、圆括号里的冒号切），返回最后那段工具类，去掉 ! 和负号。 */
export function utilityOf(token: string): string {
  let depth = 0;
  let last = 0;
  for (let k = 0; k < token.length; k++) {
    const ch = token[k];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) last = k + 1;
  }
  return token
    .slice(last)
    .replace(/^!|!$/g, '')
    .replace(/^-(?=[a-z])/, '');
}

function splitModifier(value: string): [string, string | undefined] {
  const i = value.lastIndexOf('/');
  if (i < 0 || value.slice(0, i).includes('[')) return [value, undefined];
  return [value.slice(0, i), value.slice(i + 1)];
}

const PALETTE =
  /^(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)$/;
const COLOR_PREFIXES = [
  'ring-offset',
  'inset-shadow',
  'inset-ring',
  'placeholder',
  'decoration',
  'border-x',
  'border-y',
  'border-t',
  'border-r',
  'border-b',
  'border-l',
  'border-s',
  'border-e',
  'outline',
  'divide',
  'border',
  'accent',
  'shadow',
  'stroke',
  'caret',
  'text',
  'ring',
  'fill',
  'from',
  'via',
  'bg',
  'to',
];

const SIZE_FIX: Record<string, string> = {
  xs: 'text-meta',
  micro: 'text-meta',
  caption: 'text-meta',
  sm: 'text-body',
  sub: 'text-body',
  label: 'text-body',
  base: 'text-heading',
  strong: 'text-heading',
  'stat-num': 'text-heading',
  lg: 'text-heading',
  xl: 'text-title',
  stat: 'text-display',
};
const SPACING_OK = new Set([
  '0',
  'px',
  '0.5',
  '1',
  '1.5',
  '2',
  '2.5',
  '3',
  '4',
  '5',
  '6',
  '8',
  '10',
  '12',
  '16',
]);

/** 判一个类名（已去掉变体），返回 [规则, 该换成什么]；合规返回 undefined。R8、R9 不在这里。 */
/** 组件令牌（app.css「组件令牌」一节）：控件高、行高、区块内边距、区块间距、区块内间距。 */
const COMPONENT_TOKEN = 'control|row|section-gap|section|stack';
const COMPONENT_TOKEN_UTIL = new RegExp(
  `^(?:h|min-h|max-h|size|w|min-w|p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-(?:${COMPONENT_TOKEN})$`,
);
const COMPONENT_TOKEN_VAR = new RegExp(`var\\(--spacing-(?:${COMPONENT_TOKEN})\\)`);
/** 组件令牌只许版式组件和基础件用：页面要的尺寸由版式组件给，不自己量。 */
function componentTokenFile(file: string): boolean {
  return file.startsWith('src/components/layout/') || file.startsWith('src/components/ui/');
}

export function judgeUtility(util: string, file: string): [RuleId, string] | undefined {
  // R10 组件令牌：h-control、p-section 这类类名，和写进任意值里的 var(--spacing-control)
  if ((COMPONENT_TOKEN_UTIL.test(util) || COMPONENT_TOKEN_VAR.test(util)) && !componentTokenFile(file)) {
    return ['R10', '用版式组件（Section、List、Toolbar……）或基础件（Button、Input……），页面不自己写组件令牌'];
  }

  // R0 任意值
  // 颜色上的方括号透明度（bg-st-fail/[0.06]）归 R1，不算这里。
  const arb = util.match(/^[a-z][a-z0-9-]*-\[([^\]]*)\](?:\/.*)?$/);
  if (arb && /\d/.test(arb[1] ?? '')) {
    if (allowed('R0', util, file)) return undefined;
    return ['R0', '在 app.css 里加令牌（设计档位放第一个 @theme，某页专用尺寸放「版式常量」），用令牌类名'];
  }
  if (util.includes('[') && !/^[a-z][a-z0-9-]*\/\[[^\]]*\]$/.test(util)) return undefined;

  // R2 字号（在颜色之前判：text-sm 不是颜色）
  const size = util.match(/^text-([a-z0-9-]+?)(?:\/.+)?$/);
  if (size) {
    const v = size[1] as string;
    if (v in SIZE_FIX || /^[2-9]xl$/.test(v)) {
      return ['R2', `${SIZE_FIX[v] ?? 'text-display'}（六档：meta、body、heading、title、display）`];
    }
    if (v === 'canvas' && !file.startsWith('src/components/home/board/')) {
      return ['R2', 'text-meta（text-canvas 只给 components/home/board/ 的画布用）'];
    }
  }

  // R1 颜色
  for (const prefix of COLOR_PREFIXES) {
    if (!util.startsWith(`${prefix}-`)) continue;
    const [base, mod] = splitModifier(util.slice(prefix.length + 1));
    if (base === 'white' || base === 'black' || PALETTE.test(base)) {
      const hint =
        base === 'black'
          ? 'bg-scrim（遮罩）或 foreground'
          : base === 'white'
            ? 'destructive-foreground、brand-foreground 或 background'
            : '语义色（foreground、muted-foreground、st-*、ink-*……）';
      return ['R1', `${prefix}-${hint}；Tailwind 默认色板已关掉，写了也不生效`];
    }
    if (SEMANTIC_COLORS.has(base)) {
      if (mod === undefined) return undefined;
      if (allowed('R1', util, file)) return undefined;
      const tone = base.match(/^st-(\w+)$/)?.[1];
      const hint = tone
        ? `${prefix}-st-${tone}-soft（淡底 12%）或 ${prefix}-st-${tone}-line（描边 40%）`
        : base === 'foreground' || base === 'accent'
          ? `bg-accent（悬停 7%）、bg-selected（选中 10%）或 muted-foreground`
          : `去掉 /${mod}，用不带透明度的语义色`;
      return ['R1', hint];
    }
  }

  // R3 字重
  if (/^font-(?:thin|extralight|light|bold|extrabold|black)$/.test(util)) {
    return ['R3', 'font-semibold（只用 normal、medium、semibold）'];
  }

  // R4 间距
  const sp = util.match(
    /^(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-([0-9.]+)$/,
  );
  if (sp && !SPACING_OK.has(sp[1] as string)) {
    const v = Number(sp[1]);
    const near = [...SPACING_OK]
      .filter((s) => s !== 'px')
      .map(Number)
      .sort((a, b) => Math.abs(a - v) - Math.abs(b - v))[0];
    return [
      'R4',
      `${util.replace(/-[0-9.]+$/, `-${near}`)}（间距只用 0、0.5、1、1.5、2、2.5、3、4、5、6、8、10、12、16）`,
    ];
  }

  // R5 圆角
  const rd = util.match(/^rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(?:-([a-z0-9]+))?$/);
  if (rd) {
    const v = rd[1];
    if (v === undefined || ['xs', 'xl', '2xl', '3xl', '4xl', '2'].includes(v)) {
      const to = v === 'xl' || v === '2xl' || v === '3xl' || v === '4xl' ? 'lg' : 'sm';
      return ['R5', `rounded-${to}（只用 sm 标签、md 控件、lg 卡片和弹层、full 圆点）`];
    }
  }

  // R6 阴影
  if (/^shadow(?:-(?:2xs|sm|md|lg|xl|2xl|card-edge))?$/.test(util)) {
    const to = /lg|xl|2xl/.test(util) ? 'shadow-overlay 或 shadow-modal' : 'shadow-card';
    return ['R6', `${to}（阴影只用 xs、card、overlay、modal）`];
  }

  // R7 行高、字距
  if (/^leading-(?:\d+(?:\.\d+)?|loose)$/.test(util)) {
    return ['R7', '删掉（行高已绑在字号里），要改用 leading-none、tight、snug、normal、relaxed'];
  }
  if (/^tracking-[a-z]+$/.test(util)) {
    return ['R7', '删掉（字距已绑在字号里：text-title 自带 -0.01em）'];
  }
  return undefined;
}

// ---------- 扫一份源码 ----------

function lineStarts(src: string): number[] {
  const out = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') out.push(k + 1);
  return out;
}
function lineAt(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** R8、R9 只管页面和业务组件；基础件（ui/）和版式组件（layout/）本来就是写这些的地方。 */
function layoutRulesApply(file: string): boolean {
  return (
    (file.startsWith('src/routes/') || file.startsWith('src/components/')) &&
    !file.startsWith('src/components/ui/') &&
    !file.startsWith('src/components/layout/')
  );
}

// 旧 lint-arbitrary 的写法：.css 里只判任意值。
const CSS_ARBITRARY =
  /(?:^|[\s"'])((?:[a-zA-Z0-9][a-zA-Z0-9_-]*:)*[a-zA-Z][a-zA-Z0-9_-]*-\[([^\]]*\d[^\]]*)\])/g;

export function scanSource(src: string, file: string): Hit[] {
  const hits: Hit[] = [];
  if (file.endsWith('.css')) {
    src.split('\n').forEach((text, i) => {
      for (const m of text.matchAll(CSS_ARBITRARY)) {
        const cls = m[1] as string;
        if (allowed('R0', cls, file)) continue;
        hits.push({ file, line: i + 1, rule: 'R0', cls, fix: '在 @theme 里加令牌，用令牌类名' });
      }
    });
    return hits;
  }
  const starts = lineStarts(src);
  const { segments, code } = lex(src);
  const layout = layoutRulesApply(file);
  for (const seg of segments) {
    const utils = new Set<string>();
    for (const m of seg.text.matchAll(/\S+/g)) {
      const token = m[0];
      const util = utilityOf(token);
      if (token === util) utils.add(util);
      const verdict = judgeUtility(util, file);
      if (!verdict) continue;
      hits.push({
        file,
        line: lineAt(starts, seg.start + (m.index ?? 0)),
        rule: verdict[0],
        cls: token,
        fix: verdict[1],
      });
    }
    if (!layout) continue;
    const line = lineAt(starts, seg.start);
    if (utils.has('border') && utils.has('bg-card')) {
      hits.push({ file, line, rule: 'R8', cls: 'border + bg-card', fix: '<Section>（手写卡片换版式组件）' });
    }
    if (utils.has('border-dashed') && utils.has('text-center')) {
      hits.push({
        file,
        line,
        rule: 'R8',
        cls: 'border-dashed + text-center',
        fix: '<EmptyState>（手写空状态换版式组件）',
      });
    }
  }
  if (layout) {
    for (const m of code.matchAll(/<select\b/g)) {
      hits.push({
        file,
        line: lineAt(starts, m.index ?? 0),
        rule: 'R9',
        cls: '<select>',
        fix: '<NativeSelect>',
      });
    }
    const icons = lucideImports(src);
    if (icons.length > 0) {
      const iconTag = new RegExp(`<(?:${icons.join('|')})\\b`);
      const lines = code.split('\n');
      for (const m of code.matchAll(/<(input|Input)\b/g)) {
        const at = lineAt(starts, m.index ?? 0);
        const near = lines.slice(Math.max(0, at - 7), at + 6).join('\n');
        if (iconTag.test(near)) {
          hits.push({ file, line: at, rule: 'R9', cls: `带图标的 <${m[1]}>`, fix: '<SearchInput>' });
        }
      }
    }
  }
  return hits;
}

/** 这个文件从 lucide-react 引了哪些图标组件。 */
function lucideImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && /^[A-Z]\w*$/.test(name)) out.push(name);
    }
  }
  return out;
}

export function scanFile(path: string, rel: string): Hit[] {
  return scanSource(readFileSync(path, 'utf8'), rel.replaceAll('\\', '/'));
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(tsx?|css)$/.test(entry) && !entry.includes('.test.')) yield path;
  }
}

export function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const path of walk(srcDir)) hits.push(...scanFile(path, relative(pkgDir, path)));
  return hits;
}

// ---------- 统计 ----------

export type Counts = Record<string, Partial<Record<RuleId, number>>>;

export function countHits(hits: readonly Hit[]): Counts {
  const out: Counts = {};
  for (const h of [...hits].sort((a, b) => a.file.localeCompare(b.file))) {
    const row = out[h.file] ?? {};
    row[h.rule] = (row[h.rule] ?? 0) + 1;
    out[h.file] = row;
  }
  for (const [file, row] of Object.entries(out)) {
    out[file] = Object.fromEntries(RULE_IDS.filter((r) => row[r]).map((r) => [r, row[r]]));
  }
  return out;
}

/** 严格模式：整个 src 一条违规都不许有；返回出错信息（空数组＝通过）。 */
export function check(): string[] {
  return scan().map(formatHit);
}

export function report(hits: readonly Hit[]): string {
  const lines: string[] = [];
  const counts = countHits(hits);
  lines.push(`共 ${hits.length} 处，${Object.keys(counts).length} 个文件。`);
  for (const rule of RULE_IDS) {
    const n = hits.filter((h) => h.rule === rule).length;
    lines.push(`${rule} ${RULES[rule].name}：${n}`);
  }
  lines.push('违规最多的前 20 个文件：');
  const top = Object.entries(counts)
    .map(([file, row]) => [file, Object.values(row).reduce((a, b) => a + (b ?? 0), 0)] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20);
  for (const [file, n] of top) lines.push(`  ${n}\t${file}`);
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--report')) {
    console.log(report(scan()));
    return;
  }
  if (argv.includes('--list')) {
    for (const h of scan()) console.log(formatHit(h));
    return;
  }
  const errors = check();
  for (const e of errors) console.error(e);
  if (errors.length > 0) {
    console.error(`\n设计规范检查没过（${errors.length} 条）。规范：${DOC}。`);
    process.exit(1);
  }
  console.log('设计规范检查通过（严格模式，没有违规）。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
