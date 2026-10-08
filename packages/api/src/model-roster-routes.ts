// 没有名册命令的渠道：手工登记、撤销一个模型串（#1357）。
// 改这里之前必须知道：
// - 只对名册表里标了手工的渠道（现在是 Claude 订阅）。有名册命令的渠道 422，不往那张表里插第二套来源。
// - 写入和操作记录在同一笔事务里（db 的 registerManualModel / revokeManualModel）。重复登记不记成功的操作记录。
// - 撤销只删手工登记的那一行，不删目录里的路由。
// - 没接上（开发、内存版）回 503，不当登记成了。网关通行证不认这两条（不在 FEISHU_GATEWAY_WEB_ROUTES 里）。
import { type ManualModelCode, ManualModelError } from '@fleet-dao/db';
import { ManualModelRequest, ManualModelResponse, WebRoutes } from '@fleet-dao/shared';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { Actor } from './ports.ts';
import type { CockpitEnv } from './session.ts';

const STATUS: Record<ManualModelCode, ContentfulStatusCode> = {
  empty_model: 422,
  channel_not_found: 404,
  not_manual: 422,
  already_registered: 409,
  not_registered: 404,
  not_hand: 422,
};

export function registerModelRosterRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
): void {
  const write = (kind: 'register' | 'revoke') => async (c: Context<CockpitEnv>) => {
    const port = deps.modelRoster;
    const op = kind === 'register' ? port?.register : port?.revoke;
    if (!port || !op) {
      throw new ApiError(503, 'model_roster_unavailable', '渠道模型表的手工登记没接上');
    }
    const body = await readJson(c, ManualModelRequest);
    const actor = actorOf(c);
    const channelId = c.req.param('channelId');
    if (!channelId) throw new ApiError(404, 'channel_not_found', '没有这个渠道');
    try {
      const view = await op({
        channelId,
        modelKey: body.modelKey,
        now: deps.now(),
        actorKind: actor.kind,
        actorId: actor.id,
        via: c.get('via'),
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return reply(c, ManualModelResponse, view);
    } catch (err) {
      if (err instanceof ManualModelError) throw new ApiError(STATUS[err.code], err.code, err.message);
      throw err;
    }
  };

  app.post(WebRoutes.registerChannelModel.path, write('register'));
  app.delete(WebRoutes.revokeChannelModel.path, write('revoke'));
}
