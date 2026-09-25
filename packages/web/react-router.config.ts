import type { Config } from '@react-router/dev/config';

// 纯前端单页模式：构建时只把外壳渲染成 <输出目录>/client/index.html，其余都在浏览器里跑。
// 部署时门面（nginx）要把所有路径回落到 index.html。
// 放在子路径下（演示版的 /demo/）时由 FLEET_WEB_BASE 给路径，vite.config.ts 用同一个值定资源地址；
// 输出目录由 FLEET_WEB_OUT 给（演示版默认 dist-demo，见 scripts/demo.ts），正式驾驶舱是 dist。
export default {
  appDirectory: 'src',
  buildDirectory: process.env.FLEET_WEB_OUT ?? 'dist',
  basename: process.env.FLEET_WEB_BASE ?? '/',
  ssr: false,
} satisfies Config;
