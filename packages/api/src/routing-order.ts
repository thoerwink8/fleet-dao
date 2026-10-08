// 驾驶舱「路由」页改先后和开关（母单 #1089 第二片）：用途下的模型上移 / 下移、模型下的渠道上移 / 下移、渠道开关。
// 改这里之前必须知道：
// - 先后和开关是运行时配置、留在库里（决定 0011 第 7 条）：改了直接写库，引擎下一次选路就照新的，不开 PR。库里的写法在 db 的
//   routing-order.ts（带「我看到的旧值」防两个人同时改、换位置先挪到临时位置躲唯一约束），这里只管同一个事务里记操作记录：记不下就不改。
// - 没接上（开发环境的内存版没有路由两层那两张表）由接口回 503；写不进抛，接口回 503 写明原因。不当改成了。
// - 操作记录：routing.order.move（模型或渠道换位置，对象 stage:<用途> 或 model:<模型>）、routing.route.enable（一条路由的开关）、routing.model.enable（模型开关）、channel.enable / channel.disable（渠道开关）、routing.purpose.add / routing.purpose.remove / routing.purpose.effort（加进用途、移出、改这个用途下的档位，对象 stage:<用途>）。
import {
  type AddPurposeModelInput,
  addPurposeModel,
  auditLog,
  type Db,
  type MoveModelRouteInput,
  type MovePurposeModelInput,
  type MoveResult,
  models,
  moveModelRoute,
  movePurposeModel,
  type PurposeWriteResult,
  type RemovePurposeModelInput,
  type ReorderModelRoutesInput,
  type ReorderPurposeModelsInput,
  removePurposeModel,
  reorderModelRoutes,
  reorderPurposeModels,
  routes,
  type SetChannelEnabledFlagInput,
  type SetChannelEnabledFlagResult,
  type SetModelEnabledInput,
  type SetModelEnabledResult,
  type SetPurposeModelEffortInput,
  type SetRouteEnabledInput,
  type SetRouteEnabledResult,
  setChannelEnabledFlag,
  setModelEnabled,
  setPurposeModelEffort,
  setRouteEnabled,
} from '@fleet-dao/db';
import {
  AddPurposeModelRequest,
  MovePurposeModelRequest,
  MovePurposeModelResponse,
  PurposeMembershipResponse,
  RemovePurposeModelRequest,
  SetChannelEnabledRequest,
  SetChannelEnabledResponse,
  SetModelEnabledRequest,
  SetModelEnabledResponse,
  SetPurposeModelEffortRequest,
  StageKindSchema,
  UpdateModelRouteRequest,
  UpdateModelRouteResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { type FounderOnlySubjects, guardFounderOnly, operatorOf } from './founder-only.ts';
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
  /** 用途下的模型拖到新先后（整段重排）；改成了就在同一个事务里记操作记录。 */
  reorderPurposeModels(input: ReorderPurposeModelsInput, audit: OrderAudit): Promise<MoveResult>;
  /** 模型下的路由拖到新先后；同上。 */
  reorderModelRoutes(input: ReorderModelRoutesInput, audit: OrderAudit): Promise<MoveResult>;
  /** 开 / 关一个模型（它下面的路由全部一起开或关）；同上。 */
  setModelEnabled(input: SetModelEnabledInput, audit: OrderAudit): Promise<SetModelEnabledResult>;
  /** 开 / 关一个渠道（channels.enabled）；同上。 */
  setChannelEnabled(
    input: SetChannelEnabledFlagInput,
    audit: OrderAudit,
  ): Promise<SetChannelEnabledFlagResult>;
  /** 把目录里的模型加进用途；改成了就在同一个事务里记操作记录。 */
  addPurposeModel(input: AddPurposeModelInput, audit: OrderAudit): Promise<PurposeWriteResult>;
  /** 把模型移出用途；同上。用途可以变空。 */
  removePurposeModel(input: RemovePurposeModelInput, audit: OrderAudit): Promise<PurposeWriteResult>;
  /** 改这个用途下这个模型的档位；同上。 */
  setPurposeModelEffort(input: SetPurposeModelEffortInput, audit: OrderAudit): Promise<PurposeWriteResult>;
  /** 一个模型和它名下路由的「被判的名字」（给「只有创始人能开」的门用，founder-only.ts）。模型库里没有 = model 为空。 */
  subjectsOf(modelId: string): Promise<FounderOnlySubjects>;
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
    subjectsOf: async (modelId) => {
      const [model] = await db.select().from(models).where(eq(models.id, modelId));
      const rows = await db.select().from(routes).where(eq(routes.modelId, modelId));
      return {
        model,
        routes: model
          ? rows.map((r) => ({
              routeId: r.id,
              subject: { ...model, upstreamModel: r.upstreamModel, upstreamAliases: r.upstreamAliases },
            }))
          : [],
      };
    },
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
    reorderPurposeModels: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await reorderPurposeModels(tx, input);
        if (!result.ok || sameList(result.before, result.after)) return result;
        await record(tx, audit, { order: result.before }, { order: result.after, moved: input.modelId });
        return result;
      }),
    reorderModelRoutes: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await reorderModelRoutes(tx, input);
        if (!result.ok || sameList(result.before, result.after)) return result;
        await record(tx, audit, { order: result.before }, { order: result.after, moved: input.routeId });
        return result;
      }),
    setModelEnabled: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await setModelEnabled(tx, input);
        if (!result.ok) return result;
        await record(
          tx,
          audit,
          { enabledRouteIds: result.before },
          { enabled: input.enabled, enabledRouteIds: result.after },
        );
        return result;
      }),
    setChannelEnabled: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await setChannelEnabledFlag(tx, input);
        if (!result.ok) return result;
        await record(tx, audit, { enabled: result.before }, { enabled: result.after });
        return result;
      }),
    addPurposeModel: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await addPurposeModel(tx, input);
        if (!result.ok) return result;
        await record(
          tx,
          audit,
          { version: result.beforeVersion, order: result.before },
          {
            version: result.version,
            order: result.order,
            added: input.modelId,
            position: input.position ?? null,
            effort: input.effort ?? null,
          },
        );
        return result;
      }),
    removePurposeModel: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await removePurposeModel(tx, input);
        if (!result.ok) return result;
        await record(
          tx,
          audit,
          { version: result.beforeVersion, order: result.before },
          { version: result.version, order: result.order, removed: input.modelId },
        );
        return result;
      }),
    setPurposeModelEffort: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await setPurposeModelEffort(tx, input);
        if (!result.ok) return result;
        await record(
          tx,
          audit,
          { version: result.beforeVersion, order: result.before },
          { version: result.version, order: result.order, modelId: input.modelId, effort: input.effort },
        );
        return result;
      }),
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

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
  if (result.kind === 'invalid') return new ApiError(422, 'order_invalid', result.why);
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

  /**
   * 「只有创始人本人能开」的门（决定 0033）：开关（打开）、拖动、加进用途的接口动手之前都过这一步，同一个判法
   * （shared 的 founderOnlyDenial）。读不到模型 / 路由的名字就抛 503，不当成「不是 Fable」放过去。
   */
  const requireFounderForFounderOnly = async (
    c: Context<CockpitEnv>,
    port: RoutingOrderPort,
    modelId: string,
    routeId?: string,
  ): Promise<void> => {
    let subjects: FounderOnlySubjects;
    try {
      subjects = await port.subjectsOf(modelId);
    } catch (err) {
      throw unwritable('模型的名字', { modelId }, err);
    }
    guardFounderOnly(operatorOf(c), subjects, routeId);
  };

  // 用途下的一个模型上移 / 下移一位。只有网关通行证之外的登录才进得来（GATEWAY_WEB_ROUTES 里没有它）。
  app.put(WebRoutes.movePurposeModel.path, async (c) => {
    const purposeParam = c.req.param('purpose');
    const modelId = c.req.param('modelId');
    const body = await readJson(c, MovePurposeModelRequest);
    const purpose = StageKindSchema.safeParse(purposeParam);
    if (!purpose.success) throw new ApiError(404, 'purpose_not_found', `没有这个用途：${purposeParam}`);
    if (!deps.routingOrder) throw new ApiError(503, 'routing_order_not_wired', ROUTING_ORDER_NOT_HERE);
    await requireFounderForFounderOnly(c, deps.routingOrder, modelId);
    const audit: OrderAudit = {
      actor: actorOf(c),
      action: 'routing.order.move',
      target: `stage:${purpose.data}`,
      reason: body.reason,
      via: c.get('via'),
      ok: true,
    };
    let result: MoveResult;
    try {
      result =
        'order' in body
          ? await deps.routingOrder.reorderPurposeModels(
              { purpose: purpose.data, modelId, order: body.order, expected: body.expected },
              audit,
            )
          : await deps.routingOrder.movePurposeModel(
              { purpose: purpose.data, modelId, direction: body.direction, expected: body.expected },
              audit,
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
    // 关掉谁都能关（往安全那边改）；打开和换位置才要过「只有创始人能开」
    if (body.op !== 'enable' || body.enabled) {
      await requireFounderForFounderOnly(c, deps.routingOrder, modelId, routeId);
    }
    const audit = (action: string, target: string): OrderAudit => ({
      actor: actorOf(c),
      action,
      target,
      reason: body.reason,
      via: c.get('via'),
      ok: true,
    });
    try {
      if (body.op === 'move' || body.op === 'reorder') {
        const result =
          body.op === 'move'
            ? await deps.routingOrder.moveModelRoute(
                { modelId, routeId, direction: body.direction, expected: body.expected },
                audit('routing.order.move', `model:${modelId}`),
              )
            : await deps.routingOrder.reorderModelRoutes(
                { modelId, routeId, order: body.order, expected: body.expected },
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
        if (result.kind === 'banned') throw new ApiError(422, 'model_not_allowed', result.why);
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

  // 模型级开关：这个模型下的路由全部打开或全部关掉。选路仍看每条路由的 enabled。
  app.put(WebRoutes.setModelEnabled.path, async (c) => {
    const modelId = c.req.param('modelId');
    const body = await readJson(c, SetModelEnabledRequest);
    if (!deps.routingOrder) throw new ApiError(503, 'routing_order_not_wired', ROUTING_ORDER_NOT_HERE);
    if (body.enabled) await requireFounderForFounderOnly(c, deps.routingOrder, modelId);
    let result: SetModelEnabledResult;
    try {
      result = await deps.routingOrder.setModelEnabled(
        { modelId, enabled: body.enabled, expectedEnabled: body.expectedEnabled },
        {
          actor: actorOf(c),
          action: 'routing.model.enable',
          target: `model:${modelId}`,
          reason: body.reason,
          via: c.get('via'),
          ok: true,
        },
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw unwritable('模型的开关', { modelId }, err);
    }
    if (!result.ok) {
      if (result.kind === 'not_found') throw new ApiError(404, 'model_not_found', result.why);
      if (result.kind === 'banned') throw new ApiError(422, 'model_not_allowed', result.why);
      throw new ApiError(409, 'conflict', '这个模型的开关刚被别人改过，刷新后再改', {
        current: result.current,
      });
    }
    return reply(c, SetModelEnabledResponse, {
      modelId,
      enabled: body.enabled,
      enabledRouteIds: result.after,
    });
  });

  // 渠道级开关。已删的 PATCH /routing/channels/:id 不在这里，那条保持 404。
  app.put(WebRoutes.setChannelEnabled.path, async (c) => {
    const channelId = c.req.param('channelId');
    const body = await readJson(c, SetChannelEnabledRequest);
    if (!deps.routingOrder) throw new ApiError(503, 'routing_order_not_wired', ROUTING_ORDER_NOT_HERE);
    let result: SetChannelEnabledFlagResult;
    try {
      result = await deps.routingOrder.setChannelEnabled(
        { channelId, enabled: body.enabled, expected: body.expected },
        {
          actor: actorOf(c),
          action: body.enabled ? 'channel.enable' : 'channel.disable',
          target: `channel:${channelId}`,
          reason: body.reason,
          via: c.get('via'),
          ok: true,
        },
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw unwritable('渠道的开关', { channelId }, err);
    }
    if (!result.ok) {
      if (result.kind === 'not_found') throw new ApiError(404, 'channel_not_found', result.why);
      throw new ApiError(409, 'conflict', '这个渠道的开关刚被别人改过，刷新后再改', {
        current: result.current,
      });
    }
    return reply(c, SetChannelEnabledResponse, { channelId, enabled: result.after });
  });

  const membershipProblem = (result: Exclude<PurposeWriteResult, { ok: true }>): ApiError => {
    if (result.kind === 'not_found') return new ApiError(404, 'model_not_found', result.why);
    if (result.kind === 'already') return new ApiError(409, 'already_in_purpose', result.why);
    if (result.kind === 'banned') return new ApiError(422, 'model_not_allowed', result.why);
    if (result.kind === 'invalid') return new ApiError(422, result.code, result.why);
    return new ApiError(409, 'conflict', '这个用途刚被别人改过，刷新后再改', { version: result.version });
  };

  const membershipAudit = (
    c: Context<CockpitEnv>,
    action: string,
    purpose: string,
    reason?: string,
  ): OrderAudit => ({
    actor: actorOf(c),
    action,
    target: `stage:${purpose}`,
    reason,
    via: c.get('via'),
    ok: true,
  });

  // 把目录里的模型加进用途。只有驾驶舱登录进得来（GATEWAY_WEB_ROUTES 里没有它）。
  app.post(WebRoutes.addPurposeModel.path, async (c) => {
    const purposeParam = c.req.param('purpose');
    const body = await readJson(c, AddPurposeModelRequest);
    const purpose = StageKindSchema.safeParse(purposeParam);
    if (!purpose.success) throw new ApiError(404, 'purpose_not_found', `没有这个用途：${purposeParam}`);
    if (!deps.routingOrder) throw new ApiError(503, 'routing_order_not_wired', ROUTING_ORDER_NOT_HERE);
    await requireFounderForFounderOnly(c, deps.routingOrder, body.modelId);
    let result: PurposeWriteResult;
    try {
      result = await deps.routingOrder.addPurposeModel(
        {
          purpose: purpose.data,
          modelId: body.modelId,
          ...(body.position !== undefined ? { position: body.position } : {}),
          ...(body.effort !== undefined ? { effort: body.effort } : {}),
          version: body.version,
        },
        membershipAudit(c, 'routing.purpose.add', purpose.data, body.reason),
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw unwritable('往用途里加模型', { purpose: purpose.data, modelId: body.modelId }, err);
    }
    if (!result.ok) throw membershipProblem(result);
    return reply(c, PurposeMembershipResponse, {
      purpose: purpose.data,
      version: result.version,
      order: result.order,
    });
  });

  app.delete(WebRoutes.removePurposeModel.path, async (c) => {
    const purposeParam = c.req.param('purpose');
    const modelId = c.req.param('modelId');
    const body = await readJson(c, RemovePurposeModelRequest);
    const purpose = StageKindSchema.safeParse(purposeParam);
    if (!purpose.success) throw new ApiError(404, 'purpose_not_found', `没有这个用途：${purposeParam}`);
    if (!deps.routingOrder) throw new ApiError(503, 'routing_order_not_wired', ROUTING_ORDER_NOT_HERE);
    let result: PurposeWriteResult;
    try {
      result = await deps.routingOrder.removePurposeModel(
        { purpose: purpose.data, modelId, version: body.version },
        membershipAudit(c, 'routing.purpose.remove', purpose.data, body.reason),
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw unwritable('把模型移出用途', { purpose: purpose.data, modelId }, err);
    }
    if (!result.ok) throw membershipProblem(result);
    return reply(c, PurposeMembershipResponse, {
      purpose: purpose.data,
      version: result.version,
      order: result.order,
    });
  });

  app.put(WebRoutes.setPurposeModelEffort.path, async (c) => {
    const purposeParam = c.req.param('purpose');
    const modelId = c.req.param('modelId');
    const body = await readJson(c, SetPurposeModelEffortRequest);
    const purpose = StageKindSchema.safeParse(purposeParam);
    if (!purpose.success) throw new ApiError(404, 'purpose_not_found', `没有这个用途：${purposeParam}`);
    if (!deps.routingOrder) throw new ApiError(503, 'routing_order_not_wired', ROUTING_ORDER_NOT_HERE);
    let result: PurposeWriteResult;
    try {
      result = await deps.routingOrder.setPurposeModelEffort(
        { purpose: purpose.data, modelId, effort: body.effort, version: body.version },
        membershipAudit(c, 'routing.purpose.effort', purpose.data, body.reason),
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw unwritable('改用途下的档位', { purpose: purpose.data, modelId }, err);
    }
    if (!result.ok) throw membershipProblem(result);
    return reply(c, PurposeMembershipResponse, {
      purpose: purpose.data,
      version: result.version,
      order: result.order,
    });
  });
}
