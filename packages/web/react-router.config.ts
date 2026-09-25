import type { Config } from '@react-router/dev/config';

// 纯前端单页模式：构建时只把外壳渲染成 dist/client/index.html，其余都在浏览器里跑。
// 部署时门面（nginx）要把所有路径回落到 index.html。
export default {
  appDirectory: 'src',
  buildDirectory: 'dist',
  ssr: false,
} satisfies Config;
