// 看门狗的两条发版报警（2026-10-14 法国 17:03Z 发版失败事故：后端起不来、自动退回后健康检查也没过、/healthz 一直 503、主线落后 19 个提交，
// 近一小时没人知道；巡检和看门狗都没报）：
// 1. 「发版要人看」：发布历史（.history）最近一条是 unhealthy / auto-rollback（这一版没发成，或退回了也没好），或发版进度记录（.train）
//    停在 failed / blocked 这类收了尾却没成的状态、或 running 超过 TRAIN_STUCK_MS 还没收尾（卡住），或自动发布的状态里写着「要人看」。
//    running 没超时是正常的一趟发版在走（自动发版每 5 分钟一班，一趟 7–10 分钟），不报；那段时间自动发布说的「要人看」也是因为它，不报。
//    进度记录那条的键和正文认「这一趟发的是哪个提交」（target.value），不挂在发布历史最后一条（上一版）身上。
//    这一趟已经落地（进度 done、法国 current 就是目标提交，trainLanded）时，发布历史末行那句「这个提交健康检查没过」是被发后体检盖过去的旧话：
//    release.sh 没退回、停在这一版（退出码 2 一类），接活脚本之后的体检过了，不报（#2207）。
//    「自动发版停着」只在它真停着时写：自动发布的闸（deploy/france/auto-release/lib.mjs 的 gateVerdict）只看进度记录、不看发布历史，
//    所以只有进度记录收了尾却没成、卡住，或自动发布自己说「要人看」时才这么写；只是发布历史末行坏了，自动发版照常走。
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

/**
 * 发版进度记录停在 running 多久算卡住（从这一趟的 startedAt 算；老格式没有 startedAt 用 updatedAt）。
 * 依据：发版接活脚本（deploy/france/release-request/lib.mjs 的 LIMITS）各步都有上限，到上限它自己把进度写成 failed / blocked（那会立刻报）：
 * release.sh 30 分钟（排空最多 120 秒、引擎停机 TimeoutStop 6 分钟、构建、往香港传、发后 --check 都在里面）+ 等部署 3 + 检查 5
 * + 发后体检重试 15 + 其余八步各 2（stepMs）= 69 分钟；第 3 步「等收尾」已不再等（#2038）。所以过了 70 分钟还是 running，
 * 只能是驱动没了（被杀、机器重启），这才要人看；没到这个数的一律当正常在走，不拿 30 分钟这类拍脑袋的数去误报慢但正常的一趟。
 * 指挥官巡查（agents/skills/commander/scripts/patrol-lib.mjs 的 LIMITS.trainStuckMinutes 和 trainReason）同一判法、同一个数，那份在仓外跑、
 * 引不了这里；两边的测试（packages/engine/test/watchdog.test.ts、agents/test/patrol.test.ts）各自钉它不小于上面那几项加起来、最多多 5 分钟。
 */
export const TRAIN_STUCK_MS = 70 * 60_000;

/** 读到的发版现状。trainStatus、autoNote 是 null 表示那份文件不在（正常）。 */
export interface ReleaseFacts {
  last: HistoryTail | null;
  trainStatus: string | null;
  /** 这一趟从什么时候起（进度记录的 startedAt，没有用 updatedAt）；老格式两样都没有是 null。 */
  trainSince?: string | null;
  /** 这一趟发的提交（进度记录的 target.value）；没有是 null。 */
  trainSha?: string | null;
  /** 法国 current 指向的提交（全长）；不在、链的不是提交号是 null。 */
  currentSha?: string | null;
  autoNote: string | null;
}

