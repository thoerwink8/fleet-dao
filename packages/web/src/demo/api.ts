// 演示版的数据：还是那份会自己动的假数据（mock/），只在浏览器里；外面再包一层——
// 没开放的模块直接回「没开放」，开放的按细节级别收起（redact.ts）。页面上的按钮照样能点，改的只是这份假数据。
import { ApiError, type FleetApi } from '../api/client';
import type { MockApi } from '../api/mock/server';
import { canSee, detailLevel } from './access';
import { redactAudit, redactBoard, redactNotifications, redactTaskDetail } from './redact';
import type { DemoModule } from './scope';

function hidden(what: string): ApiError {
  return new ApiError(403, 'demo_hidden', `演示版没开放${what}`);
}

function need(module: DemoModule, what: string) {
  if (!canSee(module)) throw hidden(what);
}

export function createDemoApi(inner: MockApi): FleetApi {
  const issueOf = (taskId: string) => {
    const t = inner.state().tasks.find((x) => x.task.id === taskId)?.task;
    return t ? { issueNumber: t.issueNumber, title: t.title } : undefined;
  };
  const noLogin = () => Promise.reject(new ApiError(400, 'demo_no_login', '演示版不用登录'));
  return {
    source: 'demo',
    authConfig: () => Promise.resolve({ devLogin: false }),
    devLogin: noLogin,
    feishuAccess: noLogin,
    passwordLogin: noLogin,
    // 账密只在正式驾驶舱里有：演示版没有这个模块
    credentials: () => Promise.reject(hidden('账密设置')),
    updateCredentials: () => Promise.reject(hidden('账密设置')),
    logout: () => Promise.resolve(),
    async me() {
      const me = await inner.me();
      return { ...me, user: { ...me.user, displayName: '访客' } };
    },
    repos: () => inner.repos(),
    // 演示版路由表里没有新主页（/），这里照样满足接口（将来的演示「项目群」会用）。
    home: () => inner.home(),
    // 环境页只在正式驾驶舱里有（演示版没有这个模块，导航不给、路由表也不放）：
    // 它露的是这台机器的环境名、在用的版本、在跑几个会话（R10：演示版不露机器名、版本号、会话数）。
    env: () => Promise.reject(hidden('环境')),
    // 看板多机的切换器也只在正式驾驶舱里有：演示版不出 /api/nodes（R10：不露机器名）。
    nodes: () => Promise.reject(hidden('环境切换')),
    node: () => Promise.reject(hidden('环境切换')),
    board: async (repoId) => redactBoard(await inner.board(repoId), detailLevel()),
    task: async (taskId) => redactTaskDetail(await inner.task(taskId), detailLevel()),
    taskAction: (taskId, body) => inner.taskAction(taskId, body),
    // 指定模型要读路由两层（演示版没有路由页），写一律拒
    updateTaskRoutePin: () => Promise.reject(hidden('指定模型')),
    routing: () => inner.routing(),
    // 路由页只在正式驾驶舱里有（演示版没有这个模块）。
    routingLayers: () => Promise.reject(hidden('路由')),
    // 渠道状态页的立即探测：演示版没有这一页，读写一律拒（不让演示链接替创始人起探针会话）。
    routeProbeStatus: () => Promise.reject(hidden('渠道状态')),
    routeProbeNow: () => Promise.reject(hidden('渠道状态')),
    // 思考档位页也只在正式驾驶舱里有：演示版看不到、更改不了。
    routingEfforts: () => Promise.reject(hidden('思考档位')),
    updateRouteEffort: () => Promise.reject(hidden('思考档位')),
    // 路由页改先后和开关：演示版没有路由页，写一律拒（403）。
    movePurposeModel: () => Promise.reject(hidden('路由')),
    updateModelRoute: () => Promise.reject(hidden('路由')),
    pools: () => inner.pools(),
    async poolHolds() {
      need('settings', '设置');
      return inner.poolHolds();
    },
    // 「让 AI 接活」开关：演示版只读（页面上不画开关按钮），写一律拒。
    async repoDispatch() {
      need('settings', '设置');
      return inner.repoDispatch();
    },
    updateRepoDispatch: () => Promise.reject(hidden('开关')),
    async jobs() {
      need('schedules', '定时任务');
      return inner.jobs();
    },
    async notifications(query) {
      need('notifications', '通知');
      return redactNotifications(await inner.notifications(query), detailLevel(), issueOf);
    },
    async resolveNotification(id) {
      need('notifications', '通知');
      return inner.resolveNotification(id);
    },
    async audit(query) {
      if (canSee('audit')) return redactAudit(await inner.audit(query), detailLevel());
      throw hidden('操作记录');
    },
    async settings() {
      need('settings', '设置');
      return inner.settings();
    },
    async updateSetting(key, body) {
      need('settings', '设置');
      return inner.updateSetting(key, body);
    },
    // /changelog 页不进演示版（路由表不放）：发布的版本号也不给。
    releaseVersion: () => Promise.reject(hidden('发布')),
    // /france 页同样不进演示版：发版一键的两条也不给。
    franceReleaseState: () => Promise.reject(hidden('发版一键')),
    francePreflight: () => Promise.reject(hidden('发版一键')),
    // 发演示链接只在正式驾驶舱里有。
    demoLinks: () => Promise.reject(hidden('发演示链接')),
    createDemoLink: () => Promise.reject(hidden('发演示链接')),
    revokeDemoLink: () => Promise.reject(hidden('发演示链接')),
    updateDemoDefault: () => Promise.reject(hidden('发演示链接')),
    subscribe: (listener, onStatus) => inner.subscribe(listener, onStatus),
  };
}
