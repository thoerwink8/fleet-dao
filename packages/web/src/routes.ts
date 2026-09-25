import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
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
    // 第二批页面（P3 之后）：先放占位页。
    route('models', 'routes/soon.tsx', { id: 'soon-models' }),
    route('billing', 'routes/soon.tsx', { id: 'soon-billing' }),
    route('record', 'routes/soon.tsx', { id: 'soon-record' }),
    route('jev', 'routes/soon.tsx', { id: 'soon-jev' }),
    route('members', 'routes/soon.tsx', { id: 'soon-members' }),
    route('*', 'routes/not-found.tsx'),
  ]),
] satisfies RouteConfig;
