// 欠账检查（#67）：「以后要做」的事必须是一张开着的 issue（design 第三节第 35 条）。分两半（#87：必过检查必须确定）：
// - 只看文件的（checkDebtDocs，.github/workflows/debt.yml 在主线推送和每天跑，不进 pnpm check）：活文档（AGENTS.md、README.md、agents/shared-rules.md、
//   docs/ 下除了 reference/、decisions/、archive/）里推后的话（「以后再做」「先不建」「再定」「留到下一轮」「后面阶段」这类）同一句里要带单号。
//   不读 GitHub：同一份代码什么时候跑、单子开着还是关了，结果都一样，没网也照常跑。
// - 看 GitHub 现状的（liveDebt，只在 debt.yml 的定时任务里跑）：挂的单号是不是开着的 issue。查出来留言到对应的单上，
//   不让任何 PR 变红。别把这一半接回 pnpm check：#83 这么接过，#67 一关主线和所有 PR 一起红。
// 不查 specs/ 和 docs/decisions/（#654）：那是历史记录，写下那一刻的话不该被后来的检查逼着回头改；需求本身就在 GitHub 的单子里
// （单子正文是需求的唯一的家），「怎么算做完」写没写由 pnpm issue:new 开单时拦，不再要求仓里另存一份需求.md。
//
// 推后的说法用一张写死的词表认（检查要每次一样、测试不出网，见 judge-or-code 第 3 问），宁漏不误：
// 「以后加机器就是加工人」「先说结果，再说要我做什么」「它以后再发一次」这类不是推后，都不认。
// 故意不查的：围栏代码块、HTML 注释、反引号里、「」引号里（那是在提这个词，不是在推后）、docs/reference/
// （旧系统审计的快照，记的是当时的待查项）、docs/decisions/ 和 specs/（历史记录，#654）、docs/archive/（PROGRESS 搬走的历史节，#901）。
// 有误报就收窄词表，不往文档里加豁免；漏了就补进词表，并在测试里加一条。

import type { Finding } from './findings.ts';
import type { GitHubReader } from './github-api.ts';
import { type MdDoc, norm, parseMd, sectionRange } from './markdown.ts';
import type { RepoView } from './repo.ts';

/** 推后的说法。每一条都在 test/debt.test.ts 里有一个认、一个不认的例子。 */
export const DEFERRAL_PATTERNS: readonly RegExp[] = [
  /以后再(?:做|加|补|接|开|定|说|评估|考虑|议)/,
  /以后要做/,
  /先不(?:做|建|接|搬|加|设|改|开|上|管|动|拆|合|写|装)/,
  /暂缓/,
  /暂不(?:做|建|接|加|开|改|上)/,
  /观察[^。；，]{0,20}?再(?:定|说|做|开)/,
  /后面的?阶段/,
  /后续阶段/,
  /再说(?=[。；，、—）)]|$)/,
  /再定/,
  /到时(?:候)?(?:再|问)/,
  /留(?:给|到)(?:后续|以后|后面|下一)/,
  /之后再(?:做|定|评估|加|接|开|打开|说|议)/,
  /(?:验收|上线)(?:之)?后(?:再)?做/,
];

/**
 * 查哪些文档：仓根的 AGENTS.md、README.md，通用段原件 agents/shared-rules.md（原来在 AGENTS.md 里一起查，2026-10-05 挪出来），
 * docs/ 下（除了 docs/reference/、docs/decisions/、docs/archive/）所有的 .md；
 * specs/ 是历史记录，不查。docs/archive/ 是 docs/PROGRESS.md 搬走的历史节（#901），写的是当时的「下一步」「待办」，原样保留、不改字。
 */
export const DEBT_ROOT_DOCS = ['AGENTS.md', 'README.md', 'agents/shared-rules.md'] as const;
const SKIPPED_DIRS = new Set(['docs/reference', 'docs/decisions', 'docs/archive']);

