// 「只有创始人本人能开」的门（决定 0033，取代 0017 第 1、3 条）：Fable 能进目录、能入库，但把它的路由 / 模型打开、
// 或加进 / 拖动任何用途，只认驾驶舱里创始人本人的浏览器登录态。判法只有 shared 的 founderOnlyDenial 一个，
// 开关、拖动、加进用途的接口都调这里的 guardFounderOnly，不各写各的。
// 引擎、临时指挥官（groom）、fleet-api 命令、机器通行证走不到驾驶舱的这些接口（登录 Cookie 之外一律 401 / 403），
// 这里是第二道：就算哪天有人把接口放给网关或令牌，Fable 照样拒，并写明原因。
import { type BanSubject, founderOnlyDenial, type Operator } from '@fleet-dao/shared';
import type { Context } from 'hono';
import { ApiError } from './http.ts';
import type { CockpitEnv } from './session.ts';

/** 这次请求是谁：只有「浏览器登录 Cookie 的创始人」算创始人本人；网关通行证（代表创始人也不算）和别的都不是。 */
export function operatorOf(c: Context<CockpitEnv>): Operator {
  const via = c.get('via');
  const founderInCockpit = via === 'cockpit' && c.get('session') !== undefined;
  if (founderInCockpit) return { label: '创始人（驾驶舱）', founderInCockpit };
  return { label: via === 'feishu' ? '飞书网关通行证' : '这个调用方', founderInCockpit };
}

/** 一个模型和它名下的路由，各自带上被判的名字（模型 id / 显示名 / 族、路由的上游串和别名）。 */
export interface FounderOnlySubjects {
  model: BanSubject | undefined;
  routes: { routeId: string; subject: BanSubject }[];
}

/**
 * 动手的人不是创始人本人，又碰到了「只有创始人能开」的模型 / 路由：403 founder_only，写明原因。
 * routeId 给了就只看模型本身和这一条路由；不给就看模型和它名下所有路由（模型级开关、拖动用）。
 */
export function guardFounderOnly(operator: Operator, subjects: FounderOnlySubjects, routeId?: string): void {
  const picked = [
    ...(subjects.model ? [subjects.model] : []),
    ...subjects.routes.filter((r) => routeId === undefined || r.routeId === routeId).map((r) => r.subject),
  ];
  for (const subject of picked) {
    const why = founderOnlyDenial(subject, operator);
    if (why !== undefined) throw new ApiError(403, 'founder_only', why);
  }
}
