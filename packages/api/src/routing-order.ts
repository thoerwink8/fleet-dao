// 驾驶舱「路由」页改先后和开关（母单 #1089 第二片）：用途下的模型上移 / 下移、模型下的渠道上移 / 下移、渠道开关。
// 改这里之前必须知道：
// - 先后和开关是运行时配置、留在库里（决定 0011 第 7 条）：改了直接写库，引擎下一次选路就照新的，不开 PR。库里的写法在 db 的
//   routing-order.ts（带「我看到的旧值」防两个人同时改、换位置先挪到临时位置躲唯一约束），这里只管同一个事务里记操作记录：记不下就不改。
// - 没接上（开发环境的内存版没有路由两层那两张表）由接口回 503；写不进抛，接口回 503 写明原因。不当改成了。
// - 操作记录只有两种动作：routing.order.move（模型或渠道换位置，对象 stage:<用途> 或 model:<模型>）和 routing.route.enable（渠道开关）。
import {
  auditLog,
  type Db,
  type MoveModelRouteInput,
  type MovePurposeModelInput,
  type MoveResult,
  moveModelRoute,
  movePurposeModel,
  type SetRouteEnabledInput,
  type SetRouteEnabledResult,
  setRouteEnabled,
} from '@fleet-dao/db';
import {
  MovePurposeModelRequest,
  MovePurposeModelResponse,
  StageKindSchema,
  UpdateModelRouteRequest,
  UpdateModelRouteResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, fullStack, readJson, reply } from './http.ts';
import type { Actor, NewAuditEntry } from './ports.ts';
import type { CockpitEnv } from './session.ts';

/** 改先后 / 开关的操作记录：前后两个值由改的那一步按库里实际的填。 */
export type OrderAudit = Omit<NewAuditEntry, 'before' | 'after'>;

export interface RoutingOrderPort {
  /** 用途下的一个模型上移 / 下移一位；改成了就在同一个事务里记操作记录。写不进抛。 */
  movePurposeModel(input: MovePurposeModelInput, audit: OrderAudit): Promise<MoveResult>;
  /** 模型下的一条路由上移 / 下移一位；同上。 */
  moveModelRoute(input: MoveModelRouteInput, audit: OrderAudit): Promise<MoveResult>;
  /** 开 / 关模型下的一条路由；同上。 */
  setRouteEnabled(input: SetRouteEnabledInput, audit: OrderAudit): Promise<SetRouteEnabledResult>;
}

export function pgRoutingOrder(db: Db, now: () => Date): RoutingOrderPort {
  type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
  // 和 pg-store 的 insertAudit、routing-efforts.ts 同一个写法（那份是 Store 里的私有函数，这里另起一份写同一张表）
  const record = (tx: Tx, audit: OrderAudit, before: unknown, after: unknown) =>
    tx.insert(auditLog).values({
      at: now(),
      actorKind: audit.actor.kind,
      actorId: audit.actor.id,
      action: audit.action,
      target: audit.target,
      before,
      after,
      reason: audit.reason ?? null,
      via: audit.via,
      ok: audit.ok,
      error: audit.error ?? null,
    });
  return {
    movePurposeModel: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await movePurposeModel(tx, input);
        if (!result.ok) return result;
        await record(
          tx,
          audit,
          { order: result.before },
          { order: result.after, moved: input.modelId, direction: input.direction },
        );
        return result;
      }),
    moveModelRoute: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await moveModelRoute(tx, input);
        if (!result.ok) return result;
        await record(
          tx,
          audit,
          { order: result.before },
          { order: result.after, moved: input.routeId, direction: input.direction },
        );
        return result;
      }),
    setRouteEnabled: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await setRouteEnabled(tx, input);
        if (!result.ok) return result;
        await record(
          tx,
          audit,
          { modelId: input.modelId, enabled: result.before },
          { modelId: input.modelId, enabled: result.after },
        );
        return result;
      }),
  };
}

/** 开发环境、内存版：没有路由两层那两张表。 */
export const ROUTING_ORDER_NOT_HERE =
  '改先后和开关没接上：这里是开发环境的内存版，没有路由两层那两张表（routing_purpose_models、routing_catalog），真库上才有';

