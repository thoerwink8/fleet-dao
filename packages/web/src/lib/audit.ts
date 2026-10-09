// 操作记录的白话：动作名、对象、谁、从哪来。后端只给代码（例如 stage_policy.update、task:xxx），名字在这里翻。
// 认不出的动作原样显示，不猜。
import { AUTO_DISPATCH_DISABLE, AUTO_DISPATCH_ENABLE } from '@fleet-dao/shared';
import { brand } from '#brand';
import type { AuditEntry, BoardTask, Me, SettingKey, StageKind } from '../api/types';
import { stageLabel } from './catalog';

const ACTION_LABEL: Record<string, string> = {
  'stage_policy.update': '改了路由顺序',
  'channel.enable': '上架了渠道',
  'channel.disable': '下架了渠道',
  'routing.order.move': '调了路由先后',
  'routing.route.enable': '开关了路由',
  'routing.model.enable': '开关了模型',
  'task.pause': '暂停了',
  'task.resume': '继续了',
  'task.stop': '叫停了',
  'task.redo': '重做了',
  'task.reroute': '换了路由',
  'task.repin': '让动手会话现在就换了模型',
  'ask.answer': '回答了追问',
  'ask.close': '关闭了旧追问',
  'notification.resolve': '处理了提醒',
  'setting.update': '改了设置',
  'agent.done_rejected': '「做完了」被退回',
  'credentials.set': '设了账密登录',
  'credentials.change': '改了账密登录',
  [AUTO_DISPATCH_ENABLE]: '开启了「让 AI 接活」',
  [AUTO_DISPATCH_DISABLE]: '关闭了「让 AI 接活」',
  login: `登录了${brand.product}`,
  logout: `退出了${brand.product}`,
  // 引擎一侧的动作（名字以引擎实际写的为准，认不出的原样显示）。
  'run.start': '派了会话',
  'run.fail': '会话失败',
  'pr.open': '开了 PR',
  'pr.merge': '合并了 PR',
  'task.close': '关了单',
  'notify.decision': '发了要拍板的提醒',
  'route.offline': '路由掉线',
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

export const viaLabel: Record<AuditEntry['via'], string> = {
  cockpit: brand.product,
  feishu: '飞书',
  github: 'GitHub',
  engine: '引擎',
  agent: '会话',
};

export const actorKindLabel: Record<AuditEntry['actor']['kind'], string> = {
  user: '人',
  ai: brand.terms.marshal,
  engine: '引擎',
  agent: '会话里的 AI',
};

/** 谁做的：是自己就写「我」；后端没给名字时只能写编号。 */
export function actorName(a: AuditEntry['actor'], me?: Me): string {
  if (me && a.kind === 'user' && a.id === me.user.id) return '我';
  return a.name ?? a.id;
}

export const settingLabel: Record<SettingKey, string> = {
  'sessions.maxConcurrent': '同时跑的会话上限',
  'notify.quietHours': '飞书免打扰时段',
  'judge.dailyCallLimit': `${brand.terms.judgeQuiz}每天调用上限`,
  'engine.soloPaused': `引擎暂不用${brand.terms.solo}`,
  'engine.quotaReserve': '各渠道的额度留量线',
  'engine.poolHolds': '整池暂停',
  'engine.master': '引擎总开关',
};

function isStage(s: string): s is StageKind {
  return s in stageLabel;
}

/** 对象编号的白话：stage:execute →「写码」阶段；task:… → 需求 #12；其余原样。 */
export function targetLabel(
  target: string,
  tasks: ReadonlyMap<string, Pick<BoardTask, 'issueNumber' | 'title'>>,
): string {
  const i = target.indexOf(':');
  if (i < 0) return target === 'cockpit' ? brand.product : target;
  const kind = target.slice(0, i);
  const id = target.slice(i + 1);
  switch (kind) {
    case 'stage':
      return isStage(id) ? `「${stageLabel[id]}」阶段` : `阶段 ${id}`;
    case 'task': {
      const t = tasks.get(id);
      return t ? `需求 #${t.issueNumber} ${t.title}` : `需求 ${id}`;
    }
    case 'channel':
      return `渠道 ${id}`;
    case 'route':
      return `路由 ${id}`;
    case 'model':
      return `模型 ${id} 下的路由`;
    case 'setting':
      return id in settingLabel ? `设置「${settingLabel[id as SettingKey]}」` : `设置 ${id}`;
    case 'user':
      return '账号的登录方式';
    case 'notification':
      return '一条提醒';
    default:
      return target;
  }
}

/** 需求编号 → 编号和标题，给 targetLabel 用。 */
export function taskIndex(tasks: BoardTask[]): Map<string, Pick<BoardTask, 'issueNumber' | 'title'>> {
  return new Map(tasks.map((t) => [t.id, { issueNumber: t.issueNumber, title: t.title }]));
}

/**
 * 操作记录前后值里的字段名。只收产品里已经有说法的；认不出的原样显示，不猜。
 * start、end 这种一词多义的不进这张表。
 */
export const auditFieldLabel: Record<string, string> = {
  answer: '回答',
  askId: '追问',
  autoDispatchSince: '「让 AI 接活」',
  channelId: '渠道',
  effort: '思考档位',
  enabled: '开关',
  enabledRouteIds: '开着的路由',
  hasPassword: '设了密码',
  method: '方式',
  modelId: '模型',
  modelKey: '模型',
  order: '顺序',
  passwordChanged: '改了密码',
  pin: '钉住',
  pinned: '钉住',
  position: '位置',
  prNumber: 'PR 编号',
  reason: '理由',
  repo: '仓库',
  requestId: '请求编号',
  routeId: '路由',
  routeIds: '路由列表',
  segment: '用途',
  stage: '阶段',
  username: '用户名',
};

/** 一条差异：字段名（中文或原样）和前后值的文字。 */
export interface AuditChangeLine {
  /** 原始字段名。整段值不是对象时为空。 */
  key: string;
  /** 对照表里的中文；没有就用原始字段名。整段值不是对象时是「值」。 */
  label: string;
  before: string;
  after: string;
}

function plainObject(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  for (const k of keys) {
    if (!sameValue(aObj[k], bObj[k])) return false;
  }
  return true;
}

function jsonText(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '（无）';
  } catch {
    return String(v);
  }
}

