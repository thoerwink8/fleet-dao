// 主线那一轮的「同树复用」（docs/ci-speedup-plan.md 第三轮，创始人 2026-10-03「全程你拍板」）：
// 这次主线提交的 git tree 和某次已经成功的 PR 检查测的是同一棵树，并且那次检查比的基准树就是「上次主线真绿的头」的树，
// 那么 test、web、deploy 这几个 job 在主线上再跑一遍，测的是同一棵树、同一份改动区间、同一个选择——同树同结果，跳过。
// 判不出来的、对不上的、读不到的一律不复用：这一轮照旧按「上次绿…这次」的区间全跑（main-baseline.ts 那条路），绝不拿它当绿。
//
// 怎么认「某次成功的 PR 检查测的是哪棵树」：PR 那一轮 changes job 里有一步，步骤名带着它检出的合并提交的树和基准树
// （claimStepName：`已测的树 tree=<树> base=<基准树>`），GitHub 的 jobs 接口把这个步骤名原样给出来。PR 的合并提交（refs/pull/N/merge）
// 合并后就没了，所以没法事后从仓里查；步骤名是不用任何写权限就能留下、又能用只读令牌查回来的地方。
// 改这里之前必须知道：
// - 复用的条件是**树相等**，不是提交相等：squash 合并出来的提交和 PR 的合并提交不同、树相同时才算同一棵。
//   两个树都由主线这一轮自己在检出里现算、再和 PR 那一轮报的比，不信 PR 一方报什么就是什么。
// - 基准树对不上不能复用：PR 当时是对另一个基准选的测试（按改动选），区间不一样，选的测试就不一样。
// - 声明只有两处可信来源：PR 的最新一次 ci.yml 运行 conclusion=success（含 check 这个必过 job 成功），且声明在它的 changes job 里、
//   恰好一条。同一步骤名出现 0 条或 2 条以上都不认。
// - 这里判「少跑」等于放行没测过的改动，所以本文件和入口在 high-risk-paths.json 里（先审后合）；
//   判法有测试（test/main-reuse.test.ts），每条「读不到 / 对不上 / 查不到」的路径各有一条故意造出的失败。
import type { GhApi } from './gh-api.ts';

export const CLAIM_PREFIX = '已测的树';
const HEX40 = /^[0-9a-f]{40}$/;
const CLAIM = new RegExp(`^${CLAIM_PREFIX} tree=([0-9a-f]{40}) base=([0-9a-f]{40})$`);
/** 一个 PR 往回看几次成功的运行（同一个头上重跑过的）。 */
const RUN_LOOKBACK = 5;

export interface Reuse {
  /** 被复用的 PR 检查（ci.yml 的 pull_request 运行）。 */
  run: number;
  pr: number;
  tree: string;
  baseTree: string;
}

/** PR 那一轮 changes job 里这一步的名字（ci.yml 里用同一个前缀；test/main-reuse.test.ts 核对两边对得上）。 */
export function claimStepName(tree: string, baseTree: string): string {
  return `${CLAIM_PREFIX} tree=${tree} base=${baseTree}`;
}

/** 一个 job 的步骤名里的声明：恰好一条才回来；没有回 null；有但认不出、或多于一条回一句为什么。 */
export function claimOf(stepNames: readonly string[]): { tree: string; baseTree: string } | null | string {
  const found = stepNames.filter((n) => n.startsWith(CLAIM_PREFIX));
  if (found.length === 0) return null;
  if (found.length > 1) return `声明有 ${found.length} 条，认不准是哪一条`;
  const m = CLAIM.exec(found[0] ?? '');
  if (!m) return `声明的写法认不出：${found[0]}`;
  return { tree: m[1] as string, baseTree: m[2] as string };
}