/** 库里那一步没做成的几种：换成接口的错（已经在最上 / 最下 422、看到的先后过期 409、找不到 404）。 */
function moveProblem(
  result: Exclude<MoveResult, { ok: true }>,
  what: string,
  notFoundCode: string,
): ApiError {
  if (result.kind === 'not_found') return new ApiError(404, notFoundCode, result.why);
  if (result.kind === 'at_edge') return new ApiError(422, 'already_at_edge', result.why);
  return new ApiError(409, 'conflict', `${what}的先后刚被别人改过，刷新后再改`, { current: result.current });
}

export function registerRoutingOrderRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
): void {
  /** 写库的那一步抛了（连不上、事务里出错）：记日志，回 503 写明原因，不当改成了。 */
  const unwritable = (what: string, fields: Record<string, unknown>, err: unknown): ApiError => {
    deps.log.error(`${what}没改成`, { ...fields, error: fullStack(err) });
    return new ApiError(
      503,
      'routing_order_unwritable',
      (err instanceof Error && err.message) || String(err),
    );
  };

  // 用途下的一个模型上移 / 下移一位。只有网关通行证之外的登录才进得来（GATEWAY_WEB_ROUTES 里没有它）。
  app.put(WebRoutes.movePurposeModel.path, async (c) => {
    const purposeParam = c.req.param('purpose');
    const modelId = c.req.param('modelId');
    const body = await readJson(c, MovePurposeModelRequest);
    const purpose = StageKindSchema.safeParse(purposeParam);
    if (!purpose.success) throw new ApiError(404, 'purpose_not_found', `没有这个用途：${purposeParam}`);
    if (!deps.routingOrder) throw new ApiError(503, 'routing_order_not_wired', ROUTING_ORDER_NOT_HERE);
    let result: MoveResult;
    try {
      result = await deps.routingOrder.movePurposeModel(
        { purpose: purpose.data, modelId, direction: body.direction, expected: body.expected },
        {
          actor: actorOf(c),
          action: 'routing.order.move',
          target: `stage:${purpose.data}`,
          reason: body.reason,
          via: c.get('via'),
          ok: true,
        },
      );
    } catch (err) {
      throw unwritable('用途下模型的先后', { purpose: purpose.data, modelId }, err);
    }
    if (!result.ok) throw moveProblem(result, '这个用途下模型', 'model_not_found');
    return reply(c, MovePurposeModelResponse, { purpose: purpose.data, order: result.after });
  });

  // 模型下的一条渠道上移 / 下移一位，或开 / 关。
  app.put(WebRoutes.updateModelRoute.path, async (c) => {
    const modelId = c.req.param('modelId');
    const routeId = c.req.param('routeId');
    const body = await readJson(c, UpdateModelRouteRequest);
    if (!deps.routingOrder) throw new ApiError(503, 'routing_order_not_wired', ROUTING_ORDER_NOT_HERE);
    const audit = (action: string, target: string): OrderAudit => ({
      actor: actorOf(c),
      action,
      target,
      reason: body.reason,
      via: c.get('via'),
      ok: true,
    });
    try {
      if (body.op === 'move') {
        const result = await deps.routingOrder.moveModelRoute(
          { modelId, routeId, direction: body.direction, expected: body.expected },
          audit('routing.order.move', `model:${modelId}`),
        );
        if (!result.ok) throw moveProblem(result, '这个模型下渠道', 'route_not_found');
        return reply(c, UpdateModelRouteResponse, { modelId, routeId, order: result.after });
      }
      const result = await deps.routingOrder.setRouteEnabled(
        { modelId, routeId, enabled: body.enabled, expected: body.expected },
        audit('routing.route.enable', `route:${routeId}`),
      );
      if (!result.ok) {
        if (result.kind === 'not_found') throw new ApiError(404, 'route_not_found', result.why);
        throw new ApiError(409, 'conflict', '这条路由的开关刚被别人改过，刷新后再改', {
          current: result.current,
        });
      }
      return reply(c, UpdateModelRouteResponse, { modelId, routeId, enabled: result.after });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw unwritable('渠道的先后和开关', { modelId, routeId }, err);
    }
  });
}
