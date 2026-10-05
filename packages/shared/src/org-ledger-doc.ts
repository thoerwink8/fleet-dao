// 切号账本（db 的 session_org_state.doc，引擎写）里驾驶舱要读的那几项的形状（#194）。
// 引擎的写法在 engine 的 jobs/org-ledger.ts（serializeLedger），驾驶舱后端的读法在 api 的 org-switch-view.ts：两头都不能 import 对方，
// 所以读的这一头的形状放在这里，引擎的往返测试（test/org-ledger.test.ts）拿 serializeLedger 的输出过一遍它——字段改名、改形状两边会一起红，
// 不会悄悄变成驾驶舱「认不出」。
import { z } from 'zod';

const Iso = z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), '不是时间');

export const OrgLedgerViewDocSchema = z.object({
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
      z.object({
        ok: z.literal(true),
        requestedAt: Iso,
        // 烧速预估（carpool-burn.ts）要的几项：老账本没有就当这条读数没有额度，不当 0
        serverDate: Iso.nullable().optional(),
        ageSeconds: z.number().nullable().optional(),
        quota: z.object({ usedUsd: z.number(), limitUsd: z.number() }).nullable().optional(),
      }),
      z.object({ ok: z.literal(false), requestedAt: Iso, why: z.string() }),
    ]),
  ),
});

export type OrgLedgerViewDoc = z.infer<typeof OrgLedgerViewDocSchema>;
