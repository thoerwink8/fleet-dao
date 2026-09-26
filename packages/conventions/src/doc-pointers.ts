// 文档指针检查：docs/design.md、docs/plan.md、docs/ops.md、README.md 和 specs/ 下的文档里，指向仓内文件的路径、
// 「第 X 节」「X.Y」这类章节、「「X」一节」「README「X」」这类标题、plan.md 的阶段和条目，都要指得到；指不到的报 文件:行。
// 只认本仓文档在用的写法。故意不查的：围栏代码块和 HTML 注释（示例、占位）、别的仓的路径（「windsurf-dao 仓 `docs/…`」）、
// 不以仓里现有的顶层目录或文件开头的路径（/etc/…、~/…、标签名 model/ 这类）、所在文档没有小节编号时的小数（版本号）。
// specs/<目录>/需求.md、方案.md 写在动手之前，指到别的文件、文档里还没有的东西不报（PLANNED_DOC）；写法本身的毛病照报。
// 有误报就收窄这里的规则，不往文档里加豁免。pnpm check 里由 test/doc-pointers.test.ts 对全仓跑一遍。
import { posix } from 'node:path';
import {
  cnNumber,
  type Heading,
  headingKeys,
  type MdDoc,
  norm,
  parseMd,
  readQuote,
  sectionRange,
  stripTrailingParen,
} from './markdown.ts';
import { findItem, type PlanPhase, planPhases } from './plan.ts';
import type { RepoView } from './repo.ts';

/** 要查的几份文档；另加 specs/ 下所有的 .md。 */
export const DOCS = ['docs/design.md', 'docs/plan.md', 'docs/ops.md', 'README.md'] as const;

/**
 * 写在动手之前的文档：方案本来就要写「新建哪个文件、ops 哪一段加什么」，指的东西这时还没有是正常的。它们指到别的文件、
 * 别的文档里的节、标题、引的话、条目、plan 的阶段和条目，指不到不报——引擎把它们直写进主线，不经 PR 的检查，
 * 报了挡的是之后所有别人的 PR。照报的：写法本身的毛病
 * （「第 X 节」没说哪份、plan 条目的空引号——开单骨架故意留空等人填）、指自己这份文档里的标题、design 这几份读不到。
 * 结果.md 写在做完之后，和 design、plan、ops、README 一样严查。只看文件名，不看单子开没开、写了多久（必过检查必须确定）。
 */
const PLANNED_DOC = /^specs\/[^/]+\/(?:需求|方案)\.md$/;

export type PointerKind =
  | 'link'
  | 'path'
  | 'section'
  | 'subsection'
  | 'quote'
  | 'item'
  | 'title'
  | 'plan'
  | 'planItem';

export interface Problem {
  file: string;
  /** 从 1 数；整份文档读不到时是 0。 */
  line: number;
  message: string;
}

/** 查过的一个指针（不管指没指到）。 */
export interface Pointer {
  kind: PointerKind;
  file: string;
  line: number;
  /** 认出来的样子，例如「docs/design.md 第七节」「P1「工作流」」「deploy/france.sh」。 */
  text: string;
  /** 指的东西不在时报不报：需求.md、方案.md 里指到别处的是 false（PLANNED_DOC）。 */
  strict: boolean;
}

export interface Report {
  files: string[];
  problems: Problem[];
  pointers: Pointer[];
  /**
   * 每一类指针查了几个，只数 strict 的（指不到会报的）：某一类是 0，说明规则认不出了、或者只在需求.md、方案.md 里
   * 认出来过，都不能当成「这一类全都指得到」。
   */
  checked: Record<PointerKind, number>;
}

export function formatProblem(p: Problem): string {
  return `${p.file}:${p.line}  ${p.message}`;
}

