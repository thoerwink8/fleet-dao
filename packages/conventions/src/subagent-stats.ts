// pnpm subagent:stats [--enforce] [--lift]（单 #2821）：本机子代理护栏的记账和收回，规矩在 agents/subagents/README.md「护栏」。
// 护栏原话：Haiku 一次没过就换 Sonnet；返工率超过 20%，或者有一次错进了 PR，就收回放宽。这里把后半句做成流程：
// - 认 Haiku 改代码的 PR，两条路都认：PR 正文里一行「**写码模型**：claude-haiku-5-5」（pnpm pr:open 读分支上各提交的
//   Co-Authored-By 尾注写的），或 PR 里任一提交带 Co-Authored-By: Claude Haiku … 尾注；
// - 近 30 天合并的 Haiku PR 逐个算：第一次 CI 绿没绿；合并后 7 天内有没有修它的 PR（正文写「修 #<号>」）或 revert 它的 PR；
// - 返工 = 第一次 CI 没绿，或合并后被修/被 revert；错进 = 合并后被修/被 revert（CI 没拦住）；返工率 = 返工 ÷ 查成了的样本；
// - 读不到的写「没查成」带原因：第一次 CI 没查成、也没人修过的 PR 不进返工率的分母，也不当成绿或红；PR 列表读不到整份没查成（退出码 2）；
// - --enforce：返工率超过 20%（样本不少于 5）或错进不少于 1，就把收回写进本机策略文件（~/.fleet-dao/subagent-policy.json，
//   写法见 agents/hooks/subagent-ledger.mjs），pretool 钩子读到它就拦「general-purpose 加 model haiku」；
// - --lift：恢复；之后 --enforce 只算恢复时刻以后合并的 PR，免得同一批旧 PR 马上又触发。
// gh 通过 Gh 传进来（单测用假回包）；策略文件的读写在 agents/hooks/subagent-ledger.mjs（钩子也用它），按路径动态引，见 bin/subagent-stats.ts。
import { parseArgs } from 'node:util';
import type { Gh } from './pr-arm.ts';

/** 样本不少于几个才按返工率判 */
export const MIN_SAMPLE = 5;
/** 返工率超过这个数就收回 */
export const MAX_REWORK_RATE = 0.2;
/** 看近几天合并的 Haiku PR */
export const WINDOW_DAYS = 30;
/** 合并后几天内有修它的 PR、或 revert 了它，算返工 */
export const REPAIR_DAYS = 7;

const DAY = 24 * 3600 * 1000;

export const STATS_USAGE =
  '用法：pnpm subagent:stats [--enforce | --lift]\n' +
  '  不带参数：读近 30 天 Haiku 改代码的 PR，打出第一次 CI、合并后 7 天内有没有修、返工率，不写任何文件\n' +
  '  --enforce：返工率超过 20%（样本不少于 5）或错进 PR 不少于 1，就把收回写进 ~/.fleet-dao/subagent-policy.json\n' +
  '  --lift：恢复（看过原因之后用；之后只算恢复时刻以后合并的 PR）';

/** 本机策略文件和状态的读写：agents/hooks/subagent-ledger.mjs 的这几个函数（钩子也用） */
export interface PolicyLib {
  readPolicy(
    home: string,
  ): { revoked: boolean; reason?: string; at?: string; liftedAt?: string } | { error: string };
  revokePolicy(home: string, why: { reason: string; at: string }): { written: boolean; already: boolean };
  liftPolicy(home: string, at: string): { lifted: boolean };
  mergeStamp(home: string, patch: Record<string, unknown>): void;
}

// —— 认 Haiku 开的 PR ——

const CLAUDE_TRAILER = /Co-Authored-By:\s*Claude\s+(Haiku|Sonnet|Opus|Fable)(?:\s+(\d+(?:\.\d+)*))?/gi;
const WRITER_COLUMN = /写码模型\s*(?:\*\*)?\s*[：:]\s*(?:\*\*)?\s*([^\n]*)/;

