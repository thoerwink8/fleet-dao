// 流程配置（docs/decisions/0003-fusion-flow.md 第 9 条）：每一步用哪些模型、按什么顺序，讨论评审验证几家几轮。
// fleet-dao 放一份全组织默认（packages/core/flow.default.json），各项目仓里 .fleet/flow.json 只写和它不同的；
// 禁令只能写在全组织默认里，项目改不掉。读文件是外壳的事，这里只判：
// 全组织默认读不到、认不出 = 全部停派；项目的读不到、认不出 = 这个项目停派、报红——都不拿默认顶。
import { HARD_BANS } from '@fleet-dao/shared';
import { z } from 'zod';

/** 引擎认的格式版本：当前和上一版（第一版之前没有上一版）。 */
export const FORMAT_VERSION = 1;
export const SUPPORTED_FORMATS: readonly number[] = [1];

/** 项目仓里的配置文件；全组织默认在 fleet-dao 的这个位置。 */
export const PROJECT_CONFIG_PATH = '.fleet/flow.json';
export const ORG_DEFAULT_PATH = 'packages/core/flow.default.json';

export const CATEGORIES = ['需求', '缺陷', '杂项'] as const;
export type Category = (typeof CATEGORIES)[number];

const modelList = z.array(z.string().trim().min(1));
const repoPath = z
  .string()
  .trim()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'),
    '要写仓里的相对路径',
  );

export const ProfileSchema = z
  .object({
    /** fusion = Lead 带副手；single = 单模型模式（第 2、4 步同一个模型，第 3 步关，第 5 步只对高风险开）。 */
    mode: z.enum(['fusion', 'single']).default('fusion'),
    /** 每一步的模型顺序：前一个没额度、连不上就换下一个。 */
    steps: z
      .object({
        lead: modelList.min(1),
        sidekick: modelList,
        review: modelList,
        verify: modelList,
        discuss: modelList,
      })
      .strict(),
    review: z
      .object({ vendors: z.number().int().min(0).max(3), rounds: z.number().int().min(1).max(2) })
      .strict(),
    verify: z.object({ rounds: z.number().int().min(1).max(2) }).strict(),
    discuss: z
      .object({ vendors: z.number().int().min(1).max(5), rounds: z.number().int().min(1).max(10) })
      .strict(),
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;

const BanSchema = z.object({ id: z.string().trim().min(1), reason: z.string().trim().min(1) }).strict();

const optionalFields = {
  /** 交活核对跑的测试命令（只跑改动影响到的）。 */
  testCommand: z.string().trim().min(1).optional(),
  /** 一个干活会话的内存上限（MB）。 */
  sessionMemoryMb: z.number().int().positive().optional(),
  /** 高风险路径：单模型模式下第 5 步只对碰到它们的开。以 / 结尾的是目录。 */
  highRiskPaths: z.array(repoPath).optional(),
  /** 算页面代码的路径：改到它们的活不派给 GPT。 */
  uiPaths: z.array(repoPath).optional(),
};

export const OrgConfigSchema = z
  .object({
    说明: z.string().optional(),
    formatVersion: z.number().int(),
    profiles: z.record(z.string().trim().min(1), ProfileSchema),
    categoryProfiles: z.record(z.enum(CATEGORIES), z.string().trim().min(1)),
    bans: z.array(BanSchema),
    ...optionalFields,
  })
  .strict();

export const ProjectConfigSchema = z
  .object({
    说明: z.string().optional(),
    formatVersion: z.number().int(),
    /** 整套加上或整套换掉同名的。 */
    profiles: z.record(z.string().trim().min(1), ProfileSchema).optional(),
    categoryProfiles: z.partialRecord(z.enum(CATEGORIES), z.string().trim().min(1)).optional(),
    ...optionalFields,
  })
  .strict();

export interface FlowConfig {
  formatVersion: number;
  profiles: Record<string, Profile>;
  categoryProfiles: Record<Category, string>;
  bans: { id: string; reason: string }[];
  testCommand?: string;
  sessionMemoryMb?: number;
  highRiskPaths: string[];
  uiPaths: string[];
}

/** 外壳读文件的结果：读到了、文件不在、在却读不了。 */
export type Source =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: string };

export type ConfigDecision =
  | { ok: true; config: FlowConfig; usedOrgDefault: boolean }
  | { ok: false; scope: 'org' | 'project'; why: string };

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; why: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, why: `不是 JSON（${e instanceof Error ? e.message : String(e)}）` };
  }
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const where = i.path.join('.') || '整份';
      if (i.code === 'unrecognized_keys' && i.keys.includes('bans'))
        return '禁令只能写在全组织默认里，项目改不掉';
      return `${where}：${i.message}`;
    })
    .join('；');
}

const FABLE = /fable/i;