/** 文档里怎么称呼那几份文档。只认紧挨着指针写的（「design 第七节」「README「常用」」），「README 的「…」」不算。 */
const ALIASES: Record<string, string> = {
  'docs/design.md': 'docs/design.md',
  'design.md': 'docs/design.md',
  design: 'docs/design.md',
  设计文档: 'docs/design.md',
  'docs/plan.md': 'docs/plan.md',
  'plan.md': 'docs/plan.md',
  plan: 'docs/plan.md',
  实施计划: 'docs/plan.md',
  'docs/ops.md': 'docs/ops.md',
  'ops.md': 'docs/ops.md',
  ops: 'docs/ops.md',
  运维手册: 'docs/ops.md',
  'README.md': 'README.md',
  README: 'README.md',
};
const PLAN = 'docs/plan.md';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const ALIAS_RE = new RegExp(
  `(?<![A-Za-z0-9_./-])(?:${Object.keys(ALIASES)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|')})(?![A-Za-z0-9_-])`,
  'y',
);
const CHAPTER_RE = /第\s*([一二三四五六七八九十百零两]+|\d+)\s*节/y;
/** 「15.4」这类小节号：前后不能再接数字或点（1.24.0 是版本号）。 */
const SUB_RE = /(\d{1,2}\.\d{1,2})(?![\d.])/y;
/** 小节号后面得是这些，才当指针（「15.4：」「（15.4）」「15.4 第 5 件」）；「1.2–1.6G」「0.17 秒」都不是。 */
const SUB_AFTER = /^\s*(?:节|第|）|\)|：|:|。|，|、|；|;|$)/;
/** 没写文档名的小节号，前面得是这些（「见 15.4」「按 15.4」「（15.4）」「、15.4」）。 */
const SUB_BEFORE = /(?:见|按|（|\(|、|；|，)\s*$/;
const ITEM_RE = /\s*第\s*(\d+)\s*(条|件)/y;
const PHASE_RE = /(?:的\s*)?P(\d+)(?!\d)/y;
const PHASE_ITEM_RE = /\s*(?:的\s*)?/y;
const LINK_RE = /\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CODE_RE = /`([^`\n]+)`/g;
/** 「windsurf-dao 仓 `docs/…`」：说的是别的仓，不查；「本仓」「这个仓」照查。 */
const OTHER_REPO_RE = /([^\s，。；、：:（(「」）)]+)\s*仓\s*(?:的\s*)?$/;
const THIS_REPO = new Set(['本', '这个', '此', 'fleet-dao']);
/** 仓根下不当成「仓里的东西」的名字。 */
const IGNORED_TOP = new Set(['.git', 'node_modules']);

const emptyCounts = (): Record<PointerKind, number> => ({
  link: 0,
  path: 0,
  section: 0,
  subsection: 0,
  quote: 0,
  item: 0,
  title: 0,
  plan: 0,
  planItem: 0,
});

/** design、plan、ops、README 加上 specs/ 下所有的 .md（按路径排序）。 */
export function docFiles(repo: RepoView): { files: string[]; problems: Problem[] } {
  const specs: string[] = [];
  const problems: Problem[] = [];
  const walk = (dir: string) => {
    const names = repo.list(dir);
    if (names === undefined) {
      problems.push({ file: `${dir}/`, line: 0, message: '列不出这个目录下的文件，里面的文档没查' });
      return;
    }
    for (const name of names) {
      const rel = `${dir}/${name}`;
      if (repo.isDir(rel)) walk(rel);
      else if (name.endsWith('.md')) specs.push(rel);
    }
  };
  walk('specs');
  return { files: [...DOCS, ...specs.sort()], problems };
}

export function checkDocPointers(repo: RepoView, files?: readonly string[]): Report {
  const listed = files ? { files: [...files], problems: [] } : docFiles(repo);
  const checker = new Checker(repo);
  checker.problems.push(...listed.problems);
  for (const file of listed.files) checker.checkFile(file);
  const checked = emptyCounts();
  for (const p of checker.pointers) if (p.strict) checked[p.kind]++;
  return { files: listed.files, problems: checker.problems, pointers: checker.pointers, checked };
}

class Checker {
  readonly problems: Problem[] = [];
  readonly pointers: Pointer[] = [];
  private readonly docs = new Map<string, MdDoc | null>();
  private readonly phases = new Map<string, Map<number, PlanPhase>>();
  private readonly bold = new Map<string, Set<string>>();
  private readonly listings = new Map<string, string[] | null>();
  private readonly repo: RepoView;
  private readonly tops: Set<string>;
  private readonly barePath: RegExp | undefined;

  constructor(repo: RepoView) {
    this.repo = repo;
    const entries = (repo.list('') ?? []).filter((name) => !IGNORED_TOP.has(name));
    this.tops = new Set(entries);
    const dirs = entries.filter((name) => repo.isDir(name));
    // 正文里不带反引号的路径只认「顶层目录/…」，而且只认 ASCII：specs 的目录名带中文，截不准的宁可不查
    this.barePath = dirs.length
      ? new RegExp(`(?<![A-Za-z0-9_./@-])((?:${dirs.map(escapeRe).join('|')})/[A-Za-z0-9_./*@-]*)`, 'g')
      : undefined;
  }

  checkFile(file: string): void {
    const doc = this.doc(file);
    if (!doc) {
      this.problem(file, 0, '读不到这份文档');
      return;
    }
    doc.lines.forEach((raw, i) => {
      if (doc.fenced[i]) return;
      const line = i + 1;
      for (const m of raw.matchAll(CODE_RE)) {
        if (otherRepo(raw.slice(0, m.index))) continue;
        for (const token of (m[1] ?? '').split(/\s+/)) this.checkPath(file, line, token);
      }
      const noCode = raw.replace(CODE_RE, (s) => ' '.repeat(s.length));
      for (const m of noCode.matchAll(LINK_RE)) this.checkLink(file, line, m[2] ?? '');
      this.checkBarePaths(file, line, noCode.replace(LINK_RE, '$1'));
      // 找章节、标题指针时，反引号里的文档路径（`docs/design.md`「…」）照样算文档名，别的反引号内容不算
      const refs = raw.replace(CODE_RE, (_s, c: string) => (c in ALIASES ? c : '□')).replace(LINK_RE, '$1');
      this.scanRefs(file, line, refs);
    });
  }

  // —— 路径 ——

  private checkPath(file: string, line: number, token: string): void {
    const t = token.replace(/[，。；：、,;:)）」]+$/, '');
    if (!t || /[<>{}$|"'=\\]/.test(t) || /^[~/]/.test(t) || t.startsWith('..')) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return; // 网址、host:port
    if (!this.tops.has(t.split('/')[0] ?? '')) return;
    this.note('path', file, line, t, t);
    if (!this.pathExists(t)) this.missing(file, line, t, `${t} 在仓里没有`);
  }

  private checkBarePaths(file: string, line: number, prose: string): void {
    if (!this.barePath) return;
    for (const m of prose.matchAll(this.barePath)) {
      const next = prose[m.index + m[0].length] ?? '';
      if (/[\p{L}\p{N}]/u.test(next)) continue; // 后面紧跟着中文字：路径可能还没完
      if (otherRepo(prose.slice(0, m.index))) continue;
      this.checkPath(file, line, (m[1] ?? '').replace(/\.+$/, ''));
    }
  }

  private checkLink(file: string, line: number, target: string): void {
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return;
    let p = target.split('#')[0]?.split('?')[0] ?? '';
    try {
      p = decodeURIComponent(p);
    } catch {
      // 不是合法的百分号编码：按原样找
    }
    const rel = posix.normalize(posix.join(posix.dirname(file), p));
    this.note('link', file, line, target, rel);
    if (rel === '..' || rel.startsWith('../') || !this.pathExists(rel)) {
      this.missing(file, line, rel, `链接 ${target} 指的 ${rel} 在仓里没有`);
    }
  }

  /** 逐段按目录列表比名字（大小写也要对上，和 CI 的 Linux 一样）；段里的 * 当通配。 */
  private pathExists(rel: string): boolean {
    const dirOnly = rel.endsWith('/');
    const segs = rel.split('/').filter((s) => s && s !== '.');
    const walk = (base: string, rest: string[]): boolean => {
      const [seg, ...more] = rest;
      if (seg === undefined) return !dirOnly || base === '' || this.repo.isDir(base);
      const glob = seg.includes('*')
        ? new RegExp(`^${seg.split('*').map(escapeRe).join('[^/]*')}$`)
        : undefined;
      return (this.list(base) ?? []).some(
        (name) => (glob ? glob.test(name) : name === seg) && walk(base ? `${base}/${name}` : name, more),
      );
    };
    return walk('', segs);
  }

  private list(dir: string): string[] | undefined {
    if (!this.listings.has(dir)) this.listings.set(dir, this.repo.list(dir) ?? null);
    return this.listings.get(dir) ?? undefined;
  }

  // —— 章节、标题、plan 条目 ——

  private scanRefs(file: string, line: number, text: string): void {
    // 同一行里前面写过「design 第五节」，后面光写「第九节」「15.4」的也算 design 的
    let context: string | undefined;
    let i = 0;
    while (i < text.length) {
      ALIAS_RE.lastIndex = i;
      const alias = ALIAS_RE.exec(text);
      if (alias) {
        const target = ALIASES[alias[0]] ?? '';
        const end = this.attached(file, line, text, target, skipSpaces(text, i + alias[0].length));
        if (end !== undefined) context = target;
        i = end ?? i + alias[0].length;
        continue;
      }
      const here = context ?? file;
      const end =
        this.bareChapter(file, line, text, here, i) ??
        this.bareSub(file, line, text, here, i) ??
        this.bareTitle(file, line, text, here, i);
      i = end ?? i + 1;
    }
  }

  /** 紧跟在文档名后面的指针；不是指针返回 undefined。 */
  private attached(file: string, line: number, text: string, target: string, at: number): number | undefined {
    CHAPTER_RE.lastIndex = at;
    const chapter = CHAPTER_RE.exec(text);
    if (chapter?.[1])
      return this.chapterRef(file, line, text, target, chapter[1], CHAPTER_RE.lastIndex, false);
    SUB_RE.lastIndex = at;
    const sub = SUB_RE.exec(text);
    if (sub?.[1] && SUB_AFTER.test(text.slice(SUB_RE.lastIndex))) {
      return this.subRef(file, line, text, target, sub[1], SUB_RE.lastIndex, false);
    }
    if (target === PLAN) {
      PHASE_RE.lastIndex = at;
      const phase = PHASE_RE.exec(text);
      if (phase?.[1]) return this.phaseRef(file, line, text, Number(phase[1]), PHASE_RE.lastIndex);
    }
    const quote = readQuote(text, at);
    if (!quote) return undefined;
    this.note('title', file, line, `${target}「${quote.text}」`, target);
    const doc = this.doc(target);
    if (!doc) this.problem(file, line, `读不到 ${target}`);
    else if (!this.hasTitle(doc, quote.text, true))
      this.missing(file, line, target, `${target} 里没有叫「${quote.text}」的标题`);
    return text.startsWith('一节', quote.end) ? quote.end + 2 : quote.end;
  }

  private bareChapter(
    file: string,
    line: number,
    text: string,
    here: string,
    at: number,
  ): number | undefined {
    CHAPTER_RE.lastIndex = at;
    const m = CHAPTER_RE.exec(text);
    return m?.[1] ? this.chapterRef(file, line, text, here, m[1], CHAPTER_RE.lastIndex, true) : undefined;
  }

  private bareSub(file: string, line: number, text: string, here: string, at: number): number | undefined {
    if (/[\d.]/.test(text[at - 1] ?? '') || !SUB_BEFORE.test(text.slice(0, at))) return undefined;
    SUB_RE.lastIndex = at;
    const m = SUB_RE.exec(text);
    if (!m?.[1] || !SUB_AFTER.test(text.slice(SUB_RE.lastIndex))) return undefined;
    return this.subRef(file, line, text, here, m[1], SUB_RE.lastIndex, true);
  }

  /** 「「备份与恢复」一节」：那份文档里得有这个标题。 */
  private bareTitle(file: string, line: number, text: string, here: string, at: number): number | undefined {
    const quote = readQuote(text, at);
    if (!quote || !text.startsWith('一节', quote.end)) return undefined;
    this.note('title', file, line, `${here}「${quote.text}」一节`, here);
    const doc = this.doc(here);
    if (!doc) this.problem(file, line, `读不到 ${here}`);
    else if (!this.hasTitle(doc, quote.text, false))
      this.missing(file, line, here, `${here} 里没有叫「${quote.text}」的一节`);
    return quote.end + 2;
  }

  private chapterRef(
    file: string,
    line: number,
    text: string,
    target: string,
    numeral: string,
    end: number,
    bare: boolean,
  ): number {
    this.note('section', file, line, `${target} 第${numeral}节`, target);
    const doc = this.doc(target);
    if (!doc) {
      this.problem(file, line, `读不到 ${target}`);
      return this.tail(file, line, text, undefined, undefined, end, '');
    }
    const n = cnNumber(numeral);
    const h = n === undefined ? undefined : doc.headings.find((x) => x.chapter === n);
    if (!h) {
      const hasChapters = doc.headings.some((x) => x.chapter !== undefined);
      // 没说哪份是写法的毛病，不是「那一节还没写」：在哪份文档里都报
      if (bare && !hasChapters) {
        this.problem(
          file,
          line,
          `「第${numeral}节」没说是哪份文档（${target} 自己没有编号的节）：前面写上 design、plan 或 ops`,
        );
      } else this.missing(file, line, target, `${target} 里没有第${numeral}节`);
    }
    return this.tail(file, line, text, doc, h, end, `${target} 第${numeral}节`);
  }

  private subRef(
    file: string,
    line: number,
    text: string,
    target: string,
    xy: string,
    end: number,
    bare: boolean,
  ): number | undefined {
    const doc = this.doc(target);
    const subs = doc?.headings.filter((x) => x.sub !== undefined) ?? [];
    // 没写文档名、这份文档又没有小节编号：多半是版本号之类的小数，不当指针
    if (bare && subs.length === 0) return undefined;
    this.note('subsection', file, line, `${target} ${xy}`, target);
    if (!doc) {
      this.problem(file, line, `读不到 ${target}`);
      return this.tail(file, line, text, undefined, undefined, end, '');
    }
    const h = subs.find((x) => x.sub === xy);
    if (!h) this.missing(file, line, target, `${target} 里没有 ${xy} 这一小节`);
    return this.tail(file, line, text, doc, h, end, `${target} ${xy}`);
  }

  /** 章节后面紧跟的「…」（可以连着几个）和「第 N 条」：都得在那一节里。节没找到时只跳过、不再报。 */
  private tail(
    file: string,
    line: number,
    text: string,
    doc: MdDoc | undefined,
    h: Heading | undefined,
    end: number,
    label: string,
  ): number {
    let e = end;
    for (let q = readQuote(text, e); q; q = readQuote(text, e)) {
      if (doc && h) {
        this.note('quote', file, line, `${label}「${q.text}」`, doc.path);
        if (!this.sectionHas(doc, h, q.text, doc.path === file ? line : undefined)) {
          this.missing(file, line, doc.path, `${label}里找不到「${q.text}」`);
        }
      }
      e = q.end;
    }
    ITEM_RE.lastIndex = e;
    const item = ITEM_RE.exec(text);
    if (item?.[1]) {
      if (doc && h) {
        this.note('item', file, line, `${label} 第 ${item[1]} ${item[2]}`, doc.path);
        if (!this.sectionHasItem(doc, h, item[1]))
          this.missing(file, line, doc.path, `${label}里没有第 ${item[1]} ${item[2]}`);
      }
      e = ITEM_RE.lastIndex;
    }
    return e;
  }

  private phaseRef(file: string, line: number, text: string, n: number, end: number): number {
    this.note('plan', file, line, `P${n}`, PLAN);
    const doc = this.doc(PLAN);
    if (!doc) {
      this.problem(file, line, `读不到 ${PLAN}`);
      return end;
    }
    const phase = this.planPhases(doc).get(n);
    if (!phase) this.missing(file, line, PLAN, `plan.md 里没有 P${n} 这个阶段`);
    PHASE_ITEM_RE.lastIndex = end;
    PHASE_ITEM_RE.exec(text);
    const quote = readQuote(text, PHASE_ITEM_RE.lastIndex);
    if (!quote) return end;
    if (phase) {
      this.note('planItem', file, line, `P${n}「${quote.text}」`, PLAN);
      // 空引号是没填（开单骨架故意留空，不填就提交会红），不是「那一条还没有」：在哪份文档里都报
      if (!quote.text.trim()) this.problem(file, line, `plan.md P${n}「」引号里是空的，没写是哪一条`);
      else if (findItem(phase, quote.text) === undefined) {
        this.missing(file, line, PLAN, `plan.md 的 P${n} 里找不到「${quote.text}」`);
      }
    }
    return quote.end;
  }

  /**
   * 引的话得是那一节里某一行的原文（比较用的写法之后整段包含）。写大意不算：试过「三分之二的词对得上就算」，
   * 删掉一整条、改掉半个标题、意思改反了都凑得过线（#41 审查在真文档上造的三处一处没报），写大意的就改成原文。
   * skipLine：指针自己那一行（指针就写在它指的那一节里时），不拿它自己的字去对。
   */
  private sectionHas(doc: MdDoc, h: Heading, quote: string, skipLine: number | undefined): boolean {
    const want = norm(quote);
    if (!want) return false;
    const { start, end } = sectionRange(doc, h);
    return doc.lines
      .slice(start, end)
      .some((l, k) => !doc.fenced[start + k] && start + k + 1 !== skipLine && norm(l).includes(want));
  }

  /** 表格里「| N |」那一行，或者有序列表「N. 」那一条。 */
  private sectionHasItem(doc: MdDoc, h: Heading, n: string): boolean {
    const { start, end } = sectionRange(doc, h);
    const row = new RegExp(`^\\s*(?:\\|\\s*${n}\\s*\\||${n}[.、]\\s)`);
    return doc.lines.slice(start, end).some((l) => row.test(l));
  }

  /** 标题（带不带编号、末尾括号都行）；allowBold 时加粗的字也算。 */
  private hasTitle(doc: MdDoc, title: string, allowBold: boolean): boolean {
    const want = norm(title);
    if (doc.headings.some((h) => headingKeys(h).includes(want))) return true;
    return allowBold && this.boldLabels(doc).has(want);
  }

  private boldLabels(doc: MdDoc): Set<string> {
    let labels = this.bold.get(doc.path);
    if (!labels) {
      labels = new Set();
      doc.lines.forEach((l, i) => {
        if (doc.fenced[i]) return;
        for (const m of l.matchAll(/\*\*([^*\n]+)\*\*/g)) {
          const t = norm(m[1] ?? '');
          labels?.add(t).add(stripTrailingParen(t));
        }
      });
      this.bold.set(doc.path, labels);
    }
    return labels;
  }

  private planPhases(doc: MdDoc): Map<number, PlanPhase> {
    let phases = this.phases.get(doc.path);
    if (!phases) {
      phases = planPhases(doc);
      this.phases.set(doc.path, phases);
    }
    return phases;
  }

  private doc(path: string): MdDoc | undefined {
    if (!this.docs.has(path)) {
      const text = this.repo.read(path);
      this.docs.set(path, text === undefined ? null : parseMd(path, text));
    }
    return this.docs.get(path) ?? undefined;
  }

  /** target：指到的文件或文档（仓内路径），用来判指不到时报不报。 */
  private note(kind: PointerKind, file: string, line: number, text: string, target: string): void {
    this.pointers.push({ kind, file, line, text, strict: this.strict(file, target) });
  }

  /** 指不到时报不报：写在动手之前的文档指到别处的不报（PLANNED_DOC），指它自己的照报。 */
  private strict(file: string, target: string): boolean {
    return target === file || !PLANNED_DOC.test(file);
  }

  /** 指的东西没有（文件、节、标题、引的话、条目、阶段）。写法本身的毛病、文档读不到不走这里，直接 problem。 */
  private missing(file: string, line: number, target: string, message: string): void {
    if (this.strict(file, target)) this.problem(file, line, message);
  }

  private problem(file: string, line: number, message: string): void {
    this.problems.push({ file, line, message });
  }
}

function skipSpaces(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s[j] ?? '')) j++;
  return j;
}

function otherRepo(before: string): boolean {
  const m = OTHER_REPO_RE.exec(before);
  return m?.[1] !== undefined && !THIS_REPO.has(m[1]);
}
