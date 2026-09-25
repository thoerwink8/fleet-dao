// 盘面：快照缓存在网关本地（菜单、按钮秒回），团队群里置顶一张盘面卡原地刷新。
// 飞书卡片发出 14 天后就改不了，所以满 13 天发一张新的、重新置顶，旧卡改成「已换新」。
import type { Backend, BoardSnapshot } from './backend.ts';
import {
  activeListCard,
  boardCard,
  expiredBoardCard,
  type RenderContext,
  stalledListCard,
  waitingListCard,
} from './cards.ts';
import type { Logger } from './log.ts';
import { CARD_EDITABLE_MS, type Card, type FeishuPort, feishuErrorKind } from './port.ts';
import type { Registry } from './registry.ts';
import { nextNonce, uuidFor } from './util.ts';

/** 满这么久就换新卡（飞书的硬限制是 14 天，见 CARD_EDITABLE_MS）。 */
export const BOARD_RESEND_AFTER_MS = 13 * 24 * 60 * 60 * 1000;
/** 缓存比这新就直接用，菜单秒回。 */
const FRESH_MS = 60_000;

export interface BoardDeps {
  backend: Backend;
  feishu: FeishuPort;
  registry: Registry;
  log: Logger;
  now: () => number;
  teamChatId: string;
  publicUrl: string;
  /** 内容变了也至少隔这么久才改一次（群里的卡单条 5 QPS、全群机器人共享 5 QPS）。 */
  minPatchIntervalMs?: number;
  /** 内容没变时，隔这么久也改一次，好让「更新于」的时间不显得停住了。 */
  touchIntervalMs?: number;
}

export interface Board {
  /** 取一次新快照；取不到返回 null，缓存留着。 */
  refresh(timeoutMs?: number): Promise<BoardSnapshot | null>;
  /** 定时跑：取快照，维护团队群的置顶盘面卡。 */
  tick(): Promise<void>;
  /** 盘面卡上的按钮。卡可能是团队群置顶的那张，也可能是私聊里点菜单出的。 */
  onButton(
    which: 'refresh' | 'stalled' | 'waiting',
    at: { messageId: string; chatId: string; operatorId: string; operatorName: string },
  ): Promise<void>;
  /** 私聊菜单：盘面 / 我的待办 / 查进度。 */
  sendTo(openId: string, which: 'board' | 'todo' | 'active'): Promise<void>;
  pinned(): { messageId: string; sentAt: number } | null;
}

