import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';
import { designRoutes, isMockBuild } from './routes-design.ts';

export default [
  route('login', 'routes/login.tsx'),
  // 不带外壳的页：任务页面板「弹出到新窗口」的那一笔会话（#3277）
  layout('routes/bare.tsx', [route('tasks/:taskId/runs/:runId', 'routes/task-run.tsx')]),
  layout('routes/shell.tsx', [
    // 主页：要你拍的、在跑的、上线了的三块（决定 0093）
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
    // 法国页：运行概况、引擎总开关（含三段/全程）、版本与发版、机器表（本台加远程）、更多（定时任务、资源、发布记录、操作记录、渠道状态、命令行工具）。
    route('france', 'routes/france.tsx'),
    // 资源页（#1986）：整机内存、CPU、磁盘，每个上线项目各占多少、放在哪，按目录的磁盘占用。
    route('resources', 'routes/resources.tsx'),
    // 设计陈列页：只在 dev:mock 构建里有（routes-design.ts）。
    ...designRoutes(isMockBuild()),
    route('*', 'routes/not-found.tsx'),
  ]),
] satisfies RouteConfig;
