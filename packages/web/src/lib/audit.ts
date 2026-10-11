// 操作记录的白话：动作名、对象、谁、从哪来。后端只给代码（例如 stage_policy.update、task:xxx），名字在这里翻。
// 认不出的动作原样显示，不猜。
import { brand } from '#brand';
import type { AuditEntry, BoardTask, Me, SettingKey, StageKind } from '../api/types';
import { describeAction } from './audit-actions';
import { stageLabel } from './catalog';

/** 事件名的中文（对照表在 audit-actions.ts）；没收录的原样返回，页面另标「（没翻译）」。 */
export function actionLabel(action: string): string {
  return describeAction(action).text;
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

/**
 * 引擎等内部代号 → 人话。只收已经认得出的；认不出的原样保留，不猜。
 * 例：engine:hourly-reconcile → 引擎·每小时对账。
 */
const ACTOR_ID_LABEL: Record<string, string> = {
  'engine:hourly-reconcile': '引擎·每小时对账',
  'engine:watchdog': '引擎·看门狗',
  'engine:intake': '引擎·接单',
  'engine:groom': '引擎·整理待办',
  'engine:route-probe-now': '引擎·立刻探测',
  'engine:task-workflow': '引擎·任务工作流',
  'engine:canary': '引擎·金丝雀',
  'engine:sessions': '引擎·会话',
  'engine:org-switch': '引擎·切号',
  'engine:session-org': '引擎·会话账号',
  'engine:drain': '引擎·排空',
  'engine:github-reconcile': '引擎·GitHub 对账',
  'engine:retire-schedules': '引擎·收定时',
  'engine:route-wake': '引擎·路由唤醒',
  'engine:startup': '引擎·启动',
  'engine:pick-route': '引擎·选路',
  'engine:alert-dispatch': '引擎·派提醒',
};

/** 谁做的：是自己就写「我」；有名字用名字；否则把认得出的代号翻成人话，认不出的原样。 */
export function actorName(a: AuditEntry['actor'], me?: Me): string {
  if (me && a.kind === 'user' && a.id === me.user.id) return '我';
  if (a.name) return a.name;
  return ACTOR_ID_LABEL[a.id] ?? a.id;
}

export const settingLabel: Record<SettingKey, string> = {
  'sessions.maxConcurrent': '同时跑的会话上限',
  'notify.quietHours': '飞书免打扰时段',
  'judge.dailyCallLimit': `${brand.terms.judgeQuiz}每天调用上限`,
  'engine.soloPaused': `引擎暂不用${brand.terms.solo}`,
  'engine.quotaReserve': '各渠道的额度留量线',
  'engine.poolHolds': '整池暂停',
  'engine.master': '引擎总开关',
  'engine.subagentHint': '会话提示词里提示可派的子代理',
};

function isStage(s: string): s is StageKind {
  return s in stageLabel;
}

/** 任务索引里的一行：单号必有；标题可以后到（没到就先只显示 #单号）。 */
export type TaskLabelRef = { issueNumber: number; title?: string };

/** 对象编号的白话：stage:execute →「写码」阶段；task:… → 需求 #12；其余原样。 */
export function targetLabel(
  target: string,
  tasks: ReadonlyMap<string, TaskLabelRef>,
  /** 提醒 id → 标题；给「处理了提醒」带上是哪一条。 */
  notifications?: ReadonlyMap<string, string>,
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
      if (t) {
        const title = t.title?.trim();
        return title ? `需求 #${t.issueNumber} ${title}` : `需求 #${t.issueNumber}`;
      }
      // 索引没到：数字编号当单号；UUID 等不摊在页面上（过一会儿索引到了再补 #单号和标题）。
      if (/^\d+$/.test(id)) return `需求 #${id}`;
      return '需求';
    }
    case 'routing':
      return id === 'probe' ? '路由探测' : `路由 ${id}`;
    case 'commit':
      return `提交 ${id}`;
    case 'issue':
      return `单 ${id}`;
    case 'repo':
      return `仓库 ${id}`;
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
    case 'notification': {
      const title = notifications?.get(id)?.trim();
      return title ? `提醒「${title}」` : '一条提醒';
    }
    default:
      return target;
  }
}

/** 需求编号 → 编号和标题，给 targetLabel 用。 */
export function taskIndex(tasks: BoardTask[]): Map<string, TaskLabelRef> {
  return new Map(tasks.map((t) => [t.id, { issueNumber: t.issueNumber, title: t.title }]));
}

