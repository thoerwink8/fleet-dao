// fleet-dao 自己这个仓：驾驶舱里「这张单开在 fleet-dao」（cockpit.ts 给待实现占位链单子）、「发版卡读的是 fleet-dao 的主线」
// （release-card.ts）都指它。在受管的仓里按名字认，owner 不写死。
// 认不出（受管的仓里没有它）由调用方照实说：链不过去只显示单号、发版卡报读不到，不猜是哪个仓。
import type { Repo } from '@fleet-dao/shared';
import type { Store } from './ports.ts';

export const SELF_REPO_NAME = 'fleet-dao';

export async function findSelfRepo(store: Store): Promise<Repo | undefined> {
  return (await store.listRepos()).find((r) => r.name === SELF_REPO_NAME);
}
