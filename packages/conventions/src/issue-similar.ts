// 开单先查旧单（#995 拍 3，决定 0020 第 3 条）：pnpm issue:new 开单时，按标题关键词和「已知的模块」里的路径，
// 查同仓开着的单和最近合并的 PR，把可能重复的列给建单的人看。只提示、不拦：开单照开，列出来的在开单结果后面打印。
// 为什么：同一个根被反复开单（「偶发超时」一族、「起子代理前取远端」四张、「残留清理」三处各一遍），建单那一步没人问「这事有没有人做过」。
// 怎么认「像」：标题的关键词（英文单词、中文两字词）和单子正文里写的文件路径。两边标题的 Dice 系数，加上共同提到的路径
// （每个 0.3，最多算两个），到 THRESHOLD 才列；最多列 SHOWN 条。纯字面比对，不调模型：误报多一条无所谓，漏掉的靠人。
// 改这里之前必须知道：
// - 读不到 GitHub 不拦开单，但也不当成「没有重复」：结果里写明「没查成」和原因，由入口打印出来。
// - 候选只读一个窗口：开着的单全读（翻页上限 MAX_ISSUE_PAGES），合并了的 PR 读最近更新的 PULL_PAGES 页。
// - 测试在 test/issue-similar.test.ts。
import type { Gh } from './issue-new.ts';

/** 一条可能重复的：号、标题、是开着的单还是合并了的 PR、为什么像（给人看的一句话）。 */
export interface SimilarItem {
  number: number;
  title: string;
  kind: 'issue' | 'pull';
  score: number;
  why: string;
}

export interface SimilarReport {
  found: SimilarItem[];
  /** 没查成的原因（读不到 GitHub、读回来认不出）；有它就不能把 found 为空当成没有重复。 */
  unchecked?: string;
}

/** 候选：开着的单或合并了的 PR 的标题和正文。 */
export interface Candidate {
  number: number;
  title: string;
  body: string;
  kind: 'issue' | 'pull';
}

const THRESHOLD = 0.45;
const SHOWN = 5;
const PATH_WEIGHT = 0.3;
const PATH_CAP = 2;
const PAGE = 100;
const MAX_ISSUE_PAGES = 10;
const PULL_PAGES = 2;

/** 凑不成关键词的常见字：含它们的两字词（「没有」「一个」……）满篇都是，不拿来比。 */
const NOISE_CHARS = new Set([...'的了是在和与把被要不有没一个它这那可能会就都也还么及或']);

/** 标题（或正文）里的关键词：英文单词（三个字符以上）、中文相邻两字词。 */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)) out.add(m[0].replace(/[.-]+$/, ''));
  for (const run of lower.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const a = run[i] as string;
      const b = run[i + 1] as string;
      if (!NOISE_CHARS.has(a) && !NOISE_CHARS.has(b)) out.add(a + b);
    }
  }
  return out;
}

/** 正文里写的文件路径（packages/…、agents/…、docs/…、specs/…、deploy/…、.github/…）；带目录的路径再多记它所在的目录。 */
export function modulePaths(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /(?<![\w/.-])((?:packages|agents|docs|specs|deploy|scripts|\.github)\/[\w./-]*\w)/g,
  )) {
    const path = (m[1] as string).replace(/\/+$/, '');
    out.add(path);
    const parts = path.split('/');
    if (parts.length >= 4 && /\.\w{1,5}$/.test(parts[parts.length - 1] as string)) {
      out.add(parts.slice(0, -1).join('/'));
    }
  }
  return out;
}

function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): { score: number; shared: string[] } {
  if (a.size === 0 || b.size === 0) return { score: 0, shared: [] };
  const shared = [...a].filter((k) => b.has(k));
  return { score: (2 * shared.length) / (a.size + b.size), shared };
}

/** 新单（标题加正文）和候选比，列出像的，按像的程度从高到低，最多 SHOWN 条。 */
export function rankSimilar(
  query: { title: string; body: string },
  candidates: readonly Candidate[],
): SimilarItem[] {
  const titleWords = keywords(query.title);
  const paths = modulePaths(`${query.title}\n${query.body}`);
  const items: SimilarItem[] = [];
  for (const c of candidates) {
    const t = dice(titleWords, keywords(c.title));
    const theirs = modulePaths(`${c.title}\n${c.body}`);
    const both = [...paths].filter((p) => theirs.has(p));
    // 共同的文件所在的目录不再单算一个（同一处不算两次）
    const sharedPaths = both.filter((p) => !both.some((q) => q !== p && q.startsWith(`${p}/`)));
    const score = t.score + PATH_WEIGHT * Math.min(sharedPaths.length, PATH_CAP);
    if (score < THRESHOLD) continue;
    const reasons = [
      ...(t.shared.length > 0 ? [`标题里都有「${t.shared.slice(0, 4).join('」「')}」`] : []),
      ...(sharedPaths.length > 0 ? [`都提到 ${sharedPaths.slice(0, 2).join('、')}`] : []),
    ];
    items.push({ number: c.number, title: c.title, kind: c.kind, score, why: reasons.join('；') });
  }
  return items.sort((x, y) => y.score - x.score || x.number - y.number).slice(0, SHOWN);
}