/** 合并后再查一遍：类别指的配置要在，禁令不能少，配置里不许出现禁用的模型。 */
function checkMerged(config: FlowConfig): string | undefined {
  for (const c of CATEGORIES) {
    const name = config.categoryProfiles[c];
    if (!config.profiles[name]) return `「${c}」用的配置「${name}」不存在`;
  }
  const banIds = new Set(config.bans.map((b) => b.id));
  const lost = HARD_BANS.filter((b) => !banIds.has(b.id)).map((b) => b.id);
  if (lost.length) return `全组织默认少了写死的禁令：${lost.join('、')}`;
  for (const [name, p] of Object.entries(config.profiles)) {
    for (const [step, models] of Object.entries(p.steps)) {
      const banned = models.find((m) => FABLE.test(m));
      if (banned) return `配置「${name}」的 ${step} 用了禁用的模型 ${banned}（不用 Fable）`;
    }
  }
  return undefined;
}

export function resolveFlowConfig(org: Source, project: Source): ConfigDecision {
  const orgFail = (why: string): ConfigDecision => ({ ok: false, scope: 'org', why: `全组织默认：${why}` });
  const projectFail = (why: string): ConfigDecision => ({
    ok: false,
    scope: 'project',
    why: `项目配置 ${PROJECT_CONFIG_PATH}：${why}`,
  });

  if (org.kind === 'missing') return orgFail(`找不到 ${ORG_DEFAULT_PATH}`);
  if (org.kind === 'unreadable') return orgFail(`读不了（${org.error}）`);
  const orgJson = parseJson(org.text);
  if (!orgJson.ok) return orgFail(orgJson.why);
  const orgParsed = OrgConfigSchema.safeParse(orgJson.value);
  if (!orgParsed.success) return orgFail(issues(orgParsed.error));
  if (!SUPPORTED_FORMATS.includes(orgParsed.data.formatVersion)) {
    return orgFail(`格式版本 ${orgParsed.data.formatVersion} 认不出（认 ${SUPPORTED_FORMATS.join('、')}）`);
  }
  const base = orgParsed.data;
  const merged: FlowConfig = {
    formatVersion: base.formatVersion,
    profiles: { ...base.profiles },
    categoryProfiles: { ...(base.categoryProfiles as Record<Category, string>) },
    bans: base.bans,
    ...(base.testCommand !== undefined ? { testCommand: base.testCommand } : {}),
    ...(base.sessionMemoryMb !== undefined ? { sessionMemoryMb: base.sessionMemoryMb } : {}),
    highRiskPaths: base.highRiskPaths ?? [],
    uiPaths: base.uiPaths ?? [],
  };
  const orgProblem = checkMerged(merged);
  if (orgProblem) return orgFail(orgProblem);

  if (project.kind === 'missing') return { ok: true, config: merged, usedOrgDefault: true };
  if (project.kind === 'unreadable') return projectFail(`读不了（${project.error}）`);
  const projJson = parseJson(project.text);
  if (!projJson.ok) return projectFail(projJson.why);
  const projParsed = ProjectConfigSchema.safeParse(projJson.value);
  if (!projParsed.success) return projectFail(issues(projParsed.error));
  const p = projParsed.data;
  if (!SUPPORTED_FORMATS.includes(p.formatVersion)) {
    return projectFail(`格式版本 ${p.formatVersion} 认不出（认 ${SUPPORTED_FORMATS.join('、')}）`);
  }
  const withProject: FlowConfig = {
    ...merged,
    profiles: { ...merged.profiles, ...(p.profiles ?? {}) },
    categoryProfiles: {
      ...merged.categoryProfiles,
      ...((p.categoryProfiles ?? {}) as Partial<Record<Category, string>>),
    },
    ...(p.testCommand !== undefined ? { testCommand: p.testCommand } : {}),
    ...(p.sessionMemoryMb !== undefined ? { sessionMemoryMb: p.sessionMemoryMb } : {}),
    ...(p.highRiskPaths !== undefined ? { highRiskPaths: p.highRiskPaths } : {}),
    ...(p.uiPaths !== undefined ? { uiPaths: p.uiPaths } : {}),
  };
  const projectProblem = checkMerged(withProject);
  if (projectProblem) return projectFail(projectProblem);
  return { ok: true, config: withProject, usedOrgDefault: false };
}

const under = (prefix: string, file: string) =>
  file === prefix || (prefix.endsWith('/') && file.startsWith(prefix));

/** 改到的文件里算页面代码的（派给 GPT 之前查：非空就不派）。 */
export function uiFiles(config: FlowConfig, files: readonly string[]): string[] {
  return files.filter((f) => config.uiPaths.some((p) => under(p, f)));
}

/** 改到的文件碰没碰高风险路径。 */
export function touchesHighRisk(config: FlowConfig, files: readonly string[]): boolean {
  return files.some((f) => config.highRiskPaths.some((p) => under(p, f)));
}

/** 这张单用哪套配置：单上临时指定的优先，否则按类别。 */
export function profileFor(
  config: FlowConfig,
  category: Category,
  override?: string,
): { ok: true; name: string; profile: Profile } | { ok: false; why: string } {
  const name = override?.trim() || config.categoryProfiles[category];
  const profile = config.profiles[name];
  return profile ? { ok: true, name, profile } : { ok: false, why: `没有叫「${name}」的配置` };
}
