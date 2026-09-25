import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';

// 演示版（FLEET_WEB_TARGET=demo，见 scripts/demo.ts）没有登录页、占位页和发演示链接的页：路由表里就不放，
// 这几页的代码也就不进演示版的包。
const demo = process.env.FLEET_WEB_TARGET === 'demo';

const cockpitOnly = demo
  ? []
  : [
      route('demo-links', 'routes/demo-links.tsx'),
      // 第二批页面（P3 之后）：先放占位页。
      route('models', 'routes/soon.tsx', { id: 'soon-models' }),
      route('billing', 'routes/soon.tsx', { id: 'soon-billing' }),
      route('record', 'routes/soon.tsx', { id: 'soon-record' }),
      route('judge', 'routes/soon.tsx', { id: 'soon-judge' }),
      route('members', 'routes/soon.tsx', { id: 'soon-members' }),
    ];

export default [
  ...(demo ? [] : [route('login', 'routes/login.tsx')]),
  layout('routes/shell.tsx', [
    index('routes/board.tsx'),
    route('overview', 'routes/overview.tsx'),
    route('tasks', 'routes/tasks.tsx'),
    route('tasks/:taskId', 'routes/task-detail.tsx'),
    route('dispatch', 'routes/dispatch.tsx'),
    route('channels', 'routes/channels.tsx'),
    route('quota', 'routes/quota.tsx'),
    route('schedules', 'routes/schedules.tsx'),
    route('notifications', 'routes/notifications.tsx'),
    route('audit', 'routes/audit.tsx'),
    route('settings', 'routes/settings.tsx'),
    ...cockpitOnly,
    route('*', 'routes/not-found.tsx'),
  ]),
] satisfies RouteConfig;