export function createBoard(deps: BoardDeps): Board {
  const minPatchIntervalMs = deps.minPatchIntervalMs ?? 10_000;
  const touchIntervalMs = deps.touchIntervalMs ?? 10 * 60_000;
  let cache: { snap: BoardSnapshot; fetchedAt: number } | null = null;
  /**
   * undefined = 还没从快照里认领过（重启后第一份快照里的 teamBoardCard 就是它；快照取不到就不发新卡，免得团队群里出现两张）。
   * 认领之后以本地为准：刚发的新卡登记还没落到后端时，快照里可能还是旧的那张。
   */
  let pinned: { messageId: string; sentAt: number } | null | undefined;
  let lastSignature: string | undefined;
  let lastPatchAt = 0;
  let resending: Promise<void> | null = null;

  const ctx = (): RenderContext => ({
    publicUrl: deps.publicUrl,
    now: deps.now(),
    nonce: nextNonce(deps.now()),
  });

  async function refresh(timeoutMs = 5_000): Promise<BoardSnapshot | null> {
    try {
      const snap = await deps.backend.board({ timeoutMs });
      cache = { snap, fetchedAt: deps.now() };
      if (pinned === undefined) {
        const card = snap.teamBoardCard;
        pinned = card ? { messageId: card.messageId, sentAt: Date.parse(card.sentAt) } : null;
      }
      return snap;
    } catch (err) {
      deps.log.warn('盘面快照没取到，先用缓存', { error: String(err), cachedAt: cache?.fetchedAt });
      return null;
    }
  }

  /** 给人看的快照：缓存够新直接用；旧了现取一次（最多等 1.5 秒），取不到用旧的并注明多旧。 */
  async function current(): Promise<{ snap: BoardSnapshot; staleMs?: number } | null> {
    if (cache && deps.now() - cache.fetchedAt < FRESH_MS) return { snap: cache.snap };
    const fresh = await refresh(1_500);
    if (fresh) return { snap: fresh };
    if (cache) return { snap: cache.snap, staleMs: deps.now() - cache.fetchedAt };
    return null;
  }

  function staleOf(): number | undefined {
    if (!cache) return undefined;
    const age = deps.now() - cache.fetchedAt;
    return age > 3 * FRESH_MS ? age : undefined;
  }

  function render(snap: BoardSnapshot, note?: string, staleMs?: number): Card {
    return boardCard(snap, ctx(), { note, ...(staleMs === undefined ? {} : { staleMs }) });
  }

  async function sendNewPinned(snap: BoardSnapshot, replacing: { messageId: string; sentAt: number } | null) {
    const now = deps.now();
    const sent = await deps.feishu.send(
      { chatId: deps.teamChatId },
      { card: render(snap) },
      { uuid: uuidFor('board', deps.teamChatId, replacing?.messageId ?? 'first') },
    );
    pinned = { messageId: sent.messageId, sentAt: now };
    lastSignature = signature(snap);
    lastPatchAt = now;
    deps.registry.remember({
      messageId: sent.messageId,
      chatId: deps.teamChatId,
      kind: 'board',
      ref: {},
      sentAt: new Date(now).toISOString(),
    });
    deps.log.info(replacing ? '盘面卡满 13 天，已换新卡' : '团队群发了盘面卡', { messageId: sent.messageId });
    try {
      await deps.feishu.pin(deps.teamChatId, sent.messageId);
    } catch (err) {
      deps.log.error('盘面卡置顶没成功（群设置可能只许群主或管理员置顶）', { error: String(err) });
    }
    if (replacing && now - replacing.sentAt < CARD_EDITABLE_MS) {
      try {
        await deps.feishu.updateCard(replacing.messageId, expiredBoardCard(ctx()));
      } catch (err) {
        deps.log.warn('旧盘面卡没改成「已换新」', { messageId: replacing.messageId, error: String(err) });
      }
    }
  }

  async function maintainPinned(): Promise<void> {
    // 快照一次都没取到（后端挂着）：不知道团队群里有没有盘面卡，这轮不发，免得发重。
    if (!cache || pinned === undefined) return;
    const now = deps.now();
    if (pinned === null) return sendNewPinned(cache.snap, null);
    if (now - pinned.sentAt >= BOARD_RESEND_AFTER_MS) return sendNewPinned(cache.snap, pinned);
    const sig = signature(cache.snap);
    const due = sig !== lastSignature || now - lastPatchAt >= touchIntervalMs;
    if (!due || now - lastPatchAt < minPatchIntervalMs) return;
    try {
      await deps.feishu.updateCard(pinned.messageId, render(cache.snap, undefined, staleOf()));
      lastSignature = sig;
      lastPatchAt = now;
    } catch (err) {
      if (feishuErrorKind(err) === 'too_old') return sendNewPinned(cache.snap, pinned);
      deps.log.warn('盘面卡没刷新成', { messageId: pinned.messageId, error: String(err) });
    }
  }

  /** 私聊发的都登记成 list：只有团队群置顶的那张算 board（盘面快照里的 teamBoardCard 只认它）。 */
  async function dm(openId: string, card: Card, key: string): Promise<void> {
    const now = deps.now();
    const sent = await deps.feishu.send({ openId }, { card }, { uuid: uuidFor('dm', openId, key, now) });
    deps.registry.remember({
      messageId: sent.messageId,
      chatId: sent.chatId,
      kind: 'list',
      ref: {},
      sentAt: new Date(now).toISOString(),
    });
  }

  return {
    refresh,

    async tick() {
      await refresh();
      // 同一时刻只跑一次维护：13 天换新时发卡、置顶、改旧卡要几秒，下一次定时别叠上来。
      if (resending) return;
      resending = maintainPinned().finally(() => {
        resending = null;
      });
      await resending;
    },

    async onButton(which, at) {
      let cur: { snap: BoardSnapshot; staleMs?: number } | null;
      if (which === 'refresh') {
        const fresh = await refresh(3_000);
        cur = fresh
          ? { snap: fresh }
          : cache
            ? { snap: cache.snap, staleMs: deps.now() - cache.fetchedAt }
            : null;
      } else {
        cur = await current();
      }
      if (!cur) {
        await deps.feishu.send(
          { openId: at.operatorId },
          { text: '盘面没取到：后端现在连不上，稍后再点。' },
          { uuid: uuidFor('board-miss', at.messageId, deps.now()) },
        );
        return;
      }
      let note: string | undefined;
      if (which === 'stalled') {
        await dm(at.operatorId, stalledListCard(cur.snap, ctx()), 'stalled');
        note = `卡住的清单已私聊发给${at.operatorName}。`;
      } else if (which === 'waiting') {
        await dm(at.operatorId, waitingListCard(cur.snap, ctx()), 'waiting');
        note = `等点头的清单已私聊发给${at.operatorName}。`;
      }
      // 点过的卡一定刷新一次：按钮换上新的回传值，同一个按钮过会儿还能再点。
      await deps.feishu.updateCard(at.messageId, render(cur.snap, note, cur.staleMs));
      if (pinned && at.messageId === pinned.messageId) {
        lastSignature = signature(cur.snap);
        lastPatchAt = deps.now();
      }
    },

    async sendTo(openId, which) {
      const cur = await current();
      if (!cur) {
        await deps.feishu.send(
          { openId },
          { text: '盘面还没取到：后端现在连不上，稍后再点。' },
          { uuid: uuidFor('menu-miss', openId, which, deps.now()) },
        );
        return;
      }
      const card =
        which === 'board'
          ? render(cur.snap, undefined, cur.staleMs)
          : which === 'todo'
            ? waitingListCard(cur.snap, ctx(), '我的待办')
            : activeListCard(cur.snap, ctx());
      await dm(openId, card, which);
    },

    pinned: () => pinned ?? null,
  };
}

/** 盘面「内容」的指纹：不含取数时刻，没变化就不改卡。 */
function signature(snap: BoardSnapshot): string {
  const { asOf: _asOf, ...content } = snap;
  return JSON.stringify(content);
}