/** 同仓的单号：`#12`；`windsurf-dao#12`、`owner/repo#12` 是别的仓的，不算。 */
const ISSUE_REF = /(?<![\w/#-])#(\d+)(?!\d)/g;

export interface DebtProblem {
  file: string;
  /** 从 1 数；整份文档或整个目录的问题是 0。 */
  line: number;
  message: string;
}

export interface Deferral {
  file: string;
  line: number;
  /** 认出来的说法，例如「先不建」。 */
  phrase: string;
  /** 这一句的原文（去掉首尾空白）。 */
  sentence: string;
  /** 这一句里写的同仓单号。 */
  refs: number[];
}

export function formatDebtProblem(p: DebtProblem): string {
  return p.line ? `${p.file}:${p.line}  ${p.message}` : `${p.file}  ${p.message}`;
}

/** 要查的文档，按路径排序；列不出的目录记成问题（不当成那里没有文档）。 */
export function debtFiles(repo: RepoView): { files: string[]; problems: DebtProblem[] } {
  const files: string[] = [];
  const problems: DebtProblem[] = [];
  for (const f of DEBT_ROOT_DOCS) {
    if (repo.exists(f)) files.push(f);
    else problems.push({ file: f, line: 0, message: '读不到这份文档' });
  }
  const walk = (dir: string) => {
    if (SKIPPED_DIRS.has(dir)) return;
    const names = repo.list(dir);
    if (names === undefined) {
      problems.push({ file: `${dir}/`, line: 0, message: '列不出这个目录下的文件，里面的文档没查' });
      return;
    }
    for (const name of names) {
      const rel = `${dir}/${name}`;
      if (repo.isDir(rel)) walk(rel);
      else if (name.endsWith('.md')) files.push(rel);
    }
  };
  walk('docs');
  return { files: files.sort(), problems };
}

/** 反引号里、「」引号里的字换成占位（长度不变）：那是在提这个词，不是在用。 */
function maskMentions(line: string): string {
  let out = line.replace(/`[^`\n]*`/g, (s) => '□'.repeat(s.length));
  // 引号可以套引号：从里往外一层层盖掉
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/「[^「」]*」/g, (s) => '□'.repeat(s.length));
  }
  return out;
}

/** 一份文档里推后的句子。 */
export function findDeferrals(doc: MdDoc): Deferral[] {
  const found: Deferral[] = [];
  doc.lines.forEach((raw, i) => {
    if (doc.fenced[i]) return;
    const masked = maskMentions(raw);
    let start = 0;
    for (const piece of masked.split(/(?<=[。；！？])/)) {
      const end = start + piece.length;
      const phrase = firstPhrase(piece);
      if (phrase !== undefined) {
        const sentence = raw.slice(start, end);
        found.push({
          file: doc.path,
          line: i + 1,
          phrase,
          sentence: sentence.trim(),
          refs: [...sentence.matchAll(ISSUE_REF)].map((m) => Number(m[1])),
        });
      }
      start = end;
    }
  });
  return found;
}

function firstPhrase(text: string): string | undefined {
  let best: { at: number; text: string } | undefined;
  for (const re of DEFERRAL_PATTERNS) {
    const m = re.exec(text);
    if (m && (best === undefined || m.index < best.at)) best = { at: m.index, text: m[0] };
  }
  return best?.text;
}

export type DoneSection = 'ok' | 'missing' | 'empty';

/** 「怎么算做完」那一节（哪一级小标题都行）在不在、空不空。 */
export function doneSection(doc: MdDoc): DoneSection {
  const h = doc.headings.find((x) => norm(x.title).startsWith('怎么算做完'));
  if (!h) return 'missing';
  const { start, end } = sectionRange(doc, h);
  return doc.lines.slice(start + 1, end).some((l) => l.trim()) ? 'ok' : 'empty';
}

export type RefState = 'open' | 'closed' | 'pr' | 'missing';

/**
 * 只看文件：推后的话同一句里没有单号就是问题。单号开没开着不在这里判——
 * 那要读 GitHub，同一份代码前后两次结果会不同（#87），挪到定时任务（liveDebt）。
 */
export function untrackedDeferrals(deferrals: readonly Deferral[]): DebtProblem[] {
  return deferrals
    .filter((d) => d.refs.length === 0)
    .map((d) => ({
      file: d.file,
      line: d.line,
      message: `「${shorten(d.sentence)}」里有「${d.phrase}」，同一句里没有单号：开一张带「怎么算做完」和里程碑的 issue（pnpm issue:new）把 #号写进这一句，或者改掉推后的说法`,
    }));
}

/** 推后的话挂的单号都不是开着的 issue：留言到那张关了的单上；只挂着 PR 或查不到的号，没处留言。 */
export function staleRefFindings(deferrals: readonly Deferral[], states: Map<number, RefState>): Finding[] {
  const found: Finding[] = [];
  for (const d of deferrals) {
    const candidates = [...new Set(d.refs)];
    if (candidates.length === 0 || candidates.some((n) => states.get(n) === 'open')) continue;
    const why = candidates.map((n) => `#${n} ${describe(states.get(n))}`).join('，');
    const text = `${d.file}:${d.line}「${shorten(d.sentence)}」里有「${d.phrase}」，可挂的单号都不是开着的 issue（${why}）：换成开着的单号，或者改掉推后的说法`;
    const closed = candidates.find((n) => states.get(n) === 'closed');
    found.push({ issue: closed, key: `ref:${d.file}:${d.sentence}`, text });
  }
  return found;
}

