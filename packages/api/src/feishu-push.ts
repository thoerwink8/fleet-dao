// 提醒推飞书（决定 0090「飞书只留登录和手机通知」）：驾驶舱后端每 30 秒把该推的提醒（判法在 @fleet-dao/db 的 feishu-push.ts）
// 用飞书应用机器人（api.env 的 FEISHU_APP_ID / FEISHU_APP_SECRET，和飞书登录同一个应用）发进团队群，结局记进 notification_deliveries。
// 2026-10-05 #1022 删旧飞书流程时把推送整条删了、没有接替（推送断了 9 天），这里是接替；不再靠人手放的群机器人 webhook。
// 改这里之前必须知道：
// - 团队群：机器人所在的群只有一个，就是团队群（和 deploy/hk.sh 补 FEISHU_TEAM_CHAT_ID 同一个判法）；一个群都不在、在好几个群里，
//   记「没配」（设置表 feishu.push，why 写清），看门狗马上报「要你拍」。群号缓存 6 小时，发消息报群不对时立刻重找。
// - 没配（缺凭据、认不出团队群、在开发环境）不推、不当成推过；每条没送成的照样记一次（原因进 last_error），按退避再试。
// - 发消息带 uuid（提醒编号）：飞书一小时内同一个 uuid 只发一次，送出去了却没记下、下一轮再发不会发两条。
// - 每次调飞书接口都记进飞书用量（feishu_usage_months，免费版每月 1 万次），和网关的用量同一本账。
// - 凭据不进日志、不进错误原文；飞书回的错只记 code 和 msg。
import {
  type Db,
  type FeishuPushItem,
  type FeishuPushStatus,
  pendingFeishuPushes,
  recordFeishuDelivery,
  writeFeishuPushStatus,
} from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { Logger } from './ports.ts';

export const FEISHU_OPEN_API = 'https://open.feishu.cn/open-apis';
/** 后端多久推一轮。 */
export const FEISHU_PUSH_EVERY_MS = 30_000;
/** 一轮最多推几条（飞书对一个群每秒 5 条上限，这里一条一条发）。 */
export const FEISHU_PUSH_BATCH = 10;
/** 没东西要推、还没认成团队群时，多久去认一次。 */
export const PROBE_EVERY_MS = 5 * 60_000;
/** 团队群号缓存多久。 */
export const TEAM_CHAT_TTL_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 10_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 飞书那边没成（连不上、回了非 0 的 code）。chatGone：群不对（机器人不在这个群里、群没了），要重找团队群。 */
export class FeishuSendError extends Error {
  readonly chatGone: boolean;
  constructor(message: string, chatGone = false) {
    super(message);
    this.name = 'FeishuSendError';
    this.chatGone = chatGone;
  }
}

/** 找不到唯一的团队群：不是飞书坏了，是没配好。 */
export class TeamChatUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamChatUnknownError';
  }
}

/** 机器人不在这个群、群号不对、群解散了：这几个 code 要重找团队群。 */
const CHAT_GONE_CODES = new Set([230001, 230002, 232010, 232011]);

export interface FeishuBot {
  /** 机器人所在的群（chat_id、群名）。 */
  chats(): Promise<{ chatId: string; name: string }[]>;
  /** 发一条富文本，回 message_id。 */
  send(input: {
    chatId: string;
    uuid: string;
    title: string;
    lines: string[];
    link: string | null;
  }): Promise<string>;
  /** 到现在一共调了几次飞书接口（换令牌也算），记用量用。 */
  callsMade(): number;
}

