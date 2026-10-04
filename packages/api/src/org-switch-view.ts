// 驾驶舱额度页顶上「会话用户切号现状」（#194，方案 v2 4.4）：从引擎落库的切号账本（db 的 session_org_state.doc）读。
// 改这里之前必须知道：
// - 驾驶舱后端不依赖引擎，所以账本的形状在这里只按「要显示的那几项」读一遍（engine 的 jobs/org-ledger.ts 是写的那一边，
//   两边的字段名对不上由 test/org-switch-view.test.ts 的夹具和引擎那边的往返测试各钉一头）。
// - 认不出（字段缺、时间不是时间）= unreadable，写明原因，不当成「没记过」：引擎读到同样的账本也不切号，驾驶舱得让人看见。
// - 没接上（开发环境的内存版没有这张表）= unavailable，不拿空冒充「没事」。
import { type Db, readLatestOrgState } from '@fleet-dao/db';
import type { OrgSwitchViewSchema } from '@fleet-dao/shared';
import { z } from 'zod';

export interface OrgSwitchPort {
  /** 最近一次更新的账本；引擎还没记过为 null。读不到抛。 */
  read(): Promise<{ doc: unknown; updatedAt: Date } | null>;
}

export function pgOrgSwitch(db: Db): OrgSwitchPort {
  return {
    read: async () => readLatestOrgState(db).then((r) => (r ? { doc: r.doc, updatedAt: r.updatedAt } : null)),
  };
}

export const ORG_SWITCH_NOT_HERE =
  '切号现状没接上：这里是开发环境的内存版，没有切号账本那张表（session_org_state），真库上才有';

type View = z.input<typeof OrgSwitchViewSchema>;

const Iso = z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), '不是时间');

const Doc = z.object({
  live: z.enum(['carpool', 'solo']).nullable(),
  liveAt: Iso.nullable(),
  onSoloSince: Iso.nullable(),
  outage: z
    .object({
      kind: z.enum(['E1', 'E2', 'E3']),
      since: Iso,
      resetsAt: Iso.nullable(),
      resetsFrom: z.enum(['api', 'text']).nullable(),
      evidence: z.string(),
    })
    .nullable(),
  channel: z
    .object({ state: z.enum(['ok', 'single', 'unavailable', 'unknown']), since: Iso, why: z.string() })
    .nullable(),
  backPending: z.object({ since: Iso }).nullable(),
  whites: z.object({ count: z.number().int().min(0) }),
  reads: z.array(
    z.union([
      z.object({ ok: z.literal(true), requestedAt: Iso }),
      z.object({ ok: z.literal(false), requestedAt: Iso, why: z.string() }),
    ]),
  ),
});

/** 账本 → 驾驶舱的形状。soloPaused 是设置里的「引擎暂不用独享」（人叫停）。 */
export function orgSwitchView(row: { doc: unknown; updatedAt: Date } | null, soloPaused: boolean): View {
  if (!row) {
    return { state: 'unavailable', why: '引擎还没记过切号现状（还没读过接口、没判过）', soloPaused };
  }
  const parsed = Doc.safeParse(row.doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      state: 'unreadable',
      why: `切号账本认不出（${issue?.path.join('.') || '整份'}：${issue?.message ?? '格式不对'}），引擎也因此不切号，要人看`,
      soloPaused,
    };
  }
  const d = parsed.data;
  const last = [...d.reads].sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt)).at(-1);
  return {
    state: 'known',
    live: d.live,
    ...(d.liveAt ? { liveAt: d.liveAt } : {}),
    ...(d.onSoloSince ? { onSoloSince: d.onSoloSince } : {}),
    ...(d.outage
      ? {
          outage: {
            kind: d.outage.kind,
            evidence: d.outage.evidence,
            since: d.outage.since,
            ...(d.outage.resetsAt ? { resetsAt: d.outage.resetsAt } : {}),
            ...(d.outage.resetsFrom ? { resetsFrom: d.outage.resetsFrom } : {}),
          },
        }
      : {}),
    ...(d.channel ? { channel: d.channel } : {}),
    ...(d.backPending ? { backPendingSince: d.backPending.since } : {}),
    whites: d.whites.count,
    ...(last
      ? {
          lastRead: {
            at: last.requestedAt,
            ok: last.ok,
            ...(last.ok ? {} : { why: last.why }),
          },
        }
      : {}),
    soloPaused,
    updatedAt: row.updatedAt.toISOString(),
  };
}