/** 提交全文里的 Co-Authored-By: Claude <档> <版本> 尾注，折成完整型号 id（claude-haiku-5-5），同一个只列一次，按出现顺序。 */
export function writerModelsFromTrailers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CLAUDE_TRAILER)) {
    const id = `claude-${(m[1] ?? '').toLowerCase()}${m[2] ? `-${m[2].replace(/\./g, '-')}` : ''}`;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** PR 正文里「写码模型」那一行（pnpm pr:open 写的）；没有就 undefined。 */
export function writerLine(models: readonly string[]): string | undefined {
  return models.length > 0 ? `**写码模型**：${models.join('、')}` : undefined;
}

/** 一个 PR 的写码模型：正文那一行，加各提交的尾注；两条路各认各的。 */
export function prWriterModels(body: string, commitMessages: readonly string[]): string[] {
  const out: string[] = [];
  const line = WRITER_COLUMN.exec(body)?.[1] ?? '';
  for (const m of line.matchAll(/claude-[a-z0-9.-]+/gi)) {
    const id = m[0].toLowerCase().replace(/\./g, '-');
    if (!out.includes(id)) out.push(id);
  }
  for (const id of writerModelsFromTrailers(commitMessages.join('\n\x1e')))
    if (!out.includes(id)) out.push(id);
  return out;
}

// —— 算 ——

export type Ci = { state: 'green' } | { state: 'red' } | { state: 'unknown'; why: string };
export interface Repair {
  number: number;
  how: '修' | 'revert';
}
export interface PrStat {
  number: number;
  title: string;
  mergedAt: string;
  ci: Ci;
  repairs: Repair[];
  /** 第一次 CI 没绿，或合并后被修、被 revert */
  rework: boolean;
  /** 合并还不满 7 天、暂时没人修：观察期没满 */
  watching: boolean;
}
export interface Stats {
  /** 整份读不到时写明原因；这时 prs 是空的，别当成「没有 Haiku 的 PR」 */
  problem?: string;
  prs: PrStat[];
  /** 读不全的地方（读不到就写明，不当成没有） */
  notes: string[];
  /** 返工率的分母：返工的，加第一次 CI 查成了的 */
  sample: number;
  reworked: number;
  /** 第一次 CI 没查成、也没人修过：不进分母 */
  unknown: number;
  /** 错进：合并后被修或被 revert 的 PR 数 */
  wrongIn: number;
  rate: number | null;
}

interface RawPr {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  headRefName: string;
  mergeOid: string;
  commitMessages: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
function rawPrs(text: string): RawPr[] {
  const v: unknown = JSON.parse(text);
  if (!Array.isArray(v)) throw new Error('回包不是数组');
  return v.map((x: Record<string, unknown>) => {
    if (
      typeof x.number !== 'number' ||
      typeof x.mergedAt !== 'string' ||
      Number.isNaN(Date.parse(x.mergedAt))
    )
      throw new Error(`有一个 PR 的号或合并时间认不出：${JSON.stringify(x).slice(0, 120)}`);
    const mc = x.mergeCommit as Record<string, unknown> | null | undefined;
    return {
      number: x.number,
      title: str(x.title),
      body: str(x.body),
      mergedAt: x.mergedAt,
      headRefName: str(x.headRefName),
      mergeOid: str(mc?.oid),
      commitMessages: [],
    };
  });
}

/**
 * 主线上近 30 天各提交的全文（sha → 全文）：squash 合并的提交全文里带着分支上各提交的 Co-Authored-By 尾注，
 * 认 Haiku 的第二条路读它（gh pr list 带 commits 会超 GitHub 的节点上限）。读不到回原因。
 */
function mainCommitMessages(gh: Gh, since: Date): Map<string, string> | string {
  const r = gh([
    'api',
    `repos/{owner}/{repo}/commits?since=${since.toISOString()}&per_page=100`,
    '--paginate',
    '--jq',
    '.[] | {sha: .sha, message: .commit.message}',
  ]);
  if (r.code !== 0) {
    return `gh api commits 退出码 ${r.code}：${(r.stderr.trim() || '（没说）').replace(/\s+/g, ' ').slice(0, 160)}`;
  }
  const out = new Map<string, string>();
  try {
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      const v = JSON.parse(line) as { sha?: unknown; message?: unknown };
      if (typeof v.sha === 'string' && typeof v.message === 'string') out.set(v.sha.toLowerCase(), v.message);
    }
  } catch (e) {
    return `提交列表的回包读不懂：${e instanceof Error ? e.message : String(e)}`;
  }
  return out;
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const SUPERSEDED = new Set(['cancelled', 'skipped', 'neutral', 'stale']);

/** 分支上第一次 CI（工作流 ci，pull_request 触发，按创建时间最早的、不算被取消顶掉的）绿没绿 */
function firstCi(gh: Gh, branch: string): Ci {
  if (!branch) return { state: 'unknown', why: 'PR 没有分支名' };
  const r = gh([
    'run',
    'list',
    '--branch',
    branch,
    '--workflow',
    'ci',
    '--event',
    'pull_request',
    '--limit',
    '30',
    '--json',
    'databaseId,status,conclusion,createdAt',
  ]);
  if (r.code !== 0) {
    return {
      state: 'unknown',
      why: `gh run list 退出码 ${r.code}：${(r.stderr.trim() || '（没说）').replace(/\s+/g, ' ').slice(0, 120)}`,
    };
  }
  let runs: { status?: unknown; conclusion?: unknown; createdAt?: unknown }[];
  try {
    const v: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(v)) throw new Error('不是数组');
    runs = v;
  } catch (e) {
    return { state: 'unknown', why: `运行列表的回包读不懂：${e instanceof Error ? e.message : String(e)}` };
  }
  if (runs.length === 0)
    return { state: 'unknown', why: `分支 ${branch} 没有 ci 的运行记录（分支删了、或运行记录过期）` };
  const sorted = [...runs].sort((a, b) => Date.parse(str(a.createdAt)) - Date.parse(str(b.createdAt)));
  for (const run of sorted) {
    if (run.status !== 'completed') return { state: 'unknown', why: '最早的一轮 CI 还没跑完' };
    const c = str(run.conclusion);
    if (c === 'success') return { state: 'green' };
    if (FAILED.has(c)) return { state: 'red' };
    if (!SUPERSEDED.has(c)) return { state: 'unknown', why: `最早的一轮 CI 结论认不出（${c || '空'}）` };
  }
  return { state: 'unknown', why: '各轮 CI 都是取消或跳过，没有能当「第一次」的' };
}

/** 合并后 7 天内修了它、或 revert 了它的 PR */
function repairsOf(h: RawPr, all: readonly RawPr[]): Repair[] {
  const from = Date.parse(h.mergedAt);
  const to = from + REPAIR_DAYS * DAY;
  const ref = new RegExp(`#${h.number}(?!\\d)`);
  const fix = new RegExp(`修\\s*#${h.number}(?!\\d)`);
  const out: Repair[] = [];
  for (const p of all) {
    const at = Date.parse(p.mergedAt);
    if (p.number === h.number || !(at > from && at <= to)) continue;
    const revertedSha = /revert(?:s|ed)?\s+commit\s+([0-9a-f]{7,40})/i.exec(p.body)?.[1]?.toLowerCase();
    const isRevert =
      (/revert/i.test(p.title) && ref.test(`${p.title}\n${p.body}`)) ||
      (revertedSha !== undefined &&
        h.mergeOid !== '' &&
        (h.mergeOid.toLowerCase().startsWith(revertedSha) ||
          revertedSha.startsWith(h.mergeOid.toLowerCase())));
    if (isRevert) out.push({ number: p.number, how: 'revert' });
    else if (fix.test(`${p.title}\n${p.body}`)) out.push({ number: p.number, how: '修' });
  }
  return out;
}

export interface CollectOpts {
  gh: Gh;
  now: Date;
  /** 只算这个时刻以后合并的（恢复之后用） */
  since?: Date | undefined;
}

/** 读近 30 天合并的 PR，挑出 Haiku 的，逐个算。 */
export async function collectStats({ gh, now, since }: CollectOpts): Promise<Stats> {
  const empty: Stats = { prs: [], notes: [], sample: 0, reworked: 0, unknown: 0, wrongIn: 0, rate: null };
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * DAY);
  const r = gh([
    'pr',
    'list',
    '--state',
    'merged',
    '--search',
    `merged:>=${windowStart.toISOString().slice(0, 10)}`,
    '--limit',
    '500',
    '--json',
    'number,title,body,mergedAt,headRefName,mergeCommit',
  ]);
  if (r.code !== 0) {
    return {
      ...empty,
      problem: `读不到合并的 PR 列表（gh pr list 退出码 ${r.code}：${(r.stderr.trim() || '（没说）').replace(/\s+/g, ' ').slice(0, 200)}）`,
    };
  }
  let all: RawPr[];
  try {
    all = rawPrs(r.stdout);
  } catch (e) {
    return { ...empty, problem: `PR 列表的回包读不懂：${e instanceof Error ? e.message : String(e)}` };
  }
  const notes: string[] = [];
  const msgs = mainCommitMessages(gh, windowStart);
  if (typeof msgs === 'string') {
    notes.push(
      `没查成：读不到主线提交的尾注（${msgs}），这次只按 PR 正文里「写码模型」那一行认 Haiku 的 PR，可能漏掉只靠尾注认的`,
    );
  } else {
    for (const p of all) {
      const m = msgs.get(p.mergeOid.toLowerCase());
      if (m !== undefined) p.commitMessages = [m];
    }
  }
  const from = Math.max(windowStart.getTime(), since?.getTime() ?? 0);
  const haiku = all
    .filter((p) => Date.parse(p.mergedAt) >= from && Date.parse(p.mergedAt) > (since?.getTime() ?? 0))
    .filter((p) => prWriterModels(p.body, p.commitMessages).some((m) => /haiku/i.test(m)))
    .sort((a, b) => a.number - b.number);
  const prs: PrStat[] = haiku.map((h) => {
    const repairs = repairsOf(h, all);
    const ci = firstCi(gh, h.headRefName);
    return {
      number: h.number,
      title: h.title,
      mergedAt: h.mergedAt,
      ci,
      repairs,
      rework: ci.state === 'red' || repairs.length > 0,
      watching: repairs.length === 0 && Date.parse(h.mergedAt) + REPAIR_DAYS * DAY > now.getTime(),
    };
  });
  const sample = prs.filter((p) => p.rework || p.ci.state !== 'unknown').length;
  const reworked = prs.filter((p) => p.rework).length;
  return {
    prs,
    notes,
    sample,
    reworked,
    unknown: prs.length - sample,
    wrongIn: prs.filter((p) => p.repairs.length > 0).length,
    rate: sample > 0 ? reworked / sample : null,
  };
}

