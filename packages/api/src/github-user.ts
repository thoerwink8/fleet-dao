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

export interface GitHubUserPort {
  /** 授权码换 OAuth 用户令牌。GitHub 拒了（code 过期、用户取消）抛错，调用方按 401 处理。 */
  exchangeCode(input: { code: string; redirectUri: string }): Promise<ExchangedToken>;
  /** 这个令牌是谁的、还在不在（401 时调用方删掉库里那份）。 */
  viewer(token: string): Promise<{ id: number; login: string }>;
  /** 本人看得见的仓（含组织仓，按本人权限过滤）。 */
  listRepos(token: string): Promise<UserRepo[]>;
  /** 这个 App 装到本人账号/组织下、本人看得见的安装：key 是 owner（小写），value 是安装编号。 */
  installationsForApp(role: 'agent' | 'engine', token: string): Promise<Map<string, number>>;
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
  /** OAuth 授权页地址（App 的 client_id 拼出来）。 */
  authorizeUrl(input: { redirectUri: string; state: string }): string;
  /** 两个 App 是不是都配好了 client_id/client_secret（没配好时「连接 GitHub」回 503 并说明）。 */
  configured(): boolean;
}