/** 两个提交号是同一个（一边是另一边的前缀也算，至少 7 位）。 */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (Math.min(x.length, y.length) < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * 这一趟已经落地：进度 done，法国 current 就是这一趟的目标提交（接活脚本的发后体检也过了才会写 done）。
 * 同 agents/skills/commander/scripts/patrol-lib.mjs 的 trainLanded。
 */
export function trainLanded(f: ReleaseFacts): boolean {
  return f.trainStatus === 'done' && sameCommit(f.currentSha, f.trainSha);
}

/** 发布历史末行坏了（unhealthy / auto-rollback），而且没有被落地的这一趟盖过去。 */
function badHistoryTail(f: ReleaseFacts): HistoryTail | null {
  if (!f.last || (f.last.event !== 'unhealthy' && f.last.event !== 'auto-rollback')) return null;
  // 末行说的就是落地的这个提交：它停在这一版没退回，体检过了，旧话不报。auto-rollback 的末行是退回去的上一版，current 也不是目标，照报
  if (f.last.event === 'unhealthy' && trainLanded(f) && sameCommit(f.last.sha, f.currentSha)) return null;
  return f.last;
}

/**
 * 进度记录这一项怎么看：none 没有或收尾成了（done / aborted）；running 正常在走（没到 TRAIN_STUCK_MS）；
 * stuck 在走超过 TRAIN_STUCK_MS，或是 running 却没有时间判不了多久（老格式，照旧当要人看，不当成没事）；stopped 收了尾却没成（failed、blocked……）。
 */
export type TrainVerdict =
  | { kind: 'none' }
  | { kind: 'running' }
  | { kind: 'stuck'; since: Date | null }
  | { kind: 'stopped' };

export function trainVerdict(f: ReleaseFacts, now: Date): TrainVerdict {
  const s = f.trainStatus;
  if (s === null || s === 'done' || s === 'aborted') return { kind: 'none' };
  if (s !== 'running') return { kind: 'stopped' };
  const ms = Date.parse(f.trainSince ?? '');
  if (!Number.isFinite(ms)) return { kind: 'stuck', since: null };
  return now.getTime() - ms > TRAIN_STUCK_MS ? { kind: 'stuck', since: new Date(ms) } : { kind: 'running' };
}

const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : '（进度记录没写提交）');

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
export function releaseAttentionReasons(f: ReleaseFacts, now: Date): string[] {
  const out: string[] = [];
  const train = trainVerdict(f, now);
  const bad = badHistoryTail(f);
  if (bad) {
    out.push(
      bad.event === 'unhealthy'
        ? `发布历史最近一条是「健康检查没过」（${bad.sha.slice(0, 12)}，${stamp(new Date(bad.at))}）`
        : `发布历史最近一条是「自动退回」（${bad.sha.slice(0, 12)}，${stamp(new Date(bad.at))}）：新版没发成`,
    );
  }
  const sha = shortSha(f.trainSha);
  if (train.kind === 'stopped') out.push(`发版进度记录停在「${f.trainStatus}」（这一趟发的是 ${sha}）`);
  if (train.kind === 'stuck')
    out.push(
      train.since
        ? `正在发 ${sha} 的这一趟从 ${stamp(train.since)} 起停在「running」，超过 ${TRAIN_STUCK_MS / 60_000} 分钟没收尾（发版接活脚本各步上限加起来 69 分钟，到点会自己写成没成；还是 running 多半是驱动没了）`
        : `发版进度记录停在「running」（这一趟发的是 ${sha}），记录里没有起止时间（老格式），判不了是不是还在正常走`,
    );
  if (noteCounts(f, train)) out.push(`自动发布说：${clip(f.autoNote ?? '', 200)}`);
  return out;
}

/** 自动发布那句「要人看」算不算（不算的见 trainNote）。 */
function noteCounts(f: ReleaseFacts, train: TrainVerdict): boolean {
  if (!f.autoNote?.includes('要人看')) return false;
  const trainOnly =
    trainNote(f.autoNote) && (train.kind === 'running' || (train.kind === 'none' && f.trainStatus !== null));
  return !trainOnly;
}

/**
 * 自动发布这句「要人看」是不是只因为进度记录的状态（deploy/france/auto-release/lib.mjs 的 gateVerdict：「上一趟发版是「X」状态，要人看」）。
 * 是的话进度记录这边自己判：一趟正常在走（running 没超时）时它说的就是这一趟；刚收尾成了（done / aborted）时它还是上一班（每 5 分钟一班）写的旧话。这两种不报；进度记录不在却这么说对不上，照报。
 */
const trainNote = (note: string) => note.includes('上一趟发版是「');

export type ReleaseAttentionVerdict =
  | { kind: 'fine' }
  | { kind: 'alert'; key: string; title: string; body: string };

export function judgeReleaseAttention(f: ReleaseFacts, now: Date): ReleaseAttentionVerdict {
  const reasons = releaseAttentionReasons(f, now);
  if (reasons.length === 0) return { kind: 'fine' };
  const badLast = badHistoryTail(f);
  const train = trainVerdict(f, now);
  // 自动发版真停着：闸只看进度记录（收了尾却没成、卡住都不发），或它自己说了「要人看」
  const autoStopped = train.kind === 'stuck' || train.kind === 'stopped' || noteCounts(f, train);
  const sha = shortSha(f.trainSha);
  // 键：发布历史最近一条坏了认「那个提交的什么事件」；不然是进度记录的事，认「这一趟发的提交 + 状态」（不挂在上一版身上）；
  // 只剩自动发布说要人看认 note
  const seg = badLast
    ? `${badLast.sha.slice(0, 12)}:${badLast.event}`
    : train.kind === 'stuck' || train.kind === 'stopped'
      ? `train:${f.trainSha ? f.trainSha.slice(0, 12) : 'unknown'}:${f.trainStatus}`
      : 'note';
  const title = badLast
    ? `发版要人看：新版没发成或退回了${autoStopped ? '，自动发版停着' : ''}`
    : train.kind === 'stuck'
      ? `发版卡住：${sha} 这一趟超过 ${TRAIN_STUCK_MS / 60_000} 分钟没收尾，自动发版停着`
      : train.kind === 'stopped'
        ? `发版要人看：${sha} 这一趟停在「${f.trainStatus}」，自动发版停着`
        : '发版要人看：自动发布停着';
  return {
    kind: 'alert',
    key: `${RELEASE_ATTENTION_ALERT_PREFIX}${seg}`,
    title,
    body: clip(
      [
        ...reasons,
        autoStopped
          ? '自动发版遇到这种情况不会再发（每 5 分钟只说一次「要人看」），主线会一直落后。'
          : '自动发版没停：主线头 CI 绿了照常再发；这条是要人看上一趟为什么没发成。',
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
