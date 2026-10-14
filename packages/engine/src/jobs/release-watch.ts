// 看门狗的两条发版报警（2026-10-14 法国 17:03Z 发版失败事故：后端起不来、自动退回后健康检查也没过、/healthz 一直 503、主线落后 19 个提交，
// 近一小时没人知道；巡检和看门狗都没报）：
// 1. 「发版要人看」：发布历史（.history）最近一条是 unhealthy / auto-rollback（这一版没发成，或退回了也没好），或发版进度记录（.train）
//    停在 done / aborted 以外的状态，或自动发布的状态里写着「要人看」。自动发版因此每 5 分钟说一次「上一趟 failed，要人看」却没人看。
// 2. 「健康页非 200 持续 > 10 分钟」：引擎（和后端是两个服务）自己去问 /healthz；连不上也算非 200。持续多久靠设置表记的第一次看到不健康的时刻。
// 改这里之前必须知道：
// - 判法是纯函数；读文件、问 /healthz、读写那个时刻在 real/watchdog.ts。读不到、认不出照抛，这一轮记没查成，开着的不撤（不当成发版没事）。
// - 一段一条：发版那条的键带「是哪个提交、哪个事件」，人点了「处理」的同一段不再打开；再出新事故是新的键。健康页那条的键带第一次不健康的时刻。
// - 标题正文不带每轮都变的话（多久了）：没变就不改卡（飞书免费版有接口次数限额）。
// - 和 jobs/red-streak.ts（同一个定时任务连着没跑全）、jobs/watchdog.ts 的定时任务新鲜度不是一回事，不看任何定时任务。
import { clip, stamp } from './reconcile-common.ts';

/** 发版要人看：watchdog:release:<提交前 12 位>:<事件>。 */
export const RELEASE_ATTENTION_ALERT_PREFIX = 'watchdog:release:';
/** 健康页非 200：watchdog:healthz:since-<第一次不健康的毫秒>。 */
export const HEALTHZ_ALERT_PREFIX = 'watchdog:healthz:';
/** 非 200 持续多久才报。 */
export const HEALTHZ_DOWN_MS = 10 * 60_000;
/** 提醒点进去看驾驶舱的发版页（后端起不来时页面也打不开，正文里写了到法国看什么）。 */
export const RELEASE_WATCH_LINK = '/france';
export const RELEASE_WATCH_WHY_MAX = 600;

/** 发版历史最近一条（时间 提交号 事件 [unmerged]）。 */
export interface HistoryTail {
  at: string;
  sha: string;
  event: string;
}

/** 读到的发版现状。trainStatus、autoNote 是 null 表示那份文件不在（正常）。 */
export interface ReleaseFacts {
  last: HistoryTail | null;
  trainStatus: string | null;
  autoNote: string | null;
}

/** 问 /healthz 的结局。 */
export type HealthzProbe =
  | { ok: true }
  | { ok: false; status: number | null; reason: string; failing: { name: string; message: string }[] };

/** 发布历史原文 → 最近一条。一行都没有是 null；最后一条认不出抛（不当成没事）。 */
export function lastHistoryEntry(history: string): HistoryTail | null {
  const lines = history
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const raw = lines[lines.length - 1];
  if (raw === undefined) return null;
  const [at, sha, event] = raw.split(/\s+/);
  if (!at || !sha || !event || Number.isNaN(Date.parse(at)))
    throw new Error(`发布历史最后一行认不出：「${raw.slice(0, 80)}」`);
  return { at, sha, event };
}

/** 发版要人看的原因，一条一句；空 = 不用看。 */
export function releaseAttentionReasons(f: ReleaseFacts): string[] {
  const out: string[] = [];
  if (f.last && (f.last.event === 'unhealthy' || f.last.event === 'auto-rollback')) {
    out.push(
      f.last.event === 'unhealthy'
        ? `发布历史最近一条是「健康检查没过」（${f.last.sha.slice(0, 12)}，${stamp(new Date(f.last.at))}）`
        : `发布历史最近一条是「自动退回」（${f.last.sha.slice(0, 12)}，${stamp(new Date(f.last.at))}）：新版没发成`,
    );
  }
  if (f.trainStatus !== null && f.trainStatus !== 'done' && f.trainStatus !== 'aborted')
    out.push(`发版进度记录停在「${f.trainStatus}」`);
  if (f.autoNote?.includes('要人看')) out.push(`自动发布说：${clip(f.autoNote, 200)}`);
  return out;
}

