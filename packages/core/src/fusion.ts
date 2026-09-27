// Fusion 工作流要的纯判断（docs/decisions/0003-fusion-flow.md 第 5、7、9、13 条；specs/214-Fusion工作流/）：开工前流程配置
// 能不能用、这张单用哪套、每一步派哪几个模型；Lead 交回的方案、最终审查收不收；PR 正文和关单评论写什么。
// 读库、读仓、写 GitHub 是外壳的事（引擎的 workflows/fusion.ts 经 decide 调这里，结果进历史）。读不到、认不出一律明说，
// 不拿空的、0、默认值顶。
import { z } from 'zod';
import { type Brief, checkBrief } from './brief.ts';
import { CATEGORIES, type Category, type FlowConfig, ProfileSchema, profileFor } from './config.ts';
import type { Mode } from './flow.ts';
import { type FlowReplica, replicaVerdict } from './replica.ts';
import type { VerifyReport } from './verdict.ts';

// ---- 开工前：流程配置

/** 外壳读到的流程配置副本（库里 repos 表的 flow_* 列，对账从仓里 .fleet/flow.json 同步来的）。 */
export interface FlowConfigRead {
  /** 副本能不能用要看的几样（同一份判法：replica.ts 的 replicaVerdict）。 */
  replica: FlowReplica;
  /** project = 仓里有自己的 .fleet/flow.json；org_default = 没有，用的全组织默认；从没同步成过是 null。 */
  source: 'project' | 'org_default' | null;
  /** 合并了全组织默认、校验过的整份（config.ts 的 FlowConfig，存成 JSON）；从没同步成过是 null。 */
  config: unknown;
}

/** 副本里存的整份（config.ts 的 FlowConfig）：对账写之前校验过，这里再认一遍，认不出不派，不猜。 */
const StoredConfigSchema = z.object({
  formatVersion: z.number().int(),
  profiles: z.record(z.string().trim().min(1), ProfileSchema),
  categoryProfiles: z.record(z.enum(CATEGORIES), z.string().trim().min(1)),
  bans: z.array(z.object({ id: z.string(), reason: z.string() })),
  testCommand: z.string().optional(),
  sessionMemoryMb: z.number().optional(),
  highRiskPaths: z.array(z.string()),
  uiPaths: z.array(z.string()),
});

export interface FusionSetupInput {
  read: FlowConfigRead;
  /** 判的这一刻（ISO）：副本太久没同步成就停派。 */
  now: string;
  /** 这张单的类别（按类别挑配置）。 */
  category: Category;
  /** 单上临时指定的配置名；不给按类别。 */
  profile?: string | undefined;
  /** 单上（以后引擎按剩余额度自动切）指定的模式；不给按配置里的。 */
  mode?: Mode | undefined;
}

export type FusionSetup =
  | {
      ok: true;
      source: 'project' | 'org_default';
      profile: string;
      mode: Mode;
      /** 每一步的模型顺序（目录里的模型 id）：选路只派这几个模型的路由，按这个先后。 */
      models: { lead: string[]; sidekick: string[]; verify: string[] };
      /** 验证最多几轮（1–2）。 */
      verifyRounds: number;
      /** 算页面代码的路径：改到它们的活按界面类派（GPT 不做界面）。 */
      uiPaths: string[];
      highRiskPaths: string[];
    }
  | { ok: false; why: string };

/**
 * 开工前（收单）看流程配置：副本认不出、从没同步过、太久没同步成、整份认不出、指的配置不存在，一律不派（外壳挂起、报红，
 * 0003 第 9 条「读不到、认不出就这个项目停派、报红，不拿默认顶」）。仓里没有自己的配置时照全组织默认派，source 标出来。
 */