/** 触发收回的理由（没触发是空数组） */
export function revokeReasons(s: Stats): string[] {
  const out: string[] = [];
  const wrong = s.prs.filter((p) => p.repairs.length > 0);
  if (wrong.length >= 1) {
    out.push(
      `错进 PR ${wrong.length} 个（${wrong.map((p) => `#${p.number} 被 ${p.repairs.map((r) => `#${r.number}（${r.how}）`).join('、')} 处理`).join('；')}）`,
    );
  }
  if (s.rate !== null && s.sample >= MIN_SAMPLE && s.rate > MAX_REWORK_RATE) {
    out.push(
      `返工率 ${Math.round(s.rate * 100)}%（${s.reworked}/${s.sample}，样本不少于 ${MIN_SAMPLE}、上限 ${MAX_REWORK_RATE * 100}%）`,
    );
  }
  return out;
}

function report(s: Stats, now: Date): string[] {
  const lines = [`近 ${WINDOW_DAYS} 天合并的 Haiku 改代码的 PR：${s.prs.length} 个`];
  for (const p of s.prs) {
    const ci = p.ci.state === 'green' ? '绿' : p.ci.state === 'red' ? '红' : `没查成（${p.ci.why}）`;
    const fixed =
      p.repairs.length > 0
        ? p.repairs.map((r) => `#${r.number}（${r.how}）`).join('、')
        : p.watching
          ? `无（观察期还没满 ${REPAIR_DAYS} 天）`
          : '无';
    lines.push(
      `  #${p.number} 合于 ${p.mergedAt.slice(0, 10)}｜第一次 CI：${ci}｜合并后 ${REPAIR_DAYS} 天内被修或 revert：${fixed}｜${p.rework ? '返工' : '没返工'}`,
    );
  }
  const rate =
    s.rate === null
      ? '没算出（没有查成的样本）'
      : `${Math.round(s.rate * 100)}%（${s.reworked}/${s.sample}）`;
  for (const n of s.notes) lines.push(n);
  lines.push(`返工率：${rate}；第一次 CI 没查成且没人修过、不进分母的：${s.unknown} 个`);
  lines.push(`错进 PR（合并后被修或 revert）：${s.wrongIn} 个`);
  lines.push(
    `收回条件：返工率超过 ${MAX_REWORK_RATE * 100}%（样本不少于 ${MIN_SAMPLE}），或错进 PR 不少于 1（统计时刻 ${now.toISOString()}）`,
  );
  return lines;
}

