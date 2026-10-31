// 界面上露出的原始枚举值（事件类型、任务结果、交回结局、核验结论、会话模式……）的中文名：全驾驶舱只在这一处映射（#3781 收尾）。
// 认识的显示中文，原值放在 title 提示里方便排查；不认识的（契约新加的）照原值显示，不丢也不编。

export interface Labeled {
  /** 界面上显示的字。 */
  text: string;
  /** 原始值：放 title 提示。 */
  raw: string;
}

export const TYPE_LABEL: Record<string, string> = {
  'session.turn.started': '轮次开始',
  'session.turn.settled': '轮次结束',
  'worker.spawn.requested': '派工请求',
  'worker.stop.requested': '叫停请求',
  'worker.spawned': '工人启动',
  'worker.settled': '工人结束',
  'worker.cleaned': '收尾清理',
  'worker.progress.reported': '进度',
  'worker.result.submitted': '交结果',
  'handback.recorded': '交回核验',
};

/** 工人交结果的状态（submit_result 的 status）。 */
export const RESULT_STATUS_LABEL: Record<string, string> = {
  done: '已完成',
  failed: '失败',
  blocked: '被卡住',
};

/** 交回的结局（派工器的 OutcomeKind；delivered 是驾驶舱判「做完」认的值）。 */
export const OUTCOME_LABEL: Record<string, string> = {
  delivered: '已交付',
  completed: '已完成',
  killed: '被叫停',
  'failed-to-start': '起不来',
  cancelled: '已取消',
  uncertain: '结果不确定',
  retry: '退回重试',
  released: '发版暂停，退回队列',
  lost: '租约丢了',
  'already-recorded': '已记过',
  error: '出错',
  dead: '已放弃',
};

/** 核验结论（verify 的 Verdict）。 */
export const VERDICT_LABEL: Record<string, string> = {
  passed: '通过',
  failed: '未通过',
  // 样例数据和早期事件里写过的短写法，认成同一个意思
  pass: '通过',
  fail: '未通过',
  unknown: '不确定',
  unverified: '未核验',
};

/** 工人用的会话模式。 */
export const SESSION_MODE_LABEL: Record<string, string> = {
  new: '新会话',
  resume: '接着上次',
};

/** 任务的状态（任务单上的状态词）。 */
export const TASK_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  claimed: '已领取',
  running: '在跑',
  done: '已完成',
  failed: '失败',
  blocked: '被卡住',
  cancelled: '已取消',
};

function labeled(table: Record<string, string>, raw: string | undefined): Labeled | undefined {
  if (raw === undefined || raw === '') return undefined;
  return { text: Object.hasOwn(table, raw) ? (table[raw] as string) : raw, raw };
}

export const typeLabel = (raw: string): Labeled => labeled(TYPE_LABEL, raw) as Labeled;
export const resultStatusLabel = (raw: string | undefined) => labeled(RESULT_STATUS_LABEL, raw);
export const outcomeLabel = (raw: string | undefined) => labeled(OUTCOME_LABEL, raw);
export const verdictLabel = (raw: string | undefined) => labeled(VERDICT_LABEL, raw);
export const sessionModeLabel = (raw: string | undefined) => labeled(SESSION_MODE_LABEL, raw);
export const taskStatusLabel = (raw: string | undefined) => labeled(TASK_STATUS_LABEL, raw);
