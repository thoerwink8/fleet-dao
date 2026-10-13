import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';
import { designRoutes, isMockBuild } from './routes-design.ts';

export default [
  route('login', 'routes/login.tsx'),
  layout('routes/shell.tsx', [
    index('routes/home.tsx'),
    // 任务列表（#1639）：所有仓、所有状态；筛选写在查询串里（?status=&repo=&q=）
    route('tasks', 'routes/tasks.tsx'),
    // 主页「在跑的」、追问的链接落在这里：/tasks/<任务编号，库内 id，例如 t-12>，不是 GitHub 单号
    route('tasks/:taskId', 'routes/task.tsx'),
    // 提需求：和指挥官聊清楚再开单（#2062；?r=<需求号> 打开一条）
    route('intake', 'routes/intake.tsx'),
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
    // 旧地址：思考档位（#470）并进路由页（#1914），打开转到 /routing?tab=efforts。
    route('efforts', 'routes/efforts.tsx'),
    // 旧地址：环境页并进法国页（#1217），打开转到 /france。
    route('env', 'routes/env.tsx'),
    // 法国页：本台六项事实、引擎总开关、命令行工具、定时任务、发版；多一台机器时按台并排。
    route('france', 'routes/france.tsx'),
    // 资源页（#1986）：整机内存、CPU、磁盘，每个上线项目各占多少、放在哪，按目录的磁盘占用。
    route('resources', 'routes/resources.tsx'),
    // 旧地址：模型目录做在路由页里，打开转到 /routing?tab=models。
    route('models', 'routes/models.tsx'),
    // 还没做的页：不进侧栏（驾驶舱改版 2026-10-07），地址留着、打开写明「还没做」。只剩账单、战绩、判断题记录。
    route('billing', 'routes/soon.tsx', { id: 'soon-billing' }),
    route('record', 'routes/soon.tsx', { id: 'soon-record' }),
    route('judge', 'routes/soon.tsx', { id: 'soon-judge' }),
    // 设计陈列页：只在 dev:mock 构建里有（routes-design.ts）。
    ...designRoutes(isMockBuild()),
    route('*', 'routes/not-found.tsx'),
  ]),
] satisfies RouteConfig;
