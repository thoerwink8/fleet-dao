// 驾驶舱接口约定（web-api）：设置页「仓库」一节里「导入仓库」那一块。
// 列两个机器人已经装上的仓（安装令牌读 /installation/repositories）、把仓接进/移出驾驶舱。
// 装 App、连本人 GitHub 不在这里：接入走本机 pnpm project add。

import { z } from 'zod';
import { Id } from './internal.ts';

/** 操作记录里这几件事的名字；target 见各接口。 */
export const REPO_IMPORT_ADD = 'repo.import.add';
export const REPO_IMPORT_REMOVE = 'repo.import.remove';

/** 两个机器人在 GitHub 上的 App 名。 */
export const GITHUB_APP_SLUGS = { agent: 'fleet-dao-agent', engine: 'fleet-dao-engine' } as const;
export type GitHubAppRoleName = keyof typeof GITHUB_APP_SLUGS;

/** 没装机器人时在界面上明说的那一句（导入界面、「要你拍的」、警告共用，别各写各的）。 */
export const APPS_NOT_INSTALLED_HINT = '先去 GitHub 把两个机器人装到这个仓';

/** 一条去 GitHub 的直达链接。 */
export const InstallLinkSchema = z.object({ label: z.string(), url: z.string() });
export type InstallLink = z.infer<typeof InstallLinkSchema>;

/**
 * 去 GitHub 装机器人的直达链接：缺的每个 App 一条「装到这个仓」的页面，加一条 GitHub 安装设置页
 * （个人账号的仓去 settings/installations，组织的仓去该组织的 settings/installations；owner 类型不明时给个人的）。
 */
export function githubInstallLinks(input: {
  owner: string;
  ownerType?: 'User' | 'Organization' | undefined;
  missing: readonly GitHubAppRoleName[];
}): InstallLink[] {
  const links: InstallLink[] = input.missing.map((role) => ({
    label: `装「${GITHUB_APP_SLUGS[role]}」`,
    url: `https://github.com/apps/${GITHUB_APP_SLUGS[role]}/installations/new`,
  }));
  links.push(
    input.ownerType === 'Organization'
      ? {
          label: `${input.owner} 的安装设置`,
          url: `https://github.com/organizations/${encodeURIComponent(input.owner)}/settings/installations`,
        }
      : { label: 'GitHub 安装设置', url: 'https://github.com/settings/installations' },
  );
  return links;
}

/**
 * 一个仓在「导入仓库」列表里的一行。列表只含安装令牌能看见的仓（至少一个机器人已经装上）。
 * 两个机器人各看各的安装，合并后用字段说清装没装全、在不在驾驶舱。
 */
export const ImportableRepoSchema = z.object({
  /** GitHub 的仓编号。 */
  githubId: z.number().int().positive(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  ownerType: z.enum(['User', 'Organization']),
  archived: z.boolean(),
  /** 空仓（没有代码）：页面上置灰，不给接（没代码可派活）。 */
  empty: z.boolean(),
  /** 「干活的」App 装到这个仓了没。 */
  agentInstalled: z.boolean(),
  /** 「引擎」App 装到这个仓了没。 */
  engineInstalled: z.boolean(),
  /** 两个都装了。 */
  fullyInstalled: z.boolean(),
  /** 已经在驾驶舱（repos 表）里：是的话 reposId 有值。 */
  inCockpit: z.boolean(),
  reposId: Id.optional(),
});
export type ImportableRepo = z.infer<typeof ImportableRepoSchema>;

/** GET /repos/importable：两个机器人已经装上的仓。没接上 GitHub 或列仓失败时 repos 空、reason 写为什么。 */
export const ImportableReposResponse = z.object({
  repos: z.array(ImportableRepoSchema),
  /** 列仓没成功（凭据没读到、GitHub 连不上）时写原因，repos 空。 */
  reason: z.string().optional(),
});
export type ImportableReposResponse = z.infer<typeof ImportableReposResponse>;

/** POST /repos/import：把一个已经装上的仓接进驾驶舱。 */
export const ImportRepoRequest = z.object({
  /** GitHub 的仓编号：认这个，比 owner/name 稳（改名了也认得出）。 */
  githubId: z.number().int().positive(),
});
export const ImportRepoResponse = z.object({
  repoId: Id,
  owner: z.string(),
  name: z.string(),
  /** false = 本来就在驾驶舱里（没重复建）。 */
  created: z.boolean(),
  /**
   * 两个机器人都装到这个仓了吗。false = 未接入：仍然导入了，但界面要明说 APPS_NOT_INSTALLED_HINT 并给 installLinks；
   * null = 没查成（installCheckWhy 写原因），不当成装了也不当成没装。
   */
  appsInstalled: z.boolean().nullable(),
  /** 具体缺哪个（appsInstalled=false 时有意义）。 */
  agentInstalled: z.boolean(),
  engineInstalled: z.boolean(),
  /** 没装全时去 GitHub 的直达链接；装全了为空。 */
  installLinks: z.array(InstallLinkSchema),
  installCheckWhy: z.string().optional(),
});
export type ImportRepoResponse = z.infer<typeof ImportRepoResponse>;

/** DELETE /repos/:repoId/cockpit：把一个仓移出驾驶舱。 */
export const RemoveRepoResponse = z.object({
  removed: z.boolean(),
  /** 移不掉（还挂着没结束的单）时写原因。 */
  reason: z.string().optional(),
});
export type RemoveRepoResponse = z.infer<typeof RemoveRepoResponse>;
