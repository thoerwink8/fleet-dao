// 操作记录里「事件名」的中文对照表（#1821）。后端只给代码（routing.probe.done、task.pause……），这里翻成一句话。
// 收的是仓里 appendAudit 真会写的 action 值；表里没有的原样显示，页面在后面标灰字「（没翻译）」，不猜。
import {
  AUTO_DISPATCH_DISABLE,
  AUTO_DISPATCH_ENABLE,
  GROOM_ACTION,
  RELEASE_REQUEST_ACTION,
  ROUTE_PROBE_ACTION,
} from '@fleet-dao/shared';
import { brand } from '#brand';

export const AUDIT_ACTION_TEXT: Readonly<Record<string, string>> = {
  // 人在驾驶舱里点的
  login: `登录了${brand.product}`,
  logout: `退出了${brand.product}`,
  'credentials.set': '设了账密登录',
  'credentials.change': '改了账密登录',
  'setting.update': '改了设置',
  'notification.resolve': '处理了提醒',
  'notification.file': '发了一条提醒',
  'alert.silence': '静音了一类提醒',
  'alert.unsilence': '取消了提醒静音',
  'ask.answer': '回答了追问',
  'ask.close': '关闭了旧追问',
  [AUTO_DISPATCH_ENABLE]: '开启了「让 AI 接活」',
  [AUTO_DISPATCH_DISABLE]: '关闭了「让 AI 接活」',
  [RELEASE_REQUEST_ACTION]: '点了发布到法国',
  // 任务
  'task.create': '建了任务',
  'task.adopt': '接下了一张老单',
  'task.pause': '暂停了任务',
  'task.resume': '继续了任务',
  'task.stop': '叫停了任务',
  'task.redo': '让任务重做',
  'task.reroute': '换了任务的路由',
  'task.repin': '让动手会话现在就换了模型',
  'task.routePin.set': '给任务指定了模型',
  'task.routePin.clear': '取消了任务指定的模型',
  'task.close': '关了单',
  'dispatch.issue': '把一张单派给了引擎',
  // 路由、模型、渠道
  'stage_policy.update': '改了路由顺序',
  'routing.order.move': '调了路由先后',
  'routing.route.enable': '开关了路由',
  'routing.model.enable': '开关了模型',
  'routing.effort.update': '改了思考档位',
  'routing.purpose.add': '给用途加了路由',
  'routing.purpose.remove': '从用途里去掉了路由',
  'routing.purpose.effort': '改了用途的思考档位',
  [ROUTE_PROBE_ACTION.request]: '点了立刻探测',
  [ROUTE_PROBE_ACTION.start]: '探针开始探',
  [ROUTE_PROBE_ACTION.done]: '探针探完',
  'channel.enable': '上架了渠道',
  'channel.disable': '下架了渠道',
  'catalog.load': '读入了模型目录',
  'catalog.discover': '发现了渠道的新模型',
  'catalog.manual.register': '手动加了模型',
  'catalog.manual.revoke': '撤掉了手动加的模型',
  'model-roster.register': '把模型登记进名册',
  'model-roster.revoke': '把模型从名册撤掉',
  'route.offline': '路由掉线',
  // 整理待办、会话、账号
  [GROOM_ACTION.request]: '请求整理待办',
  [GROOM_ACTION.start]: '开始整理待办',
  [GROOM_ACTION.done]: '整理完待办',
  'session.mint': '发了一个会话登录',
  'node_key.new': '给机器发了新密钥',
  'session-org.drift': '会话账号对不上了',
  'session-org.settle': '会话账号对齐了',
  'session-org.limit': '会话账号碰到用量上限',
  'session-org.read-backoff': '会话账号用量读不到，先退避',
  // 会话里的 AI 与引擎
  'agent.plan': '会话交了计划',
  'agent.say': '会话说了一句',
  'agent.done': '会话报了做完',
  'agent.done_rejected': '「做完了」被退回',
  'run.start': '派了会话',
  'run.fail': '会话失败',
  'pr.open': '开了 PR',
  'pr.merge': '合并了 PR',
  'notify.decision': '发了要拍板的提醒',
  'jev.mode': '改了判断题的模式',
  'jev.question.rewrite': '改写了一道判断题',
};

/** 一个事件名的显示：有对照翻成一句话；没有就原名，translated 为 false，页面标「（没翻译）」。 */
export function describeAction(action: string): { text: string; translated: boolean } {
  const text = Object.hasOwn(AUDIT_ACTION_TEXT, action) ? AUDIT_ACTION_TEXT[action] : undefined;
  return text === undefined ? { text: action, translated: false } : { text, translated: true };
}

/** 对象编号 → 站内地址：能点进对应的单或路由页。认不出的没有地址。 */
export function targetHref(target: string): string | null {
  const i = target.indexOf(':');
  if (i < 0) return null;
  const kind = target.slice(0, i);
  const id = target.slice(i + 1);
  if (id === '') return null;
  switch (kind) {
    case 'task':
      return `/tasks/${encodeURIComponent(id)}`;
    case 'route':
    case 'model':
    case 'channel':
    case 'stage':
    case 'routing':
      return '/routing';
    case 'setting':
      return '/settings';
    case 'notification':
      return '/notifications';
    default:
      return null;
  }
}
