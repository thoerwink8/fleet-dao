// 驾驶舱前端（packages/web）⇄ 驾驶舱后端（packages/api）的接口约定：请求与返回的形状。两边都照这份实现。
// 认证：飞书登录后拿到 HttpOnly 会话 Cookie；写操作（POST/PUT/PATCH/DELETE）另带请求头 `X-CSRF-Token`，值来自 GET /api/me。
// fleet 令牌（agent-api.ts）在这里一律被拒。
// 改这里之前：后端对每个返回都按这份 parse（多余字段会被剥掉），前端也照它解析；字段增删两边要一起改。
// 拆分（#901 ③）：具体定义在 ./web-api/ 下按领域分文件；这里只重导出，所有原来的 import 路径不用改。
export * from './web-api/auth.ts';
export * from './web-api/board.ts';
export * from './web-api/common.ts';
export * from './web-api/demo.ts';
export * from './web-api/enums.ts';
export * from './web-api/env.ts';
export * from './web-api/home.ts';
export * from './web-api/jobs.ts';
export * from './web-api/nodes.ts';
export * from './web-api/notifications.ts';
export * from './web-api/pools.ts';
export * from './web-api/realtime.ts';
export * from './web-api/release.ts';
export * from './web-api/routes.ts';
export * from './web-api/routing.ts';
export * from './web-api/settings.ts';
export * from './web-api/task.ts';
