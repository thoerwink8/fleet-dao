// 隔离档位读回（#3858，讨论稿 6.6）：按这一次装配里真装了什么推出来，不是写死的字。
// 强：工人用另一个会话用户跑，且出网经关口；中：两者有一样；弱：两样都没有（本机装法的现状：工人和人同一个用户、没有出网关）。
export type IsolationLevel = 'strong' | 'medium' | 'weak';

export interface IsolationFacts {
  /** 工人是不是以另一个用户（会话用户）跑：装了 sandbox 才算。 */
  separateUser: boolean;
  /** 工人的出网是不是经关口限制。 */
  egressGateway: boolean;
  /** 工人用的权限档。 */
  permissionMode: string;
  platform: NodeJS.Platform;
}

export function readIsolation(f: IsolationFacts): { level: IsolationLevel; facts: string[] } {
  const level: IsolationLevel =
    f.separateUser && f.egressGateway ? 'strong' : f.separateUser || f.egressGateway ? 'medium' : 'weak';
  const facts = [
    f.separateUser ? '工人用另一个用户跑' : '工人和你是同一个系统用户，读得到你的文件和凭据',
    f.egressGateway ? '工人出网经关口' : '没有出网关口，工人能连任何地址',
    f.platform === 'win32'
      ? '没有 cgroup；进程树靠 taskkill 收，不当隔离看'
      : f.separateUser
        ? '进程组在会话用户的 cgroup 里'
        : '没有 cgroup',
    `工人权限档：${f.permissionMode}`,
  ];
  return { level, facts };
}