export interface StatsDeps {
  gh: Gh;
  now: () => Date;
  /** 本机状态目录（~/.fleet-dao） */
  home: string;
  policy: PolicyLib;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 退出码：0 算完了（--enforce 触没触发都是 0）；1 参数不对；2 没查成（读不到 PR 列表、策略文件读不懂……）。 */
export async function subagentStats(argv: string[], deps: StatsDeps): Promise<number> {
  const { gh, home, policy, out, err } = deps;
  let values: { enforce?: boolean; lift?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        enforce: { type: 'boolean' },
        lift: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}\n${STATS_USAGE}`);
    return 1;
  }
  if (values.help) {
    out(STATS_USAGE);
    return 0;
  }
  if (values.enforce && values.lift) {
    err(`--enforce 和 --lift 只能给一个。\n${STATS_USAGE}`);
    return 1;
  }
  const now = deps.now();
  try {
    if (values.lift) {
      const r = policy.liftPolicy(home, now.toISOString());
      out(
        r.lifted
          ? '已恢复 Haiku 改代码；之后 --enforce 只算现在以后合并的 PR。'
          : '本来就没收回；已记下恢复时刻（之后 --enforce 只算现在以后合并的 PR）。',
      );
      return 0;
    }
    const pol = policy.readPolicy(home);
    if ('error' in pol) {
      err(`没查成：${pol.error}`);
      if (values.enforce)
        policy.mergeStamp(home, {
          at: now.toISOString(),
          ok: false,
          report: `subagent:stats --enforce 没跑成：${pol.error}`,
        });
      return 2;
    }
    const s = await collectStats({ gh, now, since: pol.liftedAt ? new Date(pol.liftedAt) : undefined });
    if (s.problem !== undefined) {
      err(`没查成：${s.problem}。没有改策略文件。`);
      if (values.enforce)
        policy.mergeStamp(home, {
          at: now.toISOString(),
          ok: false,
          report: `subagent:stats --enforce 没跑成：${s.problem}`,
        });
      return 2;
    }
    for (const l of report(s, now)) out(l);
    if (!values.enforce) return 0;
    const reasons = revokeReasons(s);
    if (reasons.length === 0) {
      out('没触发收回：Haiku 改代码照旧按 README 的三条给。');
      policy.mergeStamp(home, { at: now.toISOString(), ok: true, report: null });
      return 0;
    }
    const reason = reasons.join('；');
    const w = policy.revokePolicy(home, { reason, at: now.toISOString() });
    if (w.already) {
      out(
        `触发收回（${reason}），但早已收回着、不覆盖第一次的原因（看 ~/.fleet-dao/subagent-policy.json）。`,
      );
      policy.mergeStamp(home, { at: now.toISOString(), ok: true, report: null });
    } else {
      out(
        `已收回 Haiku 改代码：${reason}。写进了本机策略文件，pretool 钩子从现在起拦「general-purpose 加 model haiku」，提示改派 Sonnet。`,
      );
      policy.mergeStamp(home, {
        at: now.toISOString(),
        ok: true,
        report: `Haiku 改代码已收回：${reason}（恢复：pnpm subagent:stats --lift）`,
      });
    }
    return 0;
  } catch (e) {
    err(`没做成：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
