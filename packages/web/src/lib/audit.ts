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
  'task.pause': '暂停了',
  'task.resume': '继续了',
  'task.stop': '叫停了',
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
