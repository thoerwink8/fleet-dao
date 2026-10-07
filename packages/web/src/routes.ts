import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';

// 演示版（FLEET_WEB_TARGET=demo，见 scripts/demo.ts）没有登录页、占位页和发演示链接的页：路由表里就不放，
// 这几页的代码也就不进演示版的包。
const demo = process.env.FLEET_WEB_TARGET === 'demo';

const cockpitOnly = demo
  ? []
  : [
      route('demo-links', 'routes/demo-links.tsx'),
      // 仓根 CHANGELOG.md 的仓名不能进演示版产物，这一页也不放进演示版路由表（导航同时不给 module）。
      route('changelog', 'routes/changelog.tsx'),
      // 路由两层每一层现在活着吗（#574）：演示版没有这个模块。
      route('routing', 'routes/routing.tsx'),
      // 渠道状态（#1087）：按供应商聚合的卡，左边看近 60 次柱条、点开看每条的 request/response。
      route('routing/status', 'routes/routing-status.tsx'),
      // 每条路由起会话的思考档位（#470）：演示版没有这个模块，也改不了。
      route('efforts', 'routes/efforts.tsx'),
      // 旧地址：环境页并进法国页（#1217），打开转到 /france。演示版不放（和法国页同一个 R10 理由）。
      route('env', 'routes/env.tsx'),
      // 法国页：本台六项事实、引擎总开关、定时任务、发版；多一台机器时按台并排。
      // 演示版不放（露机器名、版本号、会话数，R10）。
      route('france', 'routes/france.tsx'),
      // 还没做的页：不进侧栏（驾驶舱改版 2026-10-07），地址留着、打开写明「还没做」。
      route('models', 'routes/soon.tsx', { id: 'soon-models' }),
      route('billing', 'routes/soon.tsx', { id: 'soon-billing' }),
      route('record', 'routes/soon.tsx', { id: 'soon-record' }),
      route('judge', 'routes/soon.tsx', { id: 'soon-judge' }),
    ];

export default [
  ...(demo ? [] : [route('login', 'routes/login.tsx')]),
  layout('routes/shell.tsx', [
    index('routes/home.tsx'),
    // 主页「在跑的」、追问的链接（后端拼的 /tasks/<编号>）落在这里；演示版按「任务」模块的开关看
    route('tasks/:taskId', 'routes/task.tsx'),
    route('quota', 'routes/quota.tsx'),
    route('schedules', 'routes/schedules.tsx'),
    route('notifications', 'routes/notifications.tsx'),
    route('audit', 'routes/audit.tsx'),
    route('settings', 'routes/settings.tsx'),
    ...cockpitOnly,
    route('*', 'routes/not-found.tsx'),
  ]),
] satisfies RouteConfig;