export type ReuseResult = { reuse: Reuse } | { reuse: null; why: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 主线提交 sha（树 tree），上次真绿的头的树 baseTree：找一次同树、同基准、成功的 PR 检查。
 * 找不到（没有对应的 PR、PR 没成功过、声明对不上）回 { reuse: null, why }；GitHub 读不成、回来的样子认不出就抛，
 * 由调用方记成「没查成」——两者的结果一样（这一轮照旧全跑），只是 why 不同。
 */
export async function findReuse(
  api: GhApi,
  input: { sha: string; tree: string; baseTree: string; workflowFile: string },
): Promise<ReuseResult> {
  const { sha, tree, baseTree, workflowFile } = input;
  for (const [name, v] of [
    ['提交', sha],
    ['树', tree],
    ['基准树', baseTree],
  ] as const) {
    if (!HEX40.test(v)) throw new Error(`${name}认不出（${v}）`);
  }
  const pulls = await api.get(`/commits/${sha}/pulls`);
  if (!Array.isArray(pulls)) throw new Error('提交关联的 PR 列表认不出（不是列表）');
  const mine = pulls.filter(
    (p) =>
      isObj(p) &&
      p.merge_commit_sha === sha &&
      typeof p.merged_at === 'string' &&
      isObj(p.base) &&
      p.base.ref === 'main',
  );
  if (mine.length === 0)
    return { reuse: null, why: `${sha.slice(0, 7)} 不是哪个 PR 合并出来的（直接推的？）` };
  if (mine.length > 1) return { reuse: null, why: `${sha.slice(0, 7)} 对得上 ${mine.length} 个 PR，认不准` };
  const pr = mine[0] as Record<string, unknown>;
  const head = isObj(pr.head) ? pr.head.sha : undefined;
  if (typeof pr.number !== 'number' || typeof head !== 'string' || !HEX40.test(head))
    throw new Error('PR 读回来认不出（没有 number 或 head.sha）');

  const runs = await api.get(
    `/actions/workflows/${workflowFile}/runs?event=pull_request&head_sha=${head}&status=success&per_page=${RUN_LOOKBACK}`,
  );
  const list = isObj(runs) ? runs.workflow_runs : undefined;
  if (!Array.isArray(list)) throw new Error('PR 的检查运行列表认不出（没有 workflow_runs）');
  const good = list.filter(
    (r): r is Record<string, unknown> =>
      isObj(r) &&
      r.head_sha === head &&
      r.event === 'pull_request' &&
      r.conclusion === 'success' &&
      typeof r.id === 'number',
  );
  if (good.length === 0)
    return {
      reuse: null,
      why: `PR #${pr.number} 的头 ${head.slice(0, 7)} 上没有成功的 ${workflowFile} 运行`,
    };

  const why: string[] = [];
  for (const r of good.slice(0, RUN_LOOKBACK)) {
    const id = r.id as number;
    const body = await api.get(`/actions/runs/${id}/jobs?filter=latest&per_page=100`);
    const jobs = isObj(body) ? body.jobs : undefined;
    if (!Array.isArray(jobs)) throw new Error(`运行 ${id} 的 job 列表认不出（没有 jobs）`);
    const named = (n: string) => jobs.filter((j): j is Record<string, unknown> => isObj(j) && j.name === n);
    const check = named('check');
    if (check.length !== 1 || check[0]?.conclusion !== 'success') {
      why.push(`运行 ${id}：check 不是恰好一个成功的 job`);
      continue;
    }
    const changes = named('changes');
    if (changes.length !== 1 || changes[0]?.conclusion !== 'success') {
      why.push(`运行 ${id}：changes 不是恰好一个成功的 job`);
      continue;
    }
    const steps = changes[0]?.steps;
    if (!Array.isArray(steps)) throw new Error(`运行 ${id} 的 changes job 没有步骤列表`);
    const claim = claimOf(steps.map((s) => (isObj(s) && typeof s.name === 'string' ? s.name : '')));
    if (claim === null) {
      why.push(`运行 ${id}：changes 里没有「${CLAIM_PREFIX}」声明（这一轮是声明上线之前跑的？）`);
      continue;
    }
    if (typeof claim === 'string') {
      why.push(`运行 ${id}：${claim}`);
      continue;
    }
    if (claim.tree !== tree) {
      why.push(
        `运行 ${id}：测的树 ${claim.tree.slice(0, 7)} 不是这次主线的树 ${tree.slice(0, 7)}（合并前主线又动过）`,
      );
      continue;
    }
    if (claim.baseTree !== baseTree) {
      why.push(
        `运行 ${id}：比的基准树 ${claim.baseTree.slice(0, 7)} 不是上次主线真绿的头的树 ${baseTree.slice(0, 7)}（中间插了别的提交，选的测试区间不同）`,
      );
      continue;
    }
    return { reuse: { run: id, pr: pr.number, tree, baseTree } };
  }
  return { reuse: null, why: `PR #${pr.number} 没有同树同基准的成功运行：${why.join('；')}` };
}

/** 工作流 outputs 里 reuse 那一行（JSON）：认出来是 Reuse 才回，别的（空、坏 JSON、字段不对）回 null——调用方照旧全跑。 */
export function parseReuse(text: string | undefined): Reuse | null {
  if (text === undefined || text.trim() === '') return null;
  try {
    return reuseOf(JSON.parse(text));
  } catch {
    return null;
  }
}

/** 一个已经解析出来的值是不是齐全的 Reuse（汇总 job 核 plan 里的 reused 也用它）；认不出回 null。 */
export function reuseOf(v: unknown): Reuse | null {
  if (
    !isObj(v) ||
    typeof v.run !== 'number' ||
    !Number.isInteger(v.run) ||
    v.run <= 0 ||
    typeof v.pr !== 'number' ||
    !Number.isInteger(v.pr) ||
    v.pr <= 0 ||
    typeof v.tree !== 'string' ||
    !HEX40.test(v.tree) ||
    typeof v.baseTree !== 'string' ||
    !HEX40.test(v.baseTree)
  )
    return null;
  return { run: v.run, pr: v.pr, tree: v.tree, baseTree: v.baseTree };
}
