// 调度台「最近改动」：把操作记录里一条 stage_policy.update 读成白话，并判断还能不能一键撤回。
import { UpdateStagePolicyRequest } from '@fleet-dao/shared';
import type { AuditEntry, Routing, StageKind, StagePolicy } from '../api/types';
import { routeInfo, STAGES, stageLabel } from './catalog';

export type PolicyValue = Pick<StagePolicy, 'routeIds' | 'pinned'>;

/** 后端写进操作记录的 before/after 就是 UpdateStagePolicyRequest 的 expected 那一段，照它解析。 */
const PolicyShape = UpdateStagePolicyRequest.shape.expected;

export function samePolicy(a: PolicyValue, b: PolicyValue): boolean {
  return (
    a.pinned === b.pinned &&
    a.routeIds.length === b.routeIds.length &&
    a.routeIds.every((x, i) => x === b.routeIds[i])
  );
}

/** 路由的短名：模型 + 账号池。同一个模型常挂在好几个池上，只写模型名分不清是哪条。 */
export function routeShort(routing: Routing, rid: string): string {
  const info = routeInfo(routing, rid);
  return info ? `${info.model}（${info.poolId}）` : rid;
}

export interface PolicyChange {
  stage: StageKind | undefined;
  before?: PolicyValue;
  after?: PolicyValue;
  summary: string;
}

export function describeChange(routing: Routing, e: AuditEntry): PolicyChange {
  const stageId = e.target.startsWith('stage:') ? e.target.slice('stage:'.length) : '';
  const stage = STAGES.find((s) => s.id === stageId)?.id;
  const name = stage ? `「${stageLabel[stage]}」` : e.target;
  const before = PolicyShape.safeParse(e.before);
  const after = PolicyShape.safeParse(e.after);
  if (!before.success || !after.success) return { stage, summary: `改了${name}（记录里没有前后对比）` };
  const b = before.data;
  const a = after.data;
  const parts: string[] = [];
  if (b.pinned !== a.pinned) parts.push(a.pinned ? '钉住了' : '取消钉住');
  const added = a.routeIds.filter((x) => !b.routeIds.includes(x));
  const removed = b.routeIds.filter((x) => !a.routeIds.includes(x));
  if (added.length) parts.push(`加上 ${added.map((x) => routeShort(routing, x)).join('、')}`);
  if (removed.length) parts.push(`去掉 ${removed.map((x) => routeShort(routing, x)).join('、')}`);
  if (!added.length && !removed.length) {
    const moved = a.routeIds.flatMap((rid, to) => {
      const from = b.routeIds.indexOf(rid);
      return from === to ? [] : [{ rid, from, to }];
    });
    const [x, y] = moved;
    if (moved.length === 2 && x && y && x.from === y.to && y.from === x.to) {
      parts.push(`${routeShort(routing, x.rid)}和 ${routeShort(routing, y.rid)}对调了位置`);
    } else if (x) {
      // 一条跳了好几位时，中间的都顺移一位；说跳得最远的那条（一样远就说往后挪的，通常是被降下去的那条）。
      const far = (m: typeof x) => Math.abs(m.to - m.from);
      const pick = moved.reduce(
        (m, c) => (far(c) > far(m) || (far(c) === far(m) && c.to > c.from) ? c : m),
        x,
      );
      parts.push(`把 ${routeShort(routing, pick.rid)}从第 ${pick.from + 1} 挪到第 ${pick.to + 1}`);
    }
  }
  return {
    stage,
    before: b,
    after: a,
    summary: `${name}${parts.length ? `：${parts.join('，')}` : '：没有变化'}`,
  };
}
