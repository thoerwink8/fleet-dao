// 每读到一次接口，值得在操作记录里记一笔的事（#194，方案 v2 4.1）：拼车上限变了、接口限流或 5xx 进了退避、退避结束。
// 纯判法：账本（入这条读数之前的）+ 这条读数 → 要记的几笔；真写操作记录在 real/org-switch.ts 的读数入口（所有读数都从那儿进账本）。
//
// 改这里之前必须知道：
// - 上限不写死：reclaude 标着 80 美元是「暂定的」（design 第九节），所以判法全按比例和读数走；这里只负责「变了就记一笔」，
//   不拿 80 当基准。和哪一个比：账本里最近一次读成且带额度的那条，账本里一条都没有（刚起、账本清空）不记，不拿 0 或 80 冒充「之前」。
// - 退避只记前几步（连着失败第 1、2、3 次，即 1 → 2 → 5 分钟那三档）和退避结束，封顶的 5 分钟一次不重复记，免得接口坏一晚上刷满操作记录。
// - Key 失效（auth）、回包认不出（bad_response）不在这里记：它们当场推「要人看」提醒（carpool-watch 的 apiFailureAlert）。
import type { CarpoolApiRead } from './carpool-outage.ts';
import { backoffMsFor, DEFAULT_WATCH_POLICY, trailingFailures, type WatchPolicy } from './carpool-watch.ts';
import type { OrgLedger } from './org-ledger.ts';

export interface ReadNote {
  /** 操作记录的动作名（session-org.*）。 */
  action: 'session-org.limit' | 'session-org.read-backoff';
  reason: string;
  ok: boolean;
  before?: unknown;
  after?: unknown;
  error?: string;
}

const TRANSIENT = new Set(['throttled', 'http', 'network']);
const CODE_TEXT: Readonly<Record<string, string>> = {
  throttled: '被限流（429）',
  http: '回了错误状态（多半是 5xx）',
  network: '网断或超时',
};

const num = (n: number) => String(Number(n.toFixed(2)));

function lastQuota(ledger: OrgLedger) {
  for (let i = ledger.reads.length - 1; i >= 0; i--) {
    const r = ledger.reads[i];
    if (r?.ok && r.quota) return r.quota;
  }
  return null;
}

/** prev 是这条读数入账之前的账本。 */
export function readNotes(
  prev: OrgLedger,
  read: CarpoolApiRead,
  policy: WatchPolicy = DEFAULT_WATCH_POLICY,
): ReadNote[] {
  const fails = trailingFailures(prev);
  if (!read.ok) {
    if (!TRANSIENT.has(read.code)) return [];
    const n = fails + 1;
    if (n > policy.failBackoffMs.length) return [];
    const wait = Math.round(backoffMsFor(n, policy) / 60_000);
    return [
      {
        action: 'session-org.read-backoff',
        ok: false,
        reason: `读拼车接口没成：${CODE_TEXT[read.code] ?? read.code}，连着第 ${n} 次；退避，下一次等 ${wait} 分钟再读，期间按「读不到」办`,
        after: { fails: n, waitMinutes: wait, code: read.code },
        error: read.why,
      },
    ];
  }
  const notes: ReadNote[] = [];
  if (read.quota && Number.isFinite(read.quota.limitUsd)) {
    const before = lastQuota(prev);
    if (before && Number.isFinite(before.limitUsd) && before.limitUsd !== read.quota.limitUsd) {
      notes.push({
        action: 'session-org.limit',
        ok: true,
        reason: `拼车上限从 ${num(before.limitUsd)} 变成 ${num(read.quota.limitUsd)}（接口 quota_usd，判法按比例和读数走，不写死）`,
        before: { limitUsd: before.limitUsd },
        after: { limitUsd: read.quota.limitUsd },
      });
    }
  }
  if (fails > 0) {
    notes.push({
      action: 'session-org.read-backoff',
      ok: true,
      reason: `拼车接口读成了，退避结束（之前连着 ${fails} 次没读成）`,
      after: { fails: 0 },
    });
  }
  return notes;
}
