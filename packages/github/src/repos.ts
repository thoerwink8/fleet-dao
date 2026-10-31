// 仓的事实一律从 GitHub 读、短时缓存，不在代码或配置里手写：默认分支（fleet-dao 是 main，旧代码到处写死 master，G1）、
// 主线的必过检查（从规则集读——手打的常量早晚会被凭印象填错）。
import { z } from 'zod';
import {
  enc,
  encRef,
  type GhResponse,
  type GitHubClient,
  type RepoRef,
  repoSlug,
  unexpected,
} from './client.ts';
import type { AppRole } from './credentials.ts';
import { isGitHubError } from './errors.ts';

const RepoSchema = z.object({
  default_branch: z.string().min(1),
  full_name: z.string(),
  private: z.boolean(),
});

const RulesSchema = z.array(
  z.object({
    type: z.string(),
    parameters: z
      .object({
        required_status_checks: z.array(z.object({ context: z.string() })).optional(),
        allowed_merge_methods: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  }),
);

export interface RepoFacts {
  defaultBranch: string;
  fullName: string;
  private: boolean;
}

export interface BranchRules {
  /** 必过检查的名字（规则集里 required_status_checks 的 context）。 */
  requiredChecks: string[];
  /** 规则集限定的合并方式；没限定就是空。 */
  mergeMethods: string[];
}

const TTL_MS = 5 * 60_000;

/**
 * 免费套餐的私有仓不支持分支规则，GitHub 对规则接口回 403「Upgrade to GitHub Pro or make this repository public
 * to enable this feature.」。只认这句（别的 403 是令牌权限之类，不能吞）；这样的仓没有规则可读，等于没写规则。
 */
const PLAN_UNSUPPORTED_RULES = /upgrade to github pro or make this repository public/i;

function rulesUnsupportedByPlan(error: unknown): boolean {
  if (!isGitHubError(error, 'FORBIDDEN')) return false;
  const details = error.details as { githubMessage?: unknown } | undefined;
  return typeof details?.githubMessage === 'string' && PLAN_UNSUPPORTED_RULES.test(details.githubMessage);
}

export class RepoFactsCache {
  private readonly facts = new Map<string, { at: number; value: RepoFacts }>();
  private readonly rules = new Map<string, { at: number; value: BranchRules }>();
  private readonly client: GitHubClient;
  constructor(client: GitHubClient) {
    this.client = client;
  }

  async get(repo: RepoRef, role: AppRole = 'engine', signal?: AbortSignal): Promise<RepoFacts> {
    const key = repoSlug(repo).toLowerCase();
    const hit = this.facts.get(key);
    const now = this.client.now().getTime();
    if (hit && now - hit.at < TTL_MS) return hit.value;
    const res = await this.client.request({
      method: 'GET',
      path: `/repos/${enc(repo.owner)}/${enc(repo.name)}`,
      auth: { as: role, repo },
      signal,
    });
    const parsed = RepoSchema.safeParse(res.data);
    if (!parsed.success) throw unexpected(`读仓 ${repoSlug(repo)}`, res.data);
    const value = {
      defaultBranch: parsed.data.default_branch,
      fullName: parsed.data.full_name,
      private: parsed.data.private,
    };
    this.facts.set(key, { at: now, value });
    return value;
  }

  /** 某个分支上生效的规则。引擎用单独的 'rules' 令牌（administration:read + metadata:read，见 token-scopes.ts）。 */
  async branchRules(
    repo: RepoRef,
    branch: string,
    role: AppRole = 'engine',
    signal?: AbortSignal,
  ): Promise<BranchRules> {
    const key = `${repoSlug(repo).toLowerCase()}@${branch}`;
    const hit = this.rules.get(key);
    const now = this.client.now().getTime();
    if (hit && now - hit.at < TTL_MS) return hit.value;
    let res: GhResponse;
    try {
      res = await this.client.request({
        method: 'GET',
        path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/rules/branches/${encRef(branch)}`,
        auth: { as: role, repo, scope: role === 'engine' ? 'rules' : undefined },
        query: { per_page: 100 },
        signal,
      });
    } catch (error) {
      if (!rulesUnsupportedByPlan(error)) throw error;
      // 空规则：requiredChecksFor 会因此抛 NO_REQUIRED_CHECKS（零条检查不当绿），由仓档案的 mergeSignals 兜底。
      const empty: BranchRules = { requiredChecks: [], mergeMethods: [] };
      this.rules.set(key, { at: now, value: empty });
      return empty;
    }
    const parsed = RulesSchema.safeParse(res.data);
    if (!parsed.success) throw unexpected(`读 ${repoSlug(repo)} ${branch} 的规则`, res.data);
    const requiredChecks = new Set<string>();
    const mergeMethods = new Set<string>();
    for (const rule of parsed.data) {
      for (const c of rule.parameters?.required_status_checks ?? []) requiredChecks.add(c.context);
      for (const m of rule.parameters?.allowed_merge_methods ?? []) mergeMethods.add(m);
    }
    const value = { requiredChecks: [...requiredChecks].sort(), mergeMethods: [...mergeMethods].sort() };
    this.rules.set(key, { at: now, value });
    return value;
  }
}
