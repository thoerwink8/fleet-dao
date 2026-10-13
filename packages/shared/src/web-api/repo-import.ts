// 驾驶舱接口约定（web-api）：设置页「仓库」一节里「导入仓库」那一块（#1989）。
// 列本人 GitHub 上看得见的仓、把仓接进/移出驾驶舱、把 App 一键装到某个仓。
//
// 身份那一半（列仓、装 App）走本人 OAuth 用户令牌——App 机器人令牌看不到别人的个人仓；
// 接进/移出驾驶舱那一半只动我们自己的 repos 表。两半的接口都在这里。

import { z } from 'zod';
import { Id, Time } from './internal.ts';

/** 操作记录里这几件事的名字；target 见各接口。 */
export const REPO_IMPORT_ADD = 'repo.import.add';
export const REPO_IMPORT_REMOVE = 'repo.import.remove';
export const GITHUB_OAUTH_CONNECT = 'github.oauth.connect';
export const GITHUB_OAUTH_DISCONNECT = 'github.oauth.disconnect';
export const GITHUB_INSTALL_REPO = 'github.install.repo';

/**
 * 一个仓在「导入仓库」列表里的一行。三件事各用一个字段说清，页面据此决定能不能一键加：
 * - 是不是组织的仓（组织仓要组织先批准 App，本人点了也只是「请求」）；
 * - 两个 App（干活的、引擎）装了没；
 * - 在不在驾驶舱里（在的话「加进驾驶舱」换成「已经在驾驶舱」，点「移出」才动）。
 */
export const ImportableRepoSchema = z.object({
  /** GitHub 的仓编号（装 App 要它）。 */
  githubId: z.number().int().positive(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  ownerType: z.enum(['User', 'Organization']),
  /** 主人是组织时，本人对它有 admin 权限（能改安装）；个人仓恒为 true（自己的仓）。 */
  viewerCanAdmin: z.boolean(),
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
  /**
   * 能不能本人一键把 App 装到这个仓：要本人是这个仓的 admin（组织仓还要组织批准过这个 App）。
   * false 时 why 写清为什么——页面照它说人话，不给一个点了没反应的按钮。
   */
  canInstall: z.boolean(),
  /** canInstall=false 时的一句原因。 */
  installBlockedWhy: z.string().optional(),
});
export type ImportableRepo = z.infer<typeof ImportableRepoSchema>;

/** 现在存的这份 GitHub 授权（各人自己的）。 */
export const GitHubAuthStateSchema = z.object({
  /** 存着授权。false = 还没连，页面画「连接 GitHub」。 */
  connected: z.boolean(),
  login: z.string().optional(),
  /** GitHub 回的 scope 原文；页面照它如实说明能读到什么。 */
  scopes: z.string().optional(),
  connectedAt: Time.optional(),
  /** 存着的那份读不出来（换过会话密钥、数据被动过）：页面提示重新连，不当成「没连过」。 */
  unreadable: z.boolean().optional(),
  /** 读不出来的原因。 */
  unreadableWhy: z.string().optional(),
});
export type GitHubAuthState = z.infer<typeof GitHubAuthStateSchema>;

/** GET /repos/importable：我的仓 + 我这份授权现在怎样。userToken 没连时 repos 是空的、reason 写为什么。 */
export const ImportableReposResponse = z.object({
  auth: GitHubAuthStateSchema,
  repos: z.array(ImportableRepoSchema),
  /** 列仓没成功（令牌失效、GitHub 连不上）时写原因，repos 空。 */
  reason: z.string().optional(),
});
export type ImportableReposResponse = z.infer<typeof ImportableReposResponse>;

/** POST /repos/import：把一个仓接进驾驶舱。 */
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
});
export type ImportRepoResponse = z.infer<typeof ImportRepoResponse>;

/** DELETE /repos/:repoId/cockpit：把一个仓移出驾驶舱。 */
export const RemoveRepoResponse = z.object({
  removed: z.boolean(),
  /** 移不掉（还挂着没结束的单）时写原因。 */
  reason: z.string().optional(),
});
export type RemoveRepoResponse = z.infer<typeof RemoveRepoResponse>;

/** POST /repos/install：把两个 App 装到某个仓（一键授权那一步）。 */
export const InstallAppRequest = z.object({
  githubId: z.number().int().positive(),
});
export const InstallAppResponse = z.object({
  /** 装上了几个 App（0/1/2）。 */
  installed: z.number().int().min(0).max(2),
  /** 每个 App 装成了没。 */
  agent: z.boolean(),
  engine: z.boolean(),
  /** 没装上的原因（组织没批准、不是 admin、GitHub 拒了）。 */
  reason: z.string().optional(),
});
export type InstallAppResponse = z.infer<typeof InstallAppResponse>;

/** POST /github/oauth/disconnect：断开本人这份 GitHub 授权。 */
export const DisconnectGitHubResponse = z.object({
  disconnected: z.boolean(),
});
export type DisconnectGitHubResponse = z.infer<typeof DisconnectGitHubResponse>;
