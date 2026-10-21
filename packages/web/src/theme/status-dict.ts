// 状态字典（#3509，方案第三节）：全站的状态词和颜色等级只在这一份里写。
// 内容从 understand/status-dict.json 来（153 条，9 个域，每条在源码里的出处见那份 JSON）。
//
// 规矩：
// - 只有异常才是 warning / error；正常是 success；进行中是 processing；排队、已关、等人、人为停用是 default。
// - 同一个中文在全站只有一个 level（status-dict.test.ts 守）。
// - 页面用 <StatusBadge status="task:running" />，不传 tone、label，也不自己拼状态词。
// - 后端来的原始值先过 toStatus(domain, raw)：认不出的返回 'unknown'（灰「未知」），并记一次 console.warn。

/** 颜色等级。success、processing、default 画圆点加字；warning（橙）、error（红）在要强调的地方画底色标签。 */
export type Level = 'processing' | 'success' | 'warning' | 'error' | 'default';

export const LEVELS: readonly Level[] = ['processing', 'success', 'warning', 'error', 'default'];

export interface StatusEntry {
  readonly label: string;
  readonly level: Level;
}

export const STATUS_DICT = {
  task: {
    queued: { label: '排队中', level: 'default' },
    triaging: { label: '分诊中', level: 'processing' },
    asking: { label: '卡在旧追问', level: 'warning' },
    planning: { label: '写方案', level: 'processing' },
    running: { label: '在干活', level: 'processing' },
    merging: { label: '合并中', level: 'processing' },
    done: { label: '已完成', level: 'success' },
    stopped: { label: '已叫停', level: 'default' },
    failed: { label: '失败', level: 'error' },
    stalled: { label: '停滞', level: 'warning' },
    'segment:done': { label: '完成', level: 'success' },
    'segment:timeout': { label: '超时', level: 'error' },
    'segment:killed': { label: '被停掉', level: 'default' },
    'segment:spawn_failed': { label: '没起来', level: 'error' },
    'segment:admission_blocked': { label: '内存满没放行', level: 'warning' },
    'segment:failed': { label: '失败', level: 'error' },
    'segment:org_switch': { label: '切号停下，切完重跑', level: 'default' },
  },
  tone: {
    run: { label: '在跑', level: 'processing' },
    wait: { label: '在等', level: 'default' },
    human: { label: '等你', level: 'default' },
    stall: { label: '停滞', level: 'warning' },
    fail: { label: '失败', level: 'error' },
    done: { label: '完成', level: 'success' },
    stop: { label: '叫停', level: 'default' },
    doubt: { label: '疑似换模型', level: 'warning' },
  },
  notification: {
    decision: { label: '要你拍', level: 'default' },
    alert: { label: '卡住报警', level: 'warning' },
    daily: { label: '日报', level: 'default' },
    'repair:queued': { label: '已排队', level: 'default' },
    'repair:no-receipt': { label: '没收到回执', level: 'warning' },
    'repair:executing': { label: '执行中', level: 'processing' },
    'repair:verifying': { label: '核验中', level: 'processing' },
    'repair:verified': { label: '已修复', level: 'success' },
    'repair:failed': { label: '没修成', level: 'error' },
    'repair:unknown': { label: '结果未知', level: 'warning' },
    'repair:declined': { label: '没执行', level: 'default' },
    'repair:handed': { label: '已交给修复', level: 'processing' },
    'link:invalid': { label: '关联已失效', level: 'error' },
    'link:pr-open': { label: 'PR 开着', level: 'processing' },
    'link:worker-active': { label: '已有任务在做', level: 'processing' },
    'link:linked': { label: '已关联，待处理', level: 'default' },
  },
  job: {
    fresh: { label: '按期', level: 'success' },
    running: { label: '在跑', level: 'processing' },
    partial: { label: '没查全', level: 'warning' },
    unscanned: { label: '没查全', level: 'warning' },
    overdue: { label: '过期', level: 'warning' },
    never: { label: '从没跑成', level: 'warning' },
    failed: { label: '失败', level: 'error' },
    'hero:fail': { label: '要处理', level: 'error' },
    'hero:stall': { label: '要留意', level: 'warning' },
    'hero:ok': { label: '都正常', level: 'success' },
  },
  route: {
    live: { label: '在线', level: 'success' },
    fault: { label: '故障', level: 'error' },
    interrupted: { label: '检测中断', level: 'error' },
    degraded: { label: '疑似换模型', level: 'warning' },
    blocked: { label: '暂时挡着', level: 'warning' },
    unknown: { label: '不知道', level: 'warning' },
    held: { label: '池暂停', level: 'warning' },
    unprobed: { label: '没探', level: 'default' },
    off: { label: '已关', level: 'default' },
    unused: { label: '未被用途使用', level: 'default' },
    retired: { label: '已下架', level: 'default' },
    'channel:partial': { label: '部分路故障', level: 'warning' },
    'channel:failover': { label: '运行中失败，已顺延', level: 'error' },
    'channel:metered': { label: '按量计费，不自动探', level: 'default' },
    'channel:quota-all': { label: '连通但额度耗尽', level: 'warning' },
    'channel:quota-part': { label: '部分路额度耗尽', level: 'warning' },
    'probe:passed': { label: '通过', level: 'success' },
    'probe:failed': { label: '不通', level: 'error' },
    'probe:doubt': { label: '疑似换模型', level: 'warning' },
    'probe:quota': { label: '连通但额度耗尽', level: 'warning' },
    'probe:not_probed': { label: '没探', level: 'default' },
    'pool:ban': { label: '封号', level: 'error' },
    'pool:hold-unread': { label: '没读到', level: 'warning' },
  },
  request: {
    'request:discussing': { label: '讨论中', level: 'processing' },
    'request:pending_decision': { label: '待拍板', level: 'default' },
    'request:idle_close': { label: '收口', level: 'default' },
    'request:closed_drop': { label: '不做', level: 'default' },
    'request:awaiting_issue': { label: '等开单', level: 'processing' },
    'request:doing': { label: '在做', level: 'processing' },
    'request:merged': { label: '已合并', level: 'success' },
    'request:deployed': { label: '已上线', level: 'success' },
    'request:issues_closed': { label: '单子关了', level: 'default' },
    'issue:open': { label: '开着', level: 'success' },
    'issue:merged': { label: '已合并', level: 'success' },
    'issue:deployed': { label: '已上线', level: 'success' },
    'issue:closed': { label: '关了', level: 'default' },
  },
  release: {
    'step:done': { label: '走过', level: 'success' },
    'step:current': { label: '在走', level: 'processing' },
    'step:blocked': { label: '卡住', level: 'warning' },
    'step:failed': { label: '没成', level: 'error' },
    'step:todo': { label: '没到', level: 'default' },
    'ci:green': { label: 'CI 绿', level: 'success' },
    'ci:red': { label: 'CI 红', level: 'error' },
    'ci:pending': { label: 'CI 在跑', level: 'processing' },
    'ci:unreadable': { label: 'CI 没读到', level: 'warning' },
    'check:pass': { label: '通过', level: 'success' },
    'check:fail': { label: '没过', level: 'error' },
  },
  machine: {
    'engine:on': { label: '运行中', level: 'success' },
    'engine:off': { label: '按配置没开', level: 'default' },
    'engine:down': { label: '没连上', level: 'error' },
    'engine:unknown': { label: '没读到', level: 'warning' },
    'master:on': { label: '开着', level: 'success' },
    'master:off': { label: '关着', level: 'default' },
    'dispatch:on': { label: '接活中', level: 'success' },
    'dispatch:off': { label: '关着', level: 'default' },
    'node:fresh': { label: '在线', level: 'success' },
    'node:stale': { label: '失联', level: 'warning' },
    'node:never': { label: '没数据', level: 'default' },
    'node:reporting': { label: '在上报', level: 'success' },
    'node:not-reporting': { label: '没上报', level: 'warning' },
    'meter:ok': { label: '正常', level: 'success' },
    'meter:tight': { label: '紧', level: 'warning' },
    'meter:unread': { label: '没读到', level: 'warning' },
    'meter:stale': { label: '读数旧了', level: 'warning' },
    'disk:incomplete': { label: '不全', level: 'warning' },
    'version:current': { label: '已是最新', level: 'success' },
    'version:behind': { label: '落后主线', level: 'default' },
    'version:problem': { label: '版本有问题', level: 'warning' },
    'pull:never': { label: '还没有拉单记录', level: 'default' },
    'pull:failed': { label: '拉单失败', level: 'error' },
    'pull:stale': { label: '拉单过期', level: 'warning' },
    'pull:fresh': { label: '拉单正常', level: 'success' },
    'health:ok': { label: '正常', level: 'success' },
    'health:engine-off': { label: '已停用', level: 'default' },
    'health:engine-down': { label: '没连上', level: 'error' },
    'health:engine-unknown': { label: '没读到', level: 'warning' },
    'health:routes-degraded': { label: '有不通', level: 'warning' },
    'refresh:fresh': { label: '数据是新的', level: 'success' },
    'refresh:aging': { label: '数据有点旧', level: 'warning' },
    'refresh:stale': { label: '数据已过期', level: 'error' },
    'pwa:installed': { label: '已装成 APP', level: 'success' },
    'pwa:available': { label: '可以安装', level: 'default' },
    'pwa:unavailable': { label: '现在不能安装', level: 'default' },
    'pwa:unreadable': { label: '没读到', level: 'warning' },
    'notify:granted': { label: '已允许', level: 'success' },
    'notify:default': { label: '还没打开', level: 'default' },
    'notify:denied': { label: '已被拒绝', level: 'error' },
    'notify:unsupported': { label: '没读到', level: 'warning' },
  },
  quota: {
    'quota:use-first': { label: '该先用', level: 'success' },
    'quota:enough': { label: '够用', level: 'success' },
    'quota:near-full': { label: '快满了', level: 'error' },
    'quota:stale': { label: '读数过期', level: 'warning' },
    'quota:measured': { label: '实读', level: 'default' },
    'quota:estimated': { label: '估算', level: 'default' },
    'quota:unread': { label: '没读到', level: 'warning' },
    'quota:limit_reached': { label: '上游说额度到顶', level: 'error' },
    'quota:bar>=90': { label: '用量 90% 以上', level: 'error' },
    'quota:bar>=75': { label: '用量 75% 以上', level: 'warning' },
    'quota:bar-unread': { label: '用量没读到', level: 'warning' },
    'quota:health-ok': { label: '正常', level: 'success' },
    'quota:health-tight': { label: '紧', level: 'warning' },
    'quota:health-unread': { label: '没读到', level: 'warning' },
  },
} as const satisfies Record<string, Record<string, StatusEntry>>;

