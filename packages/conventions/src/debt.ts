// 欠账检查（#67）：「以后要做」的事必须是一张开着的 issue（design 第三节第 35 条）。三样：
// 1. 文档里推后的话（「以后再做」「先不建」「再定」「留到下一轮」「后面阶段」这类），同一句里要带一个开着的 issue 号；
//    specs/<号>-*/ 下的文档，本单号也算。单号查不到、关了、是 PR，都判红；GitHub 读不到判「没查成」，也是红。
// 2. specs/*/需求.md 要有「## 怎么算做完」一节，而且不空。
// 3. 开着的 issue 在主线上要有 specs/<号>-*/需求.md（开单一天内的不算欠）。这一样看的是 GitHub 上的现状，
//    放进 PR 的必过检查会让两个各带自己需求文档的 PR 互相卡死，所以只在 --open-issues 时查（.github/workflows/debt.yml）。
//
// 推后的说法用一张写死的词表认（检查要每次一样、测试不出网，见 judge-or-code 第 3 问），宁漏不误：
// 「以后加机器就是加工人」「先说结果，再说要我做什么」「它以后再发一次」这类不是推后，都不认。
// 故意不查的：围栏代码块、HTML 注释、反引号里、「」引号里（那是在提这个词，不是在推后）、docs/reference/
// （旧系统审计的快照，记的是当时的待查项；新系统要做的已经搬进 design、plan 和 specs）。
// 有误报就收窄词表，不往文档里加豁免；漏了就补进词表，并在测试里加一条。

import type { GitHubReader, IssueInfo } from './github-api.ts';
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

/** 查哪些文档：仓根的 AGENTS.md、README.md，docs/ 下（除了 docs/reference/）和 specs/ 下所有的 .md。 */
export const DEBT_ROOT_DOCS = ['AGENTS.md', 'README.md'] as const;
const SKIPPED_DIRS = new Set(['docs/reference']);

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
  /** 文档在 specs/<号>-<短名>/ 下时的那个号。 */
  owner: number | undefined;
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
  walk('specs');
  return { files: files.sort(), problems };
}

