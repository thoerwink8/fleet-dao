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
    logout: () => Promise.resolve(),
    async me() {
      const me = await inner.me();
      return { ...me, user: { ...me.user, displayName: '访客' } };
    },
    repos: () => inner.repos(),
    // 演示版路由表里没有新主页（/），这里照样满足接口（将来的演示「项目群」会用）。
    home: () => inner.home(),
    board: async (repoId) => redactBoard(await inner.board(repoId), detailLevel()),
    task: async (taskId) => redactTaskDetail(await inner.task(taskId), detailLevel()),
    async timeline(taskId, page) {
      if (detailLevel() !== 'process') throw hidden('任务的过程');
      return inner.timeline(taskId, page);
    },
    async runSteps(runId) {
      if (detailLevel() !== 'process') throw hidden('步骤清单');
      return inner.runSteps(runId);
    },
    taskAction: (taskId, body) => inner.taskAction(taskId, body),
    answerAsk: (askId, answer) => inner.answerAsk(askId, answer),
    routing: () => inner.routing(),
    // 路由页只在正式驾驶舱里有（演示版没有这个模块）。
    routingLayers: () => Promise.reject(hidden('路由')),
    // 思考档位页也只在正式驾驶舱里有：演示版看不到、更改不了。
    routingEfforts: () => Promise.reject(hidden('思考档位')),
    updateRouteEffort: () => Promise.reject(hidden('思考档位')),
    updateStagePolicy: (stage, body) => inner.updateStagePolicy(stage, body),
    updateChannel: (channelId, body) => inner.updateChannel(channelId, body),
    pools: () => inner.pools(),
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
    // 发演示链接只在正式驾驶舱里有。
    demoLinks: () => Promise.reject(hidden('发演示链接')),
    createDemoLink: () => Promise.reject(hidden('发演示链接')),
    revokeDemoLink: () => Promise.reject(hidden('发演示链接')),
    updateDemoDefault: () => Promise.reject(hidden('发演示链接')),
    subscribe: (listener, onStatus) => inner.subscribe(listener, onStatus),
  };
}
