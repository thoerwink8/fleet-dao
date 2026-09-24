// 卡片登记：网关发出的每条消息都记下「这是哪种卡、在说哪件事」，写进后端库里（重启不丢）。
// 用户回复某张卡时，后端靠它知道回复的是什么（见 shared/feishu-api.ts 的 FeishuMessageRequest）；
// 盘面快照里的 teamBoardCard 也从它来，网关重启后靠它找回团队群置顶的那张卡。
import { type Backend, BackendError, type CardRecord } from './backend.ts';
import type { Logger } from './log.ts';
import { type Inflight, sleep } from './util.ts';

export interface Registry {
  /** 后台写进后端，失败重试两次，再失败记错误（这张卡被回复时后端就不知道它在说什么）。 */
  remember(record: CardRecord): void;
}

export function createRegistry(deps: {
  backend: Backend;
  log: Logger;
  inflight: Inflight;
  retryDelaysMs?: number[];
}): Registry {
  const delays = deps.retryDelaysMs ?? [500, 2000];

  async function put(record: CardRecord): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.backend.putCard(record);
        return;
      } catch (err) {
        const wait = delays[attempt];
        if (wait === undefined || (err instanceof BackendError && err.kind === 'rejected')) {
          deps.log.error('卡片登记没写进后端：回复这张卡时后端不知道它在说什么', {
            messageId: record.messageId,
            kind: record.kind,
            error: String(err),
          });
          return;
        }
        await sleep(wait);
      }
    }
  }

  return {
    remember(record) {
      deps.inflight.track(put(record));
    },
  };
}