/** specs/12-登录验证码/需求.md → 12。 */
export function specsOwner(file: string): number | undefined {
  const m = /^specs\/(\d+)-[^/]+\//.exec(file);
  return m?.[1] ? Number(m[1]) : undefined;
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
  const owner = specsOwner(doc.path);
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
          owner,
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

/** specs/ 下每个需求目录都要有 需求.md，里面「怎么算做完」不空。 */
export function checkSpecsDone(repo: RepoView): { checked: number; problems: DebtProblem[] } {
  const problems: DebtProblem[] = [];
  const dirs = repo.list('specs');
  if (dirs === undefined) {
    return { checked: 0, problems: [{ file: 'specs/', line: 0, message: '列不出 specs/ 下的目录' }] };
  }
  let checked = 0;
  for (const name of dirs.sort()) {
    const dir = `specs/${name}`;
    if (!repo.isDir(dir)) continue;
    if (!/^\d+-./.test(name)) {
      problems.push({ file: `${dir}/`, line: 0, message: '目录名认不出单号：要叫 specs/<号>-<短名>/' });
      continue;
    }
    const file = `${dir}/需求.md`;
    const text = repo.read(file);
    if (text === undefined) {
      problems.push({ file: `${dir}/`, line: 0, message: '没有 需求.md（或读不到）' });
      continue;
    }
    checked++;
    const state = doneSection(parseMd(file, text));
    if (state === 'missing') {
      problems.push({
        file,
        line: 0,
        message: '没有「## 怎么算做完」一节：写成能检查的样子（测试名、脚本、真机上看到什么）',
      });
    } else if (state === 'empty') {
      problems.push({
        file,
        line: 0,
        message: '「怎么算做完」一节是空的：写成能检查的样子（测试名、脚本、真机上看到什么）',
      });
    }
  }
  return { checked, problems };
}

/** 单号现在的样子：open = 开着的 issue；其余都是它为什么不算。 */
export type RefState = 'open' | 'closed' | 'pr' | 'missing';

/** 每一句推后的话：写的单号（加上所在需求目录的号）里至少一个是开着的 issue。 */
export function judgeDeferrals(deferrals: readonly Deferral[], states: Map<number, RefState>): DebtProblem[] {
  const problems: DebtProblem[] = [];
  for (const d of deferrals) {
    const candidates = [...new Set([...d.refs, ...(d.owner === undefined ? [] : [d.owner])])];
    if (candidates.some((n) => states.get(n) === 'open')) continue;
    const quote = `「${shorten(d.sentence)}」`;
    if (candidates.length === 0) {
      problems.push({
        file: d.file,
        line: d.line,
        message: `${quote}里有「${d.phrase}」，同一句里没有单号：开一张带「怎么算做完」和里程碑的 issue（pnpm issue:new）把 #号写进这一句，或者改掉推后的说法`,
      });
      continue;
    }
    const why = candidates.map((n) => `#${n} ${describe(states.get(n))}`).join('，');
    problems.push({
      file: d.file,
      line: d.line,
      message: `${quote}里有「${d.phrase}」，可写的单号都不是开着的 issue（${why}）：换成开着的单号，或者改掉推后的说法`,
    });
  }
  return problems;
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

/** 开单后多久还没有需求文档就算欠（第六节：分支活不过一天）。 */
export const SPECS_GRACE_HOURS = 24;

/** 开着的 issue 在 specs/ 下有没有 <号>-<短名>/需求.md；开单不满一天的只提一句，不算欠。 */
export function checkOpenIssuesHaveSpecs(
  repo: RepoView,
  open: readonly IssueInfo[],
  now: Date,
): { problems: DebtProblem[]; notes: string[] } {
  const problems: DebtProblem[] = [];
  const notes: string[] = [];
  const dirs = repo.list('specs');
  if (dirs === undefined) {
    return { problems: [{ file: 'specs/', line: 0, message: '列不出 specs/ 下的目录' }], notes };
  }
  for (const issue of [...open].sort((a, b) => a.number - b.number)) {
    if (issue.isPr) continue;
    const has = dirs.some((d) => d.startsWith(`${issue.number}-`) && repo.exists(`specs/${d}/需求.md`));
    if (has) continue;
    const created = Date.parse(issue.createdAt);
    if (Number.isNaN(created)) {
      problems.push({
        file: 'specs/',
        line: 0,
        message: `#${issue.number} 的开单时间认不出（${issue.createdAt}），当作欠着`,
      });
      continue;
    }
    const hours = (now.getTime() - created) / 3_600_000;
    if (hours < SPECS_GRACE_HOURS) {
      notes.push(`#${issue.number} 还没有需求文档，开单 ${Math.floor(hours)} 小时，一天内补上就行`);
      continue;
    }
    problems.push({
      file: 'specs/',
      line: 0,
      message: `#${issue.number}「${shorten(issue.title)}」开着，可主线上没有 specs/${issue.number}-<短名>/需求.md：照 issue 写一份（完整需求只在仓里存一处，issue 上留原话、AI 理解和链接）`,
    });
  }
  return { problems, notes };
}

export interface DebtRun {
  /** 0 = 没欠账；1 = 有欠账；2 = 没查成（读不到文档或 GitHub），同样是红。 */
  code: 0 | 1 | 2;
  lines: string[];
}

export async function runDebtCheck(opts: {
  repo: RepoView;
  gh: GitHubReader | string;
  openIssues: boolean;
  now?: Date;
}): Promise<DebtRun> {
  const { repo } = opts;
  const problems: DebtProblem[] = [];
  const notQueried: string[] = [];
  const notes: string[] = [];

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

  const done = checkSpecsDone(repo);
  problems.push(...done.problems);
  if (done.checked === 0) notQueried.push('specs/ 下一份 需求.md 也没读到');

  const gh = typeof opts.gh === 'string' ? undefined : opts.gh;
  if (gh === undefined) {
    notQueried.push(`没法读 GitHub（${opts.gh}），推后的句子里的单号没核`);
  } else {
    const numbers = deferrals.flatMap((d) => [...d.refs, ...(d.owner === undefined ? [] : [d.owner])]);
    try {
      problems.push(...judgeDeferrals(deferrals, await refStates(numbers, gh)));
    } catch (e) {
      notQueried.push(`读不到 GitHub 上单子的状态（${message(e)}），推后的句子里的单号没核`);
    }
    if (opts.openIssues) {
      try {
        const cov = checkOpenIssuesHaveSpecs(repo, await gh.openIssues(), opts.now ?? new Date());
        problems.push(...cov.problems);
        notes.push(...cov.notes);
      } catch (e) {
        notQueried.push(`读不到开着的 issue（${message(e)}），没核它们有没有需求文档`);
      }
    }
  }

  const lines = [
    ...problems.map(formatDebtProblem),
    ...notQueried.map((w) => `没查成：${w}。`),
    ...notes.map((n) => `提醒：${n}。`),
  ];
  const code = notQueried.length ? 2 : problems.length ? 1 : 0;
  if (code === 0) {
    lines.unshift(
      `欠账检查过了：${readable} 份文档里 ${deferrals.length} 句推后的话都带着开着的单号；${done.checked} 份需求.md 都写了怎么算做完${opts.openIssues ? '；开着的 issue 都有需求文档' : ''}。`,
    );
  }
  return { code, lines };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
