import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 香港那份整体挂在 /next/ 下（旧驾驶舱在根路径，不动）。开发时 /next/api 转给本机的开发后端（dev/serve.ts，默认 127.0.0.1:8790）：
// 浏览器里没有会话令牌，带的是登录 Cookie（本机先开一次 /next/dev-login 拿到）；SSE 经这条代理走，同源。
// `--mode desktop`（pnpm build:local，#3858）出本机装法的页面：base=/，接口在 /api，导航换成会话/任务/待我/定时/宿主/设置，
// 由 fleet2 up 起的单口服务放出来；产物在 dist-local，不碰 dist。
const backend = process.env.HARNESS_WEB_API_ORIGIN ?? 'http://127.0.0.1:8790';

export default defineConfig(({ mode }) => ({
  base: mode === 'desktop' ? '/' : '/next/',
  plugins: [tailwindcss()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/next/api': { target: backend }, '/next/dev-login': { target: backend } },
  },
  build: { outDir: mode === 'desktop' ? 'dist-local' : 'dist', sourcemap: false },
}));