export type StatusDict = typeof STATUS_DICT;
export type Domain = keyof StatusDict;

/** 字典里所有键：`task:running`、`route:live`。键里本身带冒号的（task 域的 segment:done）就是 `task:segment:done`。 */
export type StatusKey =
  | {
      [D in Domain]: `${D}:${keyof StatusDict[D] & string}`;
    }[Domain]
  | 'unknown';

/** 认不出的状态：灰「未知」。 */
export const UNKNOWN_STATUS: StatusEntry = { label: '未知', level: 'default' };

export const DOMAINS = Object.keys(STATUS_DICT) as Domain[];

const FLAT = new Map<string, StatusEntry>();
for (const d of DOMAINS) {
  for (const [k, v] of Object.entries(STATUS_DICT[d] as Record<string, StatusEntry>))
    FLAT.set(`${d}:${k}`, v);
}
FLAT.set('unknown', UNKNOWN_STATUS);

/** 全部字典键（含 unknown）。 */
export const STATUS_KEYS = [...FLAT.keys()] as StatusKey[];

/** 取一个字典键的中文和等级。 */
export function statusEntry(status: StatusKey): StatusEntry {
  return FLAT.get(status) ?? UNKNOWN_STATUS;
}

const warned = new Set<string>();
let unknownCount = 0;

/** 认不出的状态记了多少次（体检 JSON 的 unknownStatus 读它）。 */
export function unknownStatusCount(): number {
  return unknownCount;
}

/** 测试用：清零计数和已警告的集合。 */
export function resetUnknownStatus(): void {
  warned.clear();
  unknownCount = 0;
}

/**
 * 后端来的原始值换成字典键。认不出（后端多了新值、旧数据里的老词）返回 'unknown'，同一个值只 console.warn 一次，
 * 不报错、不白屏，也不当成正常。
 */
export function toStatus(domain: Domain, raw: string | null | undefined): StatusKey {
  const key = `${domain}:${raw ?? ''}`;
  if (raw != null && FLAT.has(key)) return key as StatusKey;
  unknownCount += 1;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[status-dict] 认不出的状态 ${key}，画成「未知」。要在 src/theme/status-dict.ts 里补上。`);
  }
  return 'unknown';
}