export type ReleaseAttentionVerdict =
  | { kind: 'fine' }
  | { kind: 'alert'; key: string; title: string; body: string };

export function judgeReleaseAttention(f: ReleaseFacts): ReleaseAttentionVerdict {
  const reasons = releaseAttentionReasons(f);
  if (reasons.length === 0) return { kind: 'fine' };
  // 键认「最近一条是哪个提交的什么事件」；最近一条正常（只是进度记录、自动发布说要人看）时认进度记录的状态
  const seg = f.last ? `${f.last.sha.slice(0, 12)}:${f.last.event}` : `train:${f.trainStatus ?? 'note'}`;
  return {
    kind: 'alert',
    key: `${RELEASE_ATTENTION_ALERT_PREFIX}${seg}`,
    title: '发版要人看：新版没发成或退回了，自动发版停着',
    body: clip(
      [
        ...reasons,
        '自动发版遇到这种情况不会再发（每 5 分钟只说一次「要人看」），主线会一直落后。',
        '到法国看：/srv/fleet-dao-releases/.history 最后几行、journalctl -u fleet-api、journalctl -u fleet-release-request；修好或退回稳定版、发版成功后这条自己撤。',
      ].join('\n'),
      RELEASE_WATCH_WHY_MAX * 2,
    ),
  };
}

export type HealthzVerdict =
  | { kind: 'fine'; why: string }
  /** 非 200 但还没到 HEALTHZ_DOWN_MS：不报。 */
  | { kind: 'pending' }
  | { kind: 'alert'; key: string; title: string; body: string };

/** 键里的「第一次不健康」毫秒。 */
export const healthzKey = (since: Date): string => `${HEALTHZ_ALERT_PREFIX}since-${since.getTime()}`;

export function judgeHealthz(probe: HealthzProbe, since: Date | null, now: Date): HealthzVerdict {
  if (probe.ok) return { kind: 'fine', why: '/healthz 回 200 了' };
  if (since === null || now.getTime() - since.getTime() < HEALTHZ_DOWN_MS) return { kind: 'pending' };
  const reds = probe.failing.map((c) => `${c.name}：${c.message}`);
  return {
    kind: 'alert',
    key: healthzKey(since),
    title: '健康页（/healthz）非 200，已持续超过 10 分钟',
    body: clip(
      [
        `从 ${stamp(since)} 起一直不是 200（${probe.status === null ? '连不上' : `HTTP ${probe.status}`}）：${probe.reason}`,
        ...(reds.length > 0 ? ['红的检查：', ...reds.map((r) => `  ${r}`)] : []),
        '到法国看：systemctl status fleet-api、journalctl -u fleet-api；刚发过版的先看发版那条提醒。恢复 200 后这条自己撤。',
      ].join('\n'),
      RELEASE_WATCH_WHY_MAX * 2,
    ),
  };
}

/** /healthz 的回应 → 结局。状态码 200 才是好的；503 的正文里列红的检查（认不出正文不影响判非 200）。 */
export function parseHealthzResponse(status: number, bodyText: string): HealthzProbe {
  if (status === 200) return { ok: true };
  const failing: { name: string; message: string }[] = [];
  try {
    const checks = (JSON.parse(bodyText) as { checks?: Record<string, { ok?: unknown; message?: unknown }> })
      .checks;
    for (const [name, c] of Object.entries(checks ?? {}))
      if (c && c.ok === false) failing.push({ name, message: clip(String(c.message ?? ''), 160) });
  } catch {
    // 正文不是健康报告（502 页面之类）：只报状态码
  }
  return { ok: false, status, reason: `HTTP ${status}`, failing };
}
