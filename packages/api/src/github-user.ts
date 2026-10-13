// 设置页「导入仓库」（#1989）的背后那一口：把 @fleet-dao/github 的 userApi 收成后端用得到的形状。
//
// 为什么单开一层：api 包不该直接依赖 @fleet-dao/github 的类型（那会拉进整个 GitHub 客户端），
// 测试也要一个不联网的假实现。这一层就是那一小撮接口的形状，生产在 main.ts 里按它包一层。
import type { UserRepo } from '@fleet-dao/github';

/** 授权码换用户令牌的结果。 */
export interface ExchangedToken {
  token: string;
  scopes: string;
  expiresAt: string | null;
}

/** 用户令牌是哪个 App 换来的。两边各一份，不能混用。 */
export type GitHubAppRole = 'agent' | 'engine';

/** 一份安装。all = 这个账号下的仓都已经在里面，再 PUT 单个仓 GitHub 会拒。 */
export interface AppInstallation {
  id: number;
  selection: 'all' | 'selected';
}

export interface GitHubUserPort {
  /** 授权码换 OAuth 用户令牌。role 是哪个 App 的授权页发的 code，就用哪个 App 的密钥换。 */
  exchangeCode(input: { code: string; redirectUri: string; role?: GitHubAppRole }): Promise<ExchangedToken>;
  /** 这个令牌是谁的、还在不在（401 时调用方删掉库里那份）。 */
  viewer(token: string): Promise<{ id: number; login: string }>;
  /** 本人看得见的仓（含组织仓，按本人权限过滤）。 */
  listRepos(token: string): Promise<UserRepo[]>;
  /** 从仓的默认分支推出测试命令。认不出抛错，不编一条。 */
  readTestCommand(
    token: string,
    repo: { owner: string; name: string; defaultBranch: string },
  ): Promise<string>;
  /**
   * 这个 App 装到本人账号/组织下、本人看得见的安装。key 是 owner（小写）。
   * token 必须是 role 那一边换来的：GitHub 的用户令牌看不见另一个 App 的安装。
   */
  installationsForApp(role: GitHubAppRole, token: string): Promise<Map<string, AppInstallation>>;
  /** 这个安装现在能访问的仓的编号集合。 */
  installationRepoIds(token: string, installationId: number): Promise<Set<number>>;
  /** 把一批仓加进这个安装。 */
  addReposToInstallation(token: string, installationId: number, repoIds: readonly number[]): Promise<void>;
  /** 把一批仓从这个安装里去掉。 */
  removeReposFromInstallation(
    token: string,
    installationId: number,
    repoIds: readonly number[],
  ): Promise<void>;
  /** OAuth 授权页地址。role 决定用哪个 App 的 client_id。 */
  authorizeUrl(input: { redirectUri: string; state: string; role?: GitHubAppRole }): string;
  /** GitHub 安装页：把这个 App 装到这个仓。地址只许在 github.com。 */
  appInstallUrl(input: { role: GitHubAppRole; ownerId: number; repositoryId: number; state: string }): string;
  /** 两个 App 是不是都配好了 client_id/client_secret（没配好时「连接 GitHub」回 503 并说明）。 */
  configured(): boolean;
}