/**
 * 从已加载的操作记录里抠单号（after/before 带了 issueNumber 的，例如 task.create）。
 * 看板索引还没到时先用它占位显示 #单号，不露 UUID；看板到了再由 taskIndex 盖上标题。
 */
export function taskHintsFromAudit(
  entries: readonly { target: string; before?: unknown; after?: unknown }[],
): Map<string, TaskLabelRef> {
  const out = new Map<string, TaskLabelRef>();
  for (const e of entries) {
    if (!e.target.startsWith('task:')) continue;
    const id = e.target.slice('task:'.length);
    const issueNumber = readPositiveInt(e.after, 'issueNumber') ?? readPositiveInt(e.before, 'issueNumber');
    if (issueNumber === undefined) continue;
    const title = readTrimmedString(e.after, 'title') ?? readTrimmedString(e.before, 'title');
    const prev = out.get(id);
    // 后到的带标题的盖过只有单号的；不把已有标题抹掉。
    if (prev?.title && !title) continue;
    out.set(id, title ? { issueNumber, title } : { issueNumber });
  }
  return out;
}

/** 提醒 id → 标题，给 targetLabel 用。 */
export function notificationIndex(items: readonly { id: string; title: string }[]): Map<string, string> {
  return new Map(items.map((n) => [n.id, n.title]));
}

function readPositiveInt(v: unknown, key: string): number | undefined {
  const obj = plainObject(v);
  if (!obj) return undefined;
  const n = obj[key];
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

function readTrimmedString(v: unknown, key: string): string | undefined {
  const obj = plainObject(v);
  if (!obj) return undefined;
  const s = obj[key];
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  return t ? t : undefined;
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

/** 这些字段的值是路由编号。对照表里有模型名就换掉，没有或名字是空白就留编号。 */
const ROUTE_ID_FIELDS: ReadonlySet<string> = new Set(['enabledRouteIds', 'routeId', 'routeIds']);

function namedRoute(id: string, names: ReadonlyMap<string, string> | undefined): string | undefined {
  const name = names?.get(id)?.trim();
  return name ? name : undefined;
}

/** 只换字符串和字符串数组里的编号；别的形状交给 formatValue，不改写。 */
function withRouteNames(v: unknown, names: ReadonlyMap<string, string> | undefined): unknown {
  if (!names) return v;
  if (typeof v === 'string') return namedRoute(v, names) ?? v;
  if (!Array.isArray(v)) return v;
  return v.map((item) => (typeof item === 'string' ? (namedRoute(item, names) ?? item) : item));
}

function formatFieldValue(
  key: string,
  v: unknown,
  routeNames: ReadonlyMap<string, string> | undefined,
): string {
  if (key === 'stage' && typeof v === 'string' && isStage(v)) return stageLabel[v];
  if (ROUTE_ID_FIELDS.has(key)) return formatValue(withRouteNames(v, routeNames));
  return formatValue(v);
}

function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  routeNames: ReadonlyMap<string, string> | undefined,
): AuditChangeLine[] {
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
      before: formatFieldValue(key, left, routeNames),
      after: formatFieldValue(key, right, routeNames),
    });
  }
  return lines;
}

/**
 * 路由编号 → 模型显示名。名字是空白、或路由对不上模型的，不收进表：显示时留原编号。
 * 驾驶舱目录还没读到时传 undefined，同样留原编号。
 */
export function routeModelNames(
  routing:
    | {
        models: readonly { id: string; displayName: string }[];
        routes: readonly { id: string; modelId: string }[];
      }
    | undefined,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  if (!routing) return names;
  const byModel = new Map<string, string>();
  for (const model of routing.models) {
    const name = model.displayName.trim();
    if (name) byModel.set(model.id, name);
  }
  for (const route of routing.routes) {
    const name = byModel.get(route.modelId);
    if (name) names.set(route.id, name);
  }
  return names;
}

/**
 * 一条记录的改之前、改之后，收成只含变化的字段。
 * 一边没有（null、undefined）当空对象；整段不是对象（比如设置的数字）收成一行「值」。
 * routeNames 给了的话，路由编号换成模型名；表里没有、或名字是空白，留原编号。
 */
export function auditChangeLines(
  before: unknown,
  after: unknown,
  routeNames?: ReadonlyMap<string, string>,
): AuditChangeLine[] {
  const left = plainObject(before);
  const right = plainObject(after);
  if (left && right) return diffObjects(left, right, routeNames);
  if (sameValue(before, after)) return [];
  return [{ key: '', label: '值', before: formatValue(before), after: formatValue(after) }];
}
