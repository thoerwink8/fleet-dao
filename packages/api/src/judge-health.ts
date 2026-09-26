// /healthz 的 judge 项：这台机器的判断题接没接、接了调不调得通。判法和引擎每次提问是同一份（@fleet-dao/jev 的 judgeHealth）。
// 「未接」只有一种：没写 FLEET_JEV_CONFIG、默认位置上也没有配置文件——装配时定（之后补上配置要重启后端才显示出来）。
// 其余只有绿和红：配置起不来（读不到、认不出、判断阶段没路由、钥匙读不到）报红；最近一次真调用没成报红，下一次调成了自动变绿。
// 对外只说一句中性的话（公网看得到，不带内部名：项名叫 judge 不叫 jev，也不提上游是谁），原因只进日志。
import type { Stats } from 'node:fs';
import type { Db } from '@fleet-dao/db';
import {
  type JevBackend,
  type JevConfigLocation,
  type JevMachineConfig,
  type JudgeRoute,
  jevConfigPresence,
  judgeHealth,
} from '@fleet-dao/jev';
import { PublicHealthError } from './health.ts';

/** 「未接」时对外那句话。 */
export const JUDGE_NOT_WIRED = '这台机器没配判断题';

export interface JudgeHealthDeps {
  db: Db;
  /** 配置文件在哪（生产：@fleet-dao/jev 的 jevConfigLocation(process.env)，和引擎读同一份环境）。 */
  location: JevConfigLocation;
  /** 以下测试用：不出网、造读不到的文件。 */
  makeBackend?: (route: JudgeRoute, config: JevMachineConfig) => Promise<JevBackend>;
  stat?: (path: string) => Stats;
}

export function judgeHealthCheck(deps: JudgeHealthDeps): {
  check(): Promise<void>;
  readonly notWired?: string;
} {
  const presence = jevConfigPresence(deps.location, deps.stat);
  if (presence.state === 'absent') return { notWired: JUDGE_NOT_WIRED, check: async () => {} };
  const options = {
    ...deps.location,
    ...(deps.makeBackend ? { makeBackend: deps.makeBackend } : {}),
    ...(deps.stat ? { stat: deps.stat } : {}),
  };
  return {
    async check() {
      const h = await judgeHealth(deps.db, options);
      if (h.state === 'absent' || h.state === 'broken') {
        throw new PublicHealthError(
          'judge_config',
          '判断题的配置起不来',
          h.state === 'absent' ? `后端起来时有配置文件，现在没有 ${h.path}` : h.problem,
        );
      }
      if (h.state === 'failing') {
        const { call } = h;
        throw new PublicHealthError(
          'judge_failing',
          '判断题最近一次调用没成',
          `${call.at.toISOString()} 问 ${call.questionId}（判断记录 ${call.answerId}）：${call.reason ?? '没写原因'}${call.detail ? `：${call.detail}` : ''}`,
        );
      }
    },
  };
}