/** 读候选：开着的单、最近更新的合并了的 PR。读不到、认不出抛 Error（由 similarIssues 记成没查成）。 */
async function readCandidates(gh: Gh): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (let page = 1; ; page += 1) {
    if (page > MAX_ISSUE_PAGES) throw new Error(`开着的单超过 ${MAX_ISSUE_PAGES * PAGE} 张，没读全`);
    const rows = await readList(
      gh,
      `repos/{owner}/{repo}/issues?state=open&per_page=${PAGE}&page=${page}`,
      '开着的单',
    );
    for (const r of rows) {
      const { number, title, body } = fields(r, '开着的单');
      if (!('pull_request' in r)) out.push({ number, title, body, kind: 'issue' });
    }
    if (rows.length < PAGE) break;
  }
  for (let page = 1; page <= PULL_PAGES; page += 1) {
    const rows = await readList(
      gh,
      `repos/{owner}/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PAGE}&page=${page}`,
      '最近关掉的 PR',
    );
    for (const r of rows) {
      const { number, title, body } = fields(r, '最近关掉的 PR');
      if (!('merged_at' in r)) throw new Error(`读最近关掉的 PR，#${number} 认不出（没有 merged_at）`);
      if (typeof r.merged_at === 'string') out.push({ number, title, body, kind: 'pull' });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

async function readList(gh: Gh, path: string, what: string): Promise<Record<string, unknown>[]> {
  const r = await gh(['api', path]);
  if (r.code !== 0) {
    throw new Error(
      `读${what}失败（退出码 ${r.code}）：${(r.stderr.trim() || r.stdout.trim() || 'gh 什么也没说').replace(/\s+/g, ' ')}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new Error(`读${what}，读回来的不是 JSON`);
  }
  if (!Array.isArray(data) || data.some((x) => typeof x !== 'object' || x === null || Array.isArray(x))) {
    throw new Error(`读${what}，读回来的不是列表`);
  }
  return data as Record<string, unknown>[];
}

function fields(r: Record<string, unknown>, what: string): { number: number; title: string; body: string } {
  if (
    typeof r.number !== 'number' ||
    typeof r.title !== 'string' ||
    (r.body !== null && typeof r.body !== 'string')
  ) {
    throw new Error(`读${what}，有一条认不出（number、title、body）`);
  }
  return { number: r.number, title: r.title, body: r.body ?? '' };
}

/** 开单前查一遍：永远不抛、不拦；读不到就把原因放进 unchecked。 */
export async function similarIssues(gh: Gh, query: { title: string; body: string }): Promise<SimilarReport> {
  let candidates: Candidate[];
  try {
    candidates = await readCandidates(gh);
  } catch (e) {
    return { found: [], unchecked: e instanceof Error ? e.message : String(e) };
  }
  return { found: rankSimilar(query, candidates) };
}

/** 给人看的几行；没有可说的返回空数组。number 是刚开出来的新单（给「是重复就这么关」那句用）。 */
export function renderSimilar(report: SimilarReport, number: number): string[] {
  if (report.unchecked !== undefined) {
    return [`没查成「有没有重复的单」：${report.unchecked}。单照开了，请自己去 GitHub 搜一下同类的单和 PR。`];
  }
  if (report.found.length === 0) return [];
  return [
    `可能重复的（按标题关键词和提到的路径比的，只是提示，单已经开了）：`,
    ...report.found.map(
      (s) => `  #${s.number}（${s.kind === 'issue' ? '开着的单' : '已合并的 PR'}）${s.title}：${s.why}`,
    ),
    `是重复的话：pnpm issue:close ${number} --reason duplicate --note "重复 #<号>"；不是就不用管。动手前先读上面的单和 PR（同模块的历史在 specs/ 和那张单的 Refs 里）。`,
  ];
}
