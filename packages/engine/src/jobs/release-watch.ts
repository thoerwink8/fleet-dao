// 看门狗的两条报警（2026-10-14 法国 17:03Z 发版失败事故：后端起不来、/healthz 一直 503、主线落后 19 个提交，近一小时没人知道）：
// 1. 「发版卡住」：发版进度记录（.train）停在 running 超过 TRAIN_STUCK_MS 还没收尾。这是看门狗在发版这件事上唯一报的一种：
//    发版没成（unhealthy、auto-rollback、failed、blocked）由发版接活脚本（deploy/france/release-request）写 release:failed、
//    自动发布写 auto-release:failed，各只一处报（#2369），这里不再对同一件事多报一条。
//    只有「驱动没了」——进度停在 running、没有任何脚本会再来写失败——只有看门狗能发现。
//    running 没超时是正常的一趟发版在走（自动发版每 5 分钟一班，一趟 7–10 分钟），不报。
// 2. 「健康页非 200 持续 > 10 分钟」：引擎（和后端是两个服务）自己去问 /healthz；连不上也算非 200。持续多久靠设置表记的第一次看到不健康的时刻。
// 改这里之前必须知道：
// - 判法是纯函数；读文件、问 /healthz、读写那个时刻在 real/watchdog.ts。读不到、认不出照抛，这一轮记没查成，开着的不撤（不当成发版没事）。
// - 一段一条：发版那条的键带「是哪个提交」，人点了「处理」的同一段不再打开；再出新事故是新的键。健康页那条的键带第一次不健康的时刻。
// - 标题正文不带每轮都变的话（多久了）：没变就不改卡（飞书免费版有接口次数限额）。
// - 和 jobs/red-streak.ts（同一个定时任务连着没跑全）、jobs/watchdog.ts 的定时任务新鲜度不是一回事，不看任何定时任务。
import { clip, stamp } from './reconcile-common.ts';

/** 发版卡住：watchdog:release:train:<提交前 12 位>:running。旧版本还写过 watchdog:release:<提交>:<unhealthy|auto-rollback|…>，开着的由这个前缀统一撤。 */
export const RELEASE_ATTENTION_ALERT_PREFIX = 'watchdog:release:';
/** 健康页非 200：watchdog:healthz:since-<第一次不健康的毫秒>。 */
export const HEALTHZ_ALERT_PREFIX = 'watchdog:healthz:';
/** 非 200 持续多久才报。 */
export const HEALTHZ_DOWN_MS = 10 * 60_000;
/** 提醒点进去看驾驶舱的发版页（后端起不来时页面也打不开，正文里写了到法国看什么）。 */
export const RELEASE_WATCH_LINK = '/france';
export const RELEASE_WATCH_WHY_MAX = 600;

/**
 * 发版进度记录停在 running 多久算卡住（从这一趟的 startedAt 算；老格式没有 startedAt 用 updatedAt）。
 * 依据：发版接活脚本（deploy/france/release-request/lib.mjs 的 LIMITS）各步都有上限，到上限它自己把进度写成 failed / blocked（那会立刻报）：
 * release.sh 30 分钟（排空最多 120 秒、引擎停机 TimeoutStop 6 分钟、构建、往香港传、发后 --check 都在里面）+ 等部署 3 + 检查 5
 * + 发后体检重试 15 + 其余八步各 2（stepMs）= 69 分钟；第 3 步「等收尾」已不再等（#2038）。所以过了 70 分钟还是 running，
 * 只能是驱动没了（被杀、机器重启），这才要人看；没到这个数的一律当正常在走，不拿 30 分钟这类拍脑袋的数去误报慢但正常的一趟。
 * 指挥官巡查（agents/skills/commander/scripts/patrol-lib.mjs 的 LIMITS.trainStuckMinutes）同一个数，那份在仓外跑、
 * 引不了这里；两边的测试（packages/engine/test/watchdog.test.ts、agents/test/patrol.test.ts）各自钉它不小于上面那几项加起来、最多多 5 分钟。
 */
export const TRAIN_STUCK_MS = 70 * 60_000;

