// 仓档案（repos.profile，#2738）：引擎对一个仓的假设（语言和工具链、测试命令、模块根、合并要等的检查、标准清单在哪、权重）
// 写在这里，不再各处照 fleet-dao 写死。库里存的是原文（只存显式写了的项）；读的人用 parseRepoProfile 补默认值，
// 要判「档案齐没齐」的用 repoProfileGaps 看哪几项没写。fleet-api project set-profile 写之前用同一份校验，形状不对就拒。
import { z } from 'zod';

/** 仓里的相对路径（或 glob）：不许绝对路径、不许往上跳。 */
const RelPath = z
  .string()
  .trim()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p), '要写仓里的相对路径，不要绝对路径')
  .refine((p) => !p.split(/[\\/]/).includes('..'), '不许有 ..');

const uniqueList = <T extends z.ZodType<string>>(item: T) =>
  z.array(item).refine((xs) => new Set(xs).size === xs.length, '有重复的项');

export const RepoProfileSchema = z.strictObject({
  /** 主要语言，小写：typescript、go、python…… 认不出写 unknown。 */
  language: z.string().trim().min(1).default('unknown'),
  /** 工具链：node、pnpm、go…… 给人和派活看，不拿来跑命令。 */
  toolchain: uniqueList(z.string().trim().min(1)).default([]),
  /** 仓根跑的测试命令。标准要求每个仓都有 pnpm check（AGENTS.md 通用段「机器」），所以默认是它。 */
  testCommand: z.string().trim().min(1).default('pnpm check'),
  /** 模块根（glob，相对仓根）：分档按改到几个模块算，例如 fleet-dao 的 packages/*、Go 仓的 cmd/*、internal/*。空＝整个仓算一个模块。 */
  moduleRoots: uniqueList(RelPath).default([]),
  /** 「强制 CI」时合并前要等绿的检查名（GitHub 上的 check run / status 名）。空＝没有要等的。 */
  mergeSignals: uniqueList(z.string().trim().min(1)).default([]),
  /** 改标准路径清单在仓里的哪个文件（JSON）；文件不在＝这个仓没有改标准路径。 */
  standardPathsFile: RelPath.default('packages/conventions/standard-paths.json'),
  /** 权重：几个项目一起接活时，这个项目分到的份量（相对值，正整数）。 */
  weight: z.number().int().min(1).max(100).default(1),
  /**
   * 这个仓的单能不能分进全程模式（#2826）：开关 engine.flowMode 是 split / full 时只对开了的仓生效，贴了「全程」标签的不看它。
   * 默认关（先只开 fleet-dao）。不算「档案齐没齐」的一项：不写不挡拉单（repoProfileGaps 不报它）。
   */
  flowEligible: z.boolean().default(false),
});

export type RepoProfile = z.infer<typeof RepoProfileSchema>;
/** 写进库的原文：每项都可以不写。 */
export type RepoProfileInput = z.input<typeof RepoProfileSchema>;

/** 不写也算档案齐了的项（默认值就是安全的那一边）：拉单不因为它们没写就不拉，接入新仓时也不探测、不补。 */
export const REPO_PROFILE_OPTIONAL_KEYS: readonly (keyof RepoProfile)[] = ['flowEligible'];

/** 档案要写齐的项（不含 REPO_PROFILE_OPTIONAL_KEYS）。 */
export const REPO_PROFILE_KEYS = (Object.keys(RepoProfileSchema.shape) as (keyof RepoProfile)[]).filter(
  (k) => !REPO_PROFILE_OPTIONAL_KEYS.includes(k),
);

export const DEFAULT_REPO_PROFILE: RepoProfile = Object.freeze(RepoProfileSchema.parse({})) as RepoProfile;

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.map(String).join('.');
      const keys = i.code === 'unrecognized_keys' ? i.keys.join('、') : '';
      return `${[path, keys].filter(Boolean).join(' ') || '整体'}：${i.message}`;
    })
    .join('；');
}

/** 校验并补默认值；null、undefined 当成空档案。不抛错，错误写成一句白话（带出错的键名）。 */
export function safeParseRepoProfile(
  raw: unknown,
): { ok: true; profile: RepoProfile } | { ok: false; error: string } {
  const r = RepoProfileSchema.safeParse(raw ?? {});
  return r.success ? { ok: true, profile: r.data } : { ok: false, error: describeIssues(r.error) };
}

/** 校验并补默认值；形状不对抛错（不拿默认值顶替坏档案）。 */
export function parseRepoProfile(raw: unknown): RepoProfile {
  const r = safeParseRepoProfile(raw);
  if (!r.ok) throw new Error(`仓档案形状不对：${r.error}`);
  return r.profile;
}

/** 档案里没显式写的项（按 REPO_PROFILE_KEYS 的顺序，可选项不算）。只看写没写，不校验值。 */
export function repoProfileGaps(raw: unknown): (keyof RepoProfile)[] {
  const obj =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return REPO_PROFILE_KEYS.filter((k) => !Object.hasOwn(obj, k) || obj[k] === undefined);
}