export function setupFusion(input: FusionSetupInput): FusionSetup {
  const now = new Date(input.now);
  if (Number.isNaN(now.getTime())) return { ok: false, why: `判的时刻认不出：${input.now}` };
  const verdict = replicaVerdict(input.read.replica, now);
  if (!verdict.ok) return verdict;
  if (input.read.source === null) {
    return { ok: false, why: '流程配置副本记着同步过，却没记读自仓里还是全组织默认：认不出，不派' };
  }
  const parsed = StoredConfigSchema.safeParse(input.read.config);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '整份'} ${i.message}`)
      .join('；');
    return { ok: false, why: `流程配置副本里的整份认不出（${where}）：不派` };
  }
  const config = parsed.data as FlowConfig;
  const picked = profileFor(config, input.category, input.profile);
  if (!picked.ok) return { ok: false, why: `流程配置：${picked.why}` };
  const p = picked.profile;
  return {
    ok: true,
    source: input.read.source,
    profile: picked.name,
    mode: input.mode ?? p.mode,
    models: { lead: [...p.steps.lead], sidekick: [...p.steps.sidekick], verify: [...p.steps.verify] },
    verifyRounds: p.verify.rounds,
    uiPaths: [...config.uiPaths],
    highRiskPaths: [...config.highRiskPaths],
  };
}

// ---- Lead 交回的方案和任务简报（第 2 步）

/** 需求文档目录下的三份（需求、方案、结果随 PR 进仓，0003 第 13 条；specs/191-Fusion第一步/方案.md 4.3 第 2 条）。 */
export const SPEC_FILES = { requirement: '需求.md', plan: '方案.md', result: '结果.md' } as const;

export function specDocs(specDir: string): { requirement: string; plan: string; result: string } {
  const dir = specDir.trim().replace(/\/+$/, '');
  return {
    requirement: `${dir}/${SPEC_FILES.requirement}`,
    plan: `${dir}/${SPEC_FILES.plan}`,
    result: `${dir}/${SPEC_FILES.result}`,
  };
}

const text = z.string().trim().min(1);
const commit = z.string().trim().min(7);

export const LeadPlanSchema = z.object({
  /** 写完方案、提交之后工作树的头。 */
  head: commit,
  /** 这一步提交改到的文件（引擎从提交里读）。 */
  changedFiles: z.array(z.string()),
  /** 方案摘要：写进 PR 正文和验证材料，几句话。 */
  summary: text.max(2000),
  /** 派给副手的任务简报（brief.ts 的 BriefSchema，这里另判）。 */
  brief: z.unknown(),
  /** 小单：跳过方案评审（第 3 步）。 */
  small: z.boolean(),
  /** 高风险：单模型模式下第 5 步只对它开。 */
  highRisk: z.boolean(),
  /** 会碰的人闸：release 对外发布、spend 花钱、delete 删数据。 */
  holds: z.array(text),
});

export interface LeadPlan {
  head: string;
  changedFiles: string[];
  summary: string;
  brief: Brief;
  small: boolean;
  highRisk: boolean;
  holds: string[];
}

export type LeadPlanCheck = { ok: true; plan: LeadPlan } | { ok: false; problems: string[] };

const issuesOf = (error: z.ZodError, what: string) =>
  error.issues.map((i) => `${what}认不出：${i.path.join('.') || '整份'} ${i.message}`);

/** Lead 第 2 步交回的：方案摘要、任务简报、大小和风险，外加方案.md 真提交了。缺一样都退回 Lead 照原因重写。 */
export function checkLeadPlan(input: { output: unknown; specDir: string }): LeadPlanCheck {
  const parsed = LeadPlanSchema.safeParse(input.output);
  if (!parsed.success) return { ok: false, problems: issuesOf(parsed.error, '方案交回的') };
  const out = parsed.data;
  const problems: string[] = [];
  const brief = checkBrief(out.brief);
  if (!brief.ok) problems.push(...brief.problems.map((p) => `任务简报：${p}`));
  const planPath = specDocs(input.specDir).plan;
  if (!out.changedFiles.includes(planPath)) {
    problems.push(`方案没提交：写进 ${planPath} 并提交（需求、方案、结果随 PR 进仓，引擎不往主线直接写）`);
  }
  if (!brief.ok || problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    plan: {
      head: out.head,
      changedFiles: out.changedFiles,
      summary: out.summary,
      brief: brief.brief,
      small: out.small,
      highRisk: out.highRisk,
      holds: out.holds,
    },
  };
}

// ---- Lead 的最终审查（第 6 步，CI 绿了之后）

export const LeadReviewSchema = z.object({
  verdict: z.enum(['pass', 'fix']),
  why: text,
  /** 过了：做了什么，写进关单评论（1–5 条）。 */
  did: z.array(text).max(5),
  /** 还欠什么（没有就空数组）。 */
  owed: z.array(text),
  head: commit,
  changedFiles: z.array(z.string()),
  /** 要改：给副手的修复简报。 */
  brief: z.unknown().optional(),
});

export type LeadReview =
  | { verdict: 'pass'; why: string; did: string[]; owed: string[]; head: string; changedFiles: string[] }
  | { verdict: 'fix'; why: string; brief: Brief; head: string; changedFiles: string[] };

export type LeadReviewCheck = { ok: true; review: LeadReview } | { ok: false; problems: string[] };

/**
 * Lead 最终审查交回的：过了要写做了什么、结果.md 要在分支上（这一轮或以前提交过）；要改要给一份能派的修复简报。
 * committed = 这张单到现在提交改到过的文件（相对主线）。
 */
export function checkLeadReview(input: {
  output: unknown;
  specDir: string;
  committed: readonly string[];
}): LeadReviewCheck {
  const parsed = LeadReviewSchema.safeParse(input.output);
  if (!parsed.success) return { ok: false, problems: issuesOf(parsed.error, '最终审查交回的') };
  const out = parsed.data;
  if (out.verdict === 'fix') {
    const brief = checkBrief(out.brief);
    if (!brief.ok) return { ok: false, problems: brief.problems.map((p) => `修复简报：${p}`) };
    return {
      ok: true,
      review: {
        verdict: 'fix',
        why: out.why,
        brief: brief.brief,
        head: out.head,
        changedFiles: out.changedFiles,
      },
    };
  }
  const problems: string[] = [];
  if (out.did.length === 0) problems.push('过了却没写做了什么（关单评论照它写）');
  const resultPath = specDocs(input.specDir).result;
  if (!out.changedFiles.includes(resultPath) && !input.committed.includes(resultPath)) {
    problems.push(`结果没提交：写进 ${resultPath} 并提交（随 PR 进仓）`);
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    review: {
      verdict: 'pass',
      why: out.why,
      did: out.did,
      owed: out.owed,
      head: out.head,
      changedFiles: out.changedFiles,
    },
  };
}

// ---- 验证挡住之后给 Lead 看的（第 5 步，Lead 拿证据驳回用）

/** 能驳回的一条：target 照抄（decideVerdict 按原文认），kind 说是哪种挡法。 */
export interface Rebuttable {
  target: string;
  kind: 'not-done' | 'breaks-existing' | 'security' | 'data-loss';
  evidence: string;
}

/** 验证模型交回的里面能挡的几条（没做到的「怎么算做完」和三种发现），原文照抄给 Lead。 */
export function rebuttable(report: VerifyReport): Rebuttable[] {
  const out: Rebuttable[] = [];
  for (const r of report.results) {
    if (r.answer === 'not-done')
      out.push({ target: r.criterion.trim(), kind: 'not-done', evidence: r.evidence.trim() });
  }
  for (const f of report.findings) {
    if (f.kind !== 'suggestion')
      out.push({ target: f.text.trim(), kind: f.kind, evidence: f.evidence.trim() });
  }
  return out;
}

// ---- PR 正文（第 6 步开 PR）

export interface FusionPrFacts {
  mode: Mode;
  /** Lead 写的方案摘要。 */
  planSummary: string;
  /** 这一块交回时的总结（副手或 Lead 交活时 fleet done 写的）。 */
  summary: string;
  /** 交回时报的测试结果（后端核实过：会话里原样跑过测试命令、最后一次绿）。 */
  testsPassed: boolean;
  /** 开 PR 前别家验证写进正文的几行（verdict.ts 的 verificationLines）；没验是 null。 */
  verify: { verified: string[]; owed: string[] } | null;
  highRisk: boolean;
  /** 方案不算小单、方案评审（第 3 步）还没接，这次跳过了。 */
  planReviewSkipped: boolean;
  flowSource: 'project' | 'org_default';
  /** 副手派不出、由 Lead 自己写的原因；副手写的不给。 */
  soloWhy?: string | undefined;
}

export interface FusionPrParts {
  did: string[];
  verified: string[];
  owed: string[];
  tier: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 交活时的总结 → 几条：按换行、分号切，去掉列表记号。 */
export function summaryItems(summary: string, max = 4): string[] {
  return summary
    .split(/\r?\n|；|;/)
    .map((line) => line.replace(/^[\s\-*•]+/, '').trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * PR 正文的几栏（0003 第 13 条：方案摘要、验证结论进 PR 正文）。「做了什么」第一条是方案摘要，其余是交活时的总结；
 * 「怎么验证的」是会话里的测试和开 PR 前别家验证的结论，没验就明说为什么没验；「还欠什么」是验证的看不出和建议，
 * 外加这次没做的（方案评审没接、用的全组织默认配置）。
 */
export function fusionPrParts(f: FusionPrFacts): FusionPrParts {
  const did = [`方案：${oneLine(f.planSummary)}`, ...summaryItems(f.summary)];
  const tests = f.testsPassed
    ? '会话里跑过测试命令，最后一次通过（交活时后端核实过）'
    : '交活时报测试没过（fleet done --tests failed）';
  const verified = [
    tests,
    ...(f.verify ? f.verify.verified : ['开 PR 前别家验证：单模型模式只对高风险的开，这次没验']),
  ];
  if (f.soloWhy) verified.push(`这一块由 Lead 自己写：${oneLine(f.soloWhy)}`);
  const owed = [...(f.verify?.owed ?? [])];
  if (f.planReviewSkipped) owed.push('方案评审（0003 第 5 条第 3 步）引擎还没接，这次跳过（#249）');
  if (f.flowSource === 'org_default') owed.push('这个项目没有 .fleet/flow.json，按全组织默认的流程配置派的');
  const tier = f.highRisk
    ? '先审后合——Lead 判了高风险（合并闸按改动路径判要不要第二意见，这一栏只作说明）'
    : 'CI 绿就合——Lead 判了一般改动（合并闸按改动路径判，这一栏只作说明）';
  return { did, verified, owed, tier };
}

// ---- 关单评论（第 7 步）：改了什么、用时、各模型额度

/** 一个模型在这张单上的用量：读不到的次数另记，不当成 0。 */
export interface ModelUsage {
  model: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** 几次会话没读到 token、没读到花费。 */
  missingTokens: number;
  missingCost: number;
}

export interface CloseFacts {
  prNumber: number;
  mergeCommit: string;
  /** 做了什么（Lead 最终审查写的，两种模式都有）。 */
  did: string[];
  /** 从收单到合并的墙钟时长、其中等人和排队的（毫秒）。 */
  elapsedMs: number;
  offClockMs: number;
  usage: ModelUsage[];
  /** PR 正文「怎么验证的」那几行。 */
  verified: string[];
  owed: string[];
  docs: { requirement: string; plan: string; result: string };
  flowSource: 'project' | 'org_default';
  mode: Mode;
}

function minutes(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '没算成';
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}

function usageLine(u: ModelUsage): string {
  const counted = u.runs - u.missingTokens;
  const tokens =
    counted > 0
      ? `输入 ${u.inputTokens} token、输出 ${u.outputTokens} token${u.missingTokens > 0 ? `（另有 ${u.missingTokens} 次没读到 token）` : ''}`
      : 'token 没读到';
  const paid = u.runs - u.missingCost;
  const cost =
    paid > 0
      ? `花费 $${u.costUsd.toFixed(2)}${u.missingCost > 0 ? `（另有 ${u.missingCost} 次没读到花费）` : ''}`
      : '花费没读到';
  return `- ${u.model}：会话 ${u.runs} 次；${tokens}；${cost}`;
}

/**
 * 关单评论的正文。工作流经 decide 定一次（进历史）再发：关单评论的幂等键带着正文，重试、工人重启都发同一份，
 * 不会因为重写一遍多出一条（#215 杀 Lead 演练靠它）。读不到的用量明说没读到。
 */
export function closeComment(f: CloseFacts): string {
  const lines = [
    `做完了：PR #${f.prNumber} 已合并（合并提交 ${f.mergeCommit.slice(0, 12)}）。`,
    '',
    '**改了什么**：',
    ...(f.did.length ? f.did.map((d) => `- ${oneLine(d)}`) : ['- （没写）']),
    '',
    `**用时**：从收单到合并 ${minutes(f.elapsedMs)}（其中等人、排队 ${minutes(f.offClockMs)}）`,
    '',
    '**各模型额度**：',
    ...(f.usage.length ? f.usage.map(usageLine) : ['- 一次会话结局都没记上：用量没读到（不是没花）']),
    '- 折成额度当量、按步骤汇总进驾驶舱归 #216',
    '',
    '**怎么验证的**：',
    ...(f.verified.length ? f.verified.map((v) => `- ${oneLine(v)}`) : ['- （没写）']),
  ];
  if (f.owed.length) lines.push('', '**还欠什么**：', ...f.owed.map((o) => `- ${oneLine(o)}`));
  lines.push(
    '',
    `需求 ${f.docs.requirement} · 方案 ${f.docs.plan} · 结果 ${f.docs.result}（随 PR 进仓）`,
    `${f.mode === 'single' ? '单模型模式' : 'Fusion 模式'}；流程配置${f.flowSource === 'org_default' ? '用的全组织默认（仓里没有 .fleet/flow.json）' : '读自仓里的 .fleet/flow.json'}`,
  );
  return lines.join('\n');
}
