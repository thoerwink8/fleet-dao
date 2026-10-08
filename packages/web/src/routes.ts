import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  layout('routes/shell.tsx', [
    index('routes/home.tsx'),
    // 主页「在跑的」、追问的链接（后端拼的 /tasks/<编号>）落在这里
    route('tasks/:taskId', 'routes/task.tsx'),
    route('quota', 'routes/quota.tsx'),
    route('schedules', 'routes/schedules.tsx'),
    route('notifications', 'routes/notifications.tsx'),
    route('audit', 'routes/audit.tsx'),
    route('settings', 'routes/settings.tsx'),
    route('changelog', 'routes/changelog.tsx'),
    // 路由两层每一层现在活着吗（#574）
    route('routing', 'routes/routing.tsx'),
    // 渠道状态（#1087、#1139）：每个渠道一张卡，近 60 次格子，点开看那一次的耗时和原文。
    route('routing/status', 'routes/routing-status.tsx'),
    // 每条路由起会话的思考档位（#470）
    route('efforts', 'routes/efforts.tsx'),
    // 旧地址：环境页并进法国页（#1217），打开转到 /france。
    route('env', 'routes/env.tsx'),
    // 法国页：本台六项事实、引擎总开关、定时任务、发版；多一台机器时按台并排。
    route('france', 'routes/france.tsx'),
    // 还没做的页：不进侧栏（驾驶舱改版 2026-10-07），地址留着、打开写明「还没做」。
    route('models', 'routes/soon.tsx', { id: 'soon-models' }),
    route('billing', 'routes/soon.tsx', { id: 'soon-billing' }),
    route('record', 'routes/soon.tsx', { id: 'soon-record' }),
    route('judge', 'routes/soon.tsx', { id: 'soon-judge' }),
    route('*', 'routes/not-found.tsx'),
  ]),
] satisfies RouteConfig;
