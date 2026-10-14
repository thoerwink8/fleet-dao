// 网关的两条接口（shared 的 IntentRoutes）：进群记录、飞书接口用量（#795，方案 5.4、5.6），挂在 /api 下。
// 飞书收缩后（#2047 提需求 F1）不再收群聊、私聊的话：收原话、收撤回、补漏游标、取意图卡、卡的回执、拒收记录这几条已经删了，
// 网关带通行证来也没有地方写意图库。意图表和已有数据还在，指挥官经 ssh 跑 `fleet-api intent …`（intent-cli.ts）读写。
// 和驾驶舱那套接口同一个门：只认网关通行证（checkGatewayPass）。
// 改这里之前必须知道：
// - 用量上报：网关（香港，已从仓里删掉，机器上的旧进程还在报）每分钟报一次；停了网关、删了这两条接口之后这里随之收掉。
// - 日志不记原文，只记数量。

import {
  FEISHU_MONTHLY_CALL_LIMIT,
  FEISHU_OUTSIDER_JOINED_TITLE,
  FEISHU_USAGE_ALERT_TITLE,
  FeishuJoinRequest,
  FeishuJoinResponse,
  type FeishuRoute,
  FeishuUsageReportRequest,
  FeishuUsageSnapshot,
  feishuUsageLevel,
  feishuUsageSentence,
  IntentRoutes,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { IntentStore } from './intent-store.ts';
import { checkGatewayPass } from './session.ts';

export const INTENTS_NOT_WIRED = '飞书用量和进群记录的存储没接上（这台后端没给 intents）：这一条没存';

export function intentRoutes(deps: Deps): Hono {
  const { log } = deps;
  const app = new Hono();

  const gate =
    (route: FeishuRoute): MiddlewareHandler =>
    async (c, next) => {
      const authorization = c.req.header('authorization');
      if (authorization === undefined) {
        throw new ApiError(401, 'gateway_pass_missing', '飞书接口只给飞书网关用：要带网关通行证');
      }
      checkGatewayPass(deps.config, authorization);
      await next();
    };

  /** 按路由表挂：方法、路径都取自 IntentRoutes。 */
  const on = (route: FeishuRoute, handler: (c: Context) => Promise<Response>) =>
    app.on(route.method, route.path, gate(route), handler);

  const storeOf = (): IntentStore => {
    if (!deps.intents) throw new ApiError(503, 'intents_not_wired', INTENTS_NOT_WIRED);
    return deps.intents;
  };

  /** 记录已经留下。提醒没接上或写不进去只记错误，仍回 200：再送会把同一条证据再写一遍。 */
  const raise = async (input: { dedupeKey: string; title: string; body: string }) => {
    if (!deps.alerts) {
      log.error('驾驶舱提醒没接上，记录已经留下', { dedupeKey: input.dedupeKey });
      return;
    }
    try {
      await deps.alerts.raise(input);
    } catch (err) {
      log.error('驾驶舱提醒没写成，记录已经留下', {
        dedupeKey: input.dedupeKey,
        error: errMessage(err).slice(0, 300),
      });
    }
  };

  on(IntentRoutes.intakeJoin, async (c) => {
    const body = await readJson(c, FeishuJoinRequest);
    const recorded = await storeOf().recordJoins(body);
    log.info('记下一次进群', { chatId: body.chatId, outsiders: recorded });
    await raise({
      dedupeKey: `feishu-outsider-joined:${body.chatId}`,
      title: FEISHU_OUTSIDER_JOINED_TITLE,
      body: `群 ${body.chatId}，open_id 末 4 位 ${body.openIdTails.join('、')}，${body.at}。${body.reason}。`,
    });
    return reply(c, FeishuJoinResponse, { recorded });
  });

  on(IntentRoutes.usage, async (c) => {
    const body = await readJson(c, FeishuUsageReportRequest);
    const added = await storeOf().addUsage(body.reportId, body.calls, body.at);
    const snapshot = {
      month: added.month,
      calls: added.calls,
      limit: FEISHU_MONTHLY_CALL_LIMIT,
      readable: true as const,
    };
    if (feishuUsageLevel(snapshot) === 'over') {
      await raise({
        dedupeKey: `feishu-usage:${added.month}`,
        title: FEISHU_USAGE_ALERT_TITLE,
        body: feishuUsageSentence('over', snapshot),
      });
    }
    log.info('记下飞书用量', { month: added.month, calls: added.calls, added: body.calls });
    return reply(c, FeishuUsageSnapshot, snapshot);
  });

  return app;
}