function describe(state: RefState | undefined): string {
  switch (state) {
    case 'closed':
      return '已经关了';
    case 'pr':
      return '是 PR 不是 issue';
    case 'missing':
      return '在 GitHub 上没有';
    default:
      return '没查到';
  }
}

function shorten(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 50 ? `${t.slice(0, 50)}…` : t;
}

/** 这些号现在的样子：开着的一次读完，其余逐个问。读不到就抛（调用方判「没查成」）。 */
export async function refStates(numbers: Iterable<number>, gh: GitHubReader): Promise<Map<number, RefState>> {
  const want = [...new Set(numbers)].sort((a, b) => a - b);
  const states = new Map<number, RefState>();
  if (want.length === 0) return states;
  const open = new Set((await gh.openIssues()).map((i) => i.number));
  for (const n of want) {
    if (open.has(n)) {
      states.set(n, 'open');
      continue;
    }
    const info = await gh.issue(n);
    states.set(
      n,
      info === undefined ? 'missing' : info.isPr ? 'pr' : info.state === 'open' ? 'open' : 'closed',
    );
  }
  return states;
}

export interface DebtRun {
  /** 0 = 没欠账；1 = 有欠账；2 = 没查成（读不到文档），同样是红。 */
  code: 0 | 1 | 2;
  lines: string[];
}

/**
 * pnpm check 里跑的那一半（test/debt.test.ts 对全仓跑）：只看文件，不读 GitHub，没网也照常跑，
 * 同一份代码什么时候跑结果都一样（#87：必过检查必须确定）。
 */
export function checkDebtDocs(repo: RepoView): DebtRun & { deferrals: Deferral[] } {
  const problems: DebtProblem[] = [];
  const notQueried: string[] = [];
  const listed = debtFiles(repo);
  problems.push(...listed.problems);
  const deferrals: Deferral[] = [];
  let readable = 0;
  for (const file of listed.files) {
    const text = repo.read(file);
    if (text === undefined) {
      problems.push({ file, line: 0, message: '读不到这份文档' });
      continue;
    }
    readable++;
    deferrals.push(...findDeferrals(parseMd(file, text)));
  }
  if (readable === 0) notQueried.push('一份文档也没读到');
  problems.push(...untrackedDeferrals(deferrals));

  const lines = [...problems.map(formatDebtProblem), ...notQueried.map((w) => `没查成：${w}。`)];
  const code = notQueried.length ? 2 : problems.length ? 1 : 0;
  if (code === 0) {
    lines.unshift(
      `欠账检查（只看文件）过了：${readable} 份文档里 ${deferrals.length} 句推后的话都带着单号。`,
    );
  }
  return { code, lines, deferrals };
}

export interface LiveDebt {
  docs: DebtRun;
  findings: Finding[];
  /** 没查成的几样（读不到 GitHub）：定时任务照样判红，不当成没欠账。 */
  notQueried: string[];
}

/**
 * 定时任务那一半（.github/workflows/debt.yml）：推后的话挂的单号是不是开着的 issue。
 * 看的是 GitHub 上的现状，所以不进 PR 的必过检查；查出来的是 findings，由 findings.ts 的 reportFindings 留言到对应的单上。
 */
export async function liveDebt(opts: { repo: RepoView; gh: GitHubReader }): Promise<LiveDebt> {
  const docs = checkDebtDocs(opts.repo);
  const findings: Finding[] = [];
  const notQueried: string[] = [];
  const numbers = docs.deferrals.flatMap((d) => d.refs);
  try {
    findings.push(...staleRefFindings(docs.deferrals, await refStates(numbers, opts.gh)));
  } catch (e) {
    notQueried.push(`读不到 GitHub 上单子的状态（${message(e)}），推后的句子挂的单号没核`);
  }
  return { docs: { code: docs.code, lines: docs.lines }, findings, notQueried };
}

/** 欠账留言的开头一句（findings.ts 的 reportFindings 用）。 */
export const DEBT_REPORT_HEADER = '欠账检查（.github/workflows/debt.yml，#67、#87）查出来的，挂在这张单上：';

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