/** 一个值收成一行里的文字。null、缺的写成「（无）」；布尔写成是 / 否。 */
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '（无）';
  if (typeof v === 'string') return v.length === 0 ? '（空）' : v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '（无）';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '（空）';
    const flat = v.every(
      (item) => item === null || item === undefined || ['string', 'number', 'boolean'].includes(typeof item),
    );
    if (flat) return v.map((item) => formatValue(item)).join('、');
    return jsonText(v);
  }
  if (typeof v === 'object') return jsonText(v);
  return String(v);
}

function formatFieldValue(key: string, v: unknown): string {
  if (key === 'stage' && typeof v === 'string' && isStage(v)) return stageLabel[v];
  return formatValue(v);
}

function diffObjects(before: Record<string, unknown>, after: Record<string, unknown>): AuditChangeLine[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of [...Object.keys(before), ...Object.keys(after)]) {
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  const lines: AuditChangeLine[] = [];
  for (const key of keys) {
    const left = Object.hasOwn(before, key) ? before[key] : undefined;
    const right = Object.hasOwn(after, key) ? after[key] : undefined;
    if (sameValue(left, right)) continue;
    lines.push({
      key,
      label: auditFieldLabel[key] ?? key,
      before: formatFieldValue(key, left),
      after: formatFieldValue(key, right),
    });
  }
  return lines;
}

/**
 * 一条记录的改之前、改之后，收成只含变化的字段。
 * 一边没有（null、undefined）当空对象；整段不是对象（比如设置的数字）收成一行「值」。
 */
export function auditChangeLines(before: unknown, after: unknown): AuditChangeLine[] {
  const left = plainObject(before);
  const right = plainObject(after);
  if (left && right) return diffObjects(left, right);
  if (sameValue(before, after)) return [];
  return [{ key: '', label: '值', before: formatValue(before), after: formatValue(after) }];
}
