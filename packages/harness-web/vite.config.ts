import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 新驾驶舱整体挂在 /next/ 下（旧驾驶舱在根路径，不动）。开发时 /next/api 转给本机的开发后端（dev/serve.ts，默认 127.0.0.1:8790）：
// 令牌由开发后端按会话代带，浏览器里没有令牌；SSE 经这条代理走，同源。
const backend = process.env.HARNESS_WEB_API_ORIGIN ?? 'http://127.0.0.1:8790';

export default defineConfig({
  base: '/next/',
  plugins: [tailwindcss()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/next/api': { target: backend } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
