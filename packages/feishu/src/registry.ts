// 卡片登记：网关发出的每条消息记下「这是哪种卡、在说哪件事」，真相在后端库里（重启不丢），本地留一份最近的好秒查。
// 用户回复某张卡时靠它带上这张卡的来历；团队群的盘面卡也靠它在重启后找回来，不重发。
import { type Backend, BackendError, type CardKind, type CardRecord } from './backend.ts';
import type { Logger } from './log.ts';
import { type Inflight, Lru, sleep } from './util.ts';

export interface Registry {
  /** 本地马上记上；后端异步写，失败重试两次，再失败记日志。 */
  remember(record: CardRecord): void;
  /** null = 不是我们登记过的；'unknown' = 后端没查成（不能当成「不是」）。 */
  lookup(messageId: string, timeoutMs?: number): Promise<CardRecord | null | 'unknown'>;
  /** 某个会话里最新的一张某种卡。后端没查成就抛错：调用方不许把「没查成」当「没有」。 */
  latest(kind: CardKind, chatId: string): Promise<CardRecord | null>;
}

export function createRegistry(deps: {
  backend: Backend;
  log: Logger;
  inflight: Inflight;
  retryDelaysMs?: number[];
}): Registry {
  const local = new Lru<string, CardRecord>(5000);
  const delays = deps.retryDelaysMs ?? [500, 2000];

  async function put(record: CardRecord): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.backend.putCard(record);
        return;
      } catch (err) {
        const wait = delays[attempt];
        if (wait === undefined || (err instanceof BackendError && err.kind === 'rejected')) {
          deps.log.error('卡片登记没写进后端：回复这张卡时会少了来历', {
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
      local.set(record.messageId, record);
      deps.inflight.track(put(record));
    },

    async lookup(messageId, timeoutMs = 3000) {
      const hit = local.get(messageId);
      if (hit) return hit;
      try {
        const found = await deps.backend.getCard(messageId, { timeoutMs });
        if (found) local.set(messageId, found);
        return found;
      } catch (err) {
        deps.log.warn('卡片登记没查成', { messageId, error: String(err) });
        return 'unknown';
      }
    },

    async latest(kind, chatId) {
      const items = await deps.backend.listCards({ kind, chatId, limit: 1 });
      const first = items[0] ?? null;
      if (first) local.set(first.messageId, first);
      return first;
    },
  };
}
