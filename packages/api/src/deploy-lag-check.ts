// /healthz 的 deploy_lag 一项。判法在 @fleet-dao/store 的 deploy-lag.ts（引擎的每小时对账也读它）；这一份留在 api：
// 它抛 PublicHealthError（health.ts，公网看得到的原因），store 不能反过来依赖 health.ts，
// health-public-text.test.ts 数 api/src 里每一处 new PublicHealthError，留在这里才不漏扫。
import { type DeployLagInput, judgeDeployLag } from '@fleet-dao/store';
import { PublicHealthError } from './health.ts';

/** /healthz 的 deploy_lag 一项：不对就抛（对外一句中性的话，细节只进日志）。 */
export function deployLagCheck(read: () => DeployLagInput, now: () => Date): () => Promise<void> {
  return async () => {
    const v = judgeDeployLag(read(), now());
    const first = v.problems[0];
    if (!first) return;
    throw new PublicHealthError(
      first.code,
      v.problems.map((p) => p.message).join('；'),
      v.problems
        .map((p) => p.detail)
        .filter(Boolean)
        .join('；'),
    );
  };
}