/** 读到的发版现状。trainStatus 是 null 表示进度记录不在（正常）。 */
export interface ReleaseFacts {
  trainStatus: string | null;
  /** 这一趟从什么时候起（进度记录的 startedAt，没有用 updatedAt）；老格式两样都没有是 null。 */
  trainSince?: string | null;
  /** 这一趟发的提交（进度记录的 target.value）；没有是 null。 */
  trainSha?: string | null;
  /** 法国 current 指向的提交；不在、不是提交号是 null。 */
  currentSha?: string | null;
  /** 主线提交号，从新到旧（自动发布状态里的 main.commits）。没有是 null。用来判 current 是否新于旧的 failed。 */
  mainline?: readonly string[] | null;
}

/** 两个提交号是同一个（一边是另一边的前缀也算，至少 7 位）。 */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (Math.min(x.length, y.length) < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

const FAILED_TRAIN_ALERT = /^watchdog:release:train:([0-9a-f]{7,40}):failed$/;

/**
 * 开着的 `watchdog:release:train:<sha>:failed` 该不该撤。
 * 判据：进度 status 已不是 failed，或 current 已等于、新于这条键上的提交
 * （mainline 从新到旧，current 的下标更小；提交号相同也算追上）。
 * 比不出先后（没有 current、两边不都在 mainline 里）且进度仍是 failed：不凭这条判据撤。
 */
export function failedTrainAlertCleared(key: string, facts: ReleaseFacts): boolean {
  const m = FAILED_TRAIN_ALERT.exec(key);
  if (!m) return false;
  if (facts.trainStatus !== 'failed') return true;
  const failedSha = m[1] ?? '';
  const current = facts.currentSha;
  if (!current || !/^[0-9a-f]{7,40}$/.test(current)) return false;
  if (sameCommit(current, failedSha)) return true;
  const line = facts.mainline;
  if (!line || line.length === 0) return false;
  const at = (sha: string) => line.findIndex((s) => sameCommit(s, sha));
  const ci = at(current);
  const ti = at(failedSha);
  if (ci < 0 || ti < 0) return false;
  return ci < ti;
}

const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : '（进度记录没写提交）');

/** 问 /healthz 的结局。 */
export type HealthzProbe =
  | { ok: true }
  | { ok: false; status: number | null; reason: string; failing: { name: string; message: string }[] };

export type ReleaseAttentionVerdict =
  | { kind: 'fine' }
  | { kind: 'alert'; key: string; title: string; body: string };

/**
 * 进度记录停在 running 且超过 TRAIN_STUCK_MS（或是 running 却没有时间、判不了多久：老格式，照旧当要人看，不当成没事）才报；
 * 其余状态（done、aborted、没跑完的 running，以及已经由接活脚本报过的 failed / blocked）都不报。
 */
export function judgeReleaseAttention(f: ReleaseFacts, now: Date): ReleaseAttentionVerdict {
  if (f.trainStatus !== 'running') return { kind: 'fine' };
  const startMs = Date.parse(f.trainSince ?? '');
  const known = Number.isFinite(startMs);
  if (known && now.getTime() - startMs <= TRAIN_STUCK_MS) return { kind: 'fine' };
  const sha = shortSha(f.trainSha);
  const reason = known
    ? `正在发 ${sha} 的这一趟从 ${stamp(new Date(startMs))} 起停在「running」，超过 ${TRAIN_STUCK_MS / 60_000} 分钟没收尾（发版接活脚本各步上限加起来 69 分钟，到点会自己写成没成；还是 running 多半是驱动没了）`
    : `发版进度记录停在「running」（这一趟发的是 ${sha}），记录里没有起止时间（老格式），判不了是不是还在正常走`;
  return {
    kind: 'alert',
    key: `${RELEASE_ATTENTION_ALERT_PREFIX}train:${f.trainSha ? f.trainSha.slice(0, 12) : 'unknown'}:running`,
    title: `发版卡住：${sha} 这一趟超过 ${TRAIN_STUCK_MS / 60_000} 分钟没收尾，自动发版停着`,
    body: clip(
      [
        reason,
        '自动发版遇到这种情况不会再发，主线会一直落后。',
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