/** 真的飞书应用机器人：自己换 tenant_access_token（到期前 5 分钟换新的），数着调了几次接口。 */
export function createFeishuBot(options: {
  appId: string;
  appSecret: string;
  fetch?: Fetch;
  now?: () => number;
}): FeishuBot {
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  let token: { value: string; until: number } | null = null;
  let made = 0;

  async function call(
    path: string,
    init: RequestInit,
  ): Promise<{ code: number; msg?: string; data?: unknown } & Record<string, unknown>> {
    made += 1;
    let res: Response;
    try {
      res = await doFetch(`${FEISHU_OPEN_API}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new FeishuSendError(`连不上飞书：${errMessage(err)}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new FeishuSendError(`飞书回的不是 JSON（HTTP ${res.status}）`);
    }
    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code !== 'number')
      throw new FeishuSendError(`飞书回的认不出（HTTP ${res.status}，没有 code）`);
    if (code !== 0) {
      const msg = String((body as { msg?: unknown }).msg ?? '').slice(0, 200);
      throw new FeishuSendError(
        `飞书回了 code=${code}${msg ? ` ${msg}` : ''}（HTTP ${res.status}）`,
        CHAT_GONE_CODES.has(code),
      );
    }
    return body as { code: number; data?: unknown };
  }

  async function auth(): Promise<string> {
    if (token && token.until > now()) return token.value;
    const body = await call('/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret }),
    });
    const value = body.tenant_access_token;
    const expire = body.expire;
    if (typeof value !== 'string' || value === '') throw new FeishuSendError('飞书没给 tenant_access_token');
    const seconds = typeof expire === 'number' && expire > 0 ? expire : 3600;
    token = { value, until: now() + Math.max(60, seconds - 300) * 1000 };
    return value;
  }

  return {
    callsMade: () => made,
    async chats() {
      const out: { chatId: string; name: string }[] = [];
      let pageToken = '';
      for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({
          page_size: '100',
          ...(pageToken ? { page_token: pageToken } : {}),
        });
        const body = await call(`/im/v1/chats?${query}`, {
          headers: { authorization: `Bearer ${await auth()}` },
        });
        const data = body.data as
          | { items?: { chat_id?: unknown; name?: unknown }[]; has_more?: unknown; page_token?: unknown }
          | undefined;
        for (const c of data?.items ?? []) {
          if (typeof c.chat_id === 'string') out.push({ chatId: c.chat_id, name: String(c.name ?? '') });
        }
        if (!data?.has_more || typeof data.page_token !== 'string') return out;
        pageToken = data.page_token;
      }
      throw new FeishuSendError('机器人所在的群翻了 20 页还没翻完');
    },
    async send(input) {
      const rows: { tag: string; text: string; href?: string }[][] = input.lines.map((text) => [
        { tag: 'text', text },
      ]);
      if (input.link) rows.push([{ tag: 'a', text: '打开驾驶舱看', href: input.link }]);
      const body = await call('/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${await auth()}`,
        },
        body: JSON.stringify({
          receive_id: input.chatId,
          msg_type: 'post',
          content: JSON.stringify({ zh_cn: { title: input.title, content: rows } }),
          uuid: input.uuid,
        }),
      });
      const messageId = (body.data as { message_id?: unknown } | undefined)?.message_id;
      if (typeof messageId !== 'string' || messageId === '')
        throw new FeishuSendError('飞书说发了，却没给 message_id');
      return messageId;
    },
  };
}

const LEVEL_WORDS = { decision: '要你拍', alert: '卡住了', daily: '通知' } as const;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 一条提醒推出去的样子：标题带上是哪一类，正文最多 12 行、每行 300 字，驾驶舱链接接在最后。 */
export function pushMessage(
  item: FeishuPushItem,
  publicUrl: URL,
): { title: string; lines: string[]; link: string | null } {
  const lines = item.body
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(0, 12)
    .map((l) => clip(l, 300));
  const path = item.link?.startsWith('/') ? item.link : '/';
  return {
    title: clip(`【${LEVEL_WORDS[item.level]}】${item.title.trim() || '（没写标题）'}`, 120),
    lines,
    link: new URL(path, publicUrl).toString(),
  };
}

export interface FeishuPushDeps {
  db: Db;
  /** 没配（缺凭据、开发环境）是 null，why 写在 notConfiguredWhy。 */
  bot: FeishuBot | null;
  notConfiguredWhy: string;
  publicUrl: URL;
  now: () => Date;
  log: Logger;
  /** 这一轮调了几次飞书接口，记进用量；不给就不记。 */
  addUsage?: (calls: number, at: Date) => Promise<void>;
}

export interface FeishuPushRound {
  configured: boolean;
  why: string | null;
  sent: number;
  failed: number;
}

