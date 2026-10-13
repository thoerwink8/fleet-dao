// 驾驶舱接口约定：设置页「导入仓库」。每人用自己的 GitHub 用户授权看自己的仓，加进或移出派单，一键给两个 App 授权。
import { z } from 'zod';
import { Id } from './internal.ts';

/** 操作记录：加进驾驶舱。target 是 github:owner/name（插进去之前还没有仓编号）。 */
export const REPO_IMPORT = 'repo.import';
/** 操作记录：移出驾驶舱。target 是 repo:<编号>。失败时 ok=false、error=in_use。 */
export const REPO_REMOVE = 'repo.remove';
/** 操作记录：把一个 App 装到这个仓。每个 App 各记一条。 */
export const REPO_APPS_INSTALL = 'repo.apps.install';

/** 组织仓上固定写的一句：组织要先批准，个人仓没有这句。 */
export const ORG_APP_APPROVAL_NOTE = '要组织先批准这个 App';

export const AppInstallStateSchema = z.enum(['installed', 'missing', 'unknown']);

const OwnerName = z.string().regex(/^[A-Za-z0-9-]+$/);
const RepoName = z.string().regex(/^[A-Za-z0-9._-]+$/);

export const GithubRepoRowSchema = z.object({
  owner: OwnerName,
  name: RepoName,
  ownerKind: z.enum(['user', 'org']),
  defaultBranch: z.string(),
  inCockpit: z.boolean(),
  repoId: Id.optional(),
  canAdmin: z.boolean(),
  apps: z.object({
    agent: AppInstallStateSchema,
    engine: AppInstallStateSchema,
  }),
  /** 有一个 App 认不出时写原因。认不出不是没装。 */
  appsUnknown: z.string().optional(),
  /** 组织仓才有。 */
  orgNote: z.string().optional(),
});

export const GithubReposResponse = z.object({
  connected: z.boolean(),
  /** 没连接、授权过期、或这次没列成。有这句话就不能把空列表当成「你没有仓」。 */
  problem: z.string().optional(),
  githubLogin: z.string().optional(),
  truncated: z.boolean(),
  repos: z.array(GithubRepoRowSchema),
});

export const GithubConnectRequest = z.object({
  /** list = 为列仓去授权（默认）。install-account = 已经连上，再去 GitHub 把 App 装到别的账号。 */
  purpose: z.enum(['list', 'install-account']).optional(),
});

export const GithubConnectResponse = z.object({
  redirect: z.string().url().optional(),
  connected: z.boolean(),
});

export const GithubAuthorizeRequest = z.object({
  owner: OwnerName,
  name: RepoName,
});

export const GithubAuthorizeResponse = z.object({
  redirect: z.string().url().optional(),
  installed: z.boolean(),
  agent: AppInstallStateSchema.optional(),
  engine: AppInstallStateSchema.optional(),
});

export const ImportRepoRequest = GithubAuthorizeRequest;

export const ImportRepoResponse = z.object({
  repoId: Id,
  owner: OwnerName,
  name: RepoName,
  defaultBranch: z.string(),
  testCommand: z.string(),
  autoDispatch: z.literal(false),
  created: z.boolean(),
});

export const RemoveRepoResponse = z.object({
  removed: z.literal(true),
  owner: z.string(),
  name: z.string(),
});