/** 推送的一个实例：记住团队群号和上一次写进库的状态（没变不重写）。 */
export function createFeishuPusher(deps: FeishuPushDeps) {
  let team: { chatId: string; until: number } | null = null;
  let lastStatus: string | null = null;
  let lastProbeAt = Number.NEGATIVE_INFINITY;

  async function teamChat(bot: FeishuBot, at: Date): Promise<string> {
    if (team && team.until > at.getTime()) return team.chatId;
    const chats = await bot.chats();
    if (chats.length !== 1) {
      throw new TeamChatUnknownError(
        chats.length === 0
          ? '飞书机器人不在任何群里：建好团队群、把机器人拉进去'
          : `飞书机器人在 ${chats.length} 个群里，认不出哪个是团队群（${chats.map((c) => c.name || '没名字').join('、')}）：只留团队群`,
      );
    }
    const [only] = chats;
    if (!only) throw new TeamChatUnknownError('飞书机器人不在任何群里');
    team = { chatId: only.chatId, until: at.getTime() + TEAM_CHAT_TTL_MS };
    return only.chatId;
  }

  async function remember(status: FeishuPushStatus): Promise<void> {
    const key = `${status.configured}|${status.why ?? ''}`;
    if (key === lastStatus) return;
    await writeFeishuPushStatus(deps.db, status);
    lastStatus = key;
  }

  /** 推一轮。读不到库照抛（这一轮没做成，下一轮再来）；单条没送成记进送达记录，不抛。 */
  async function once(): Promise<FeishuPushRound> {
    const at = deps.now();
    if (!deps.bot) {
      await remember({ configured: false, why: deps.notConfiguredWhy, at });
      return { configured: false, why: deps.notConfiguredWhy, sent: 0, failed: 0 };
    }
    const bot = deps.bot;
    const items = await pendingFeishuPushes(deps.db, at, FEISHU_PUSH_BATCH);
    // 没东西要推：不调飞书（省用量）。只有还没认成团队群（刚起来、上回没配好、上回连不上）时，隔 5 分钟去认一次，
    // 配好了起来就看得见、修好了状态跟着改回来；不每 30 秒调一次（飞书免费版每月 1 万次）
    const healthy = lastStatus?.startsWith('true|') === true;
    if (items.length === 0 && (healthy || at.getTime() - lastProbeAt < PROBE_EVERY_MS)) {
      return { configured: healthy || lastStatus === null, why: null, sent: 0, failed: 0 };
    }
    lastProbeAt = at.getTime();
    const before = bot.callsMade();
    const calls = () => bot.callsMade() - before;
    let chatId: string;
    try {
      chatId = await teamChat(bot, at);
    } catch (err) {
      await flushUsage(calls(), at);
      if (err instanceof TeamChatUnknownError) {
        await remember({ configured: false, why: err.message, at });
        for (const item of items) {
          await recordFeishuDelivery(deps.db, { notificationId: item.id, at, error: err.message });
        }
        return { configured: false, why: err.message, sent: 0, failed: items.length };
      }
      // 列群没列成（飞书连不上、凭据不对）：照没送成记，状态不改成「没配」（可能只是一时连不上）
      const why = `找团队群没成：${errMessage(err)}`;
      for (const item of items)
        await recordFeishuDelivery(deps.db, { notificationId: item.id, at, error: why });
      deps.log.warn('飞书推送：找团队群没成', { error: errMessage(err) });
      return { configured: true, why, sent: 0, failed: items.length };
    }
    await remember({ configured: true, why: null, at });
    let sent = 0;
    let failed = 0;
    for (const item of items) {
      const msg = pushMessage(item, deps.publicUrl);
      try {
        const messageId = await bot.send({ chatId, uuid: item.id, ...msg });
        await recordFeishuDelivery(deps.db, { notificationId: item.id, at: deps.now(), messageId });
        sent += 1;
      } catch (err) {
        if (err instanceof FeishuSendError && err.chatGone) team = null;
        await recordFeishuDelivery(deps.db, {
          notificationId: item.id,
          at: deps.now(),
          error: errMessage(err),
        });
        failed += 1;
      }
    }
    await flushUsage(calls(), at);
    if (failed > 0) deps.log.warn('飞书推送：有没送成的', { sent, failed });
    return { configured: true, why: null, sent, failed };
  }

  async function flushUsage(calls: number, at: Date): Promise<void> {
    if (calls === 0 || !deps.addUsage) return;
    try {
      await deps.addUsage(calls, at);
    } catch (err) {
      deps.log.warn('飞书推送：用量没记上', { calls, error: errMessage(err) });
    }
  }

  return { once };
}

/** 后端每 30 秒推一轮（只在正式环境起）。这一轮没做成只记日志，下一轮再来。返回停止的函数。 */
export function startFeishuPush(deps: FeishuPushDeps & { everyMs?: number }): () => void {
  const pusher = createFeishuPusher(deps);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pusher.once();
    } catch (err) {
      deps.log.warn('飞书推送：这一轮没做成', { error: errMessage(err) });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.everyMs ?? FEISHU_PUSH_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** 正式环境、飞书凭据齐了才有机器人；没有时说清缺什么。 */
export function feishuBotFromConfig(config: {
  env: string;
  feishu: { appId: string; appSecret: string } | null;
  feishuOff: boolean;
}): { bot: FeishuBot | null; why: string } {
  if (config.feishuOff) return { bot: null, why: 'FLEET_FEISHU_LOGIN=off：这台明说不接飞书' };
  if (!config.feishu) return { bot: null, why: 'api.env 缺 FEISHU_APP_ID / FEISHU_APP_SECRET' };
  return { bot: createFeishuBot(config.feishu), why: '' };
}
