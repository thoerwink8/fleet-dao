import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 开发时 /api、/auth 转给本机的驾驶舱后端（packages/api，默认 127.0.0.1:8787），页面和接口同源。
// 后端按 FLEET_PUBLIC_URL（开发默认 http://localhost:5173）核对写请求的来源，所以浏览器要开 localhost:5173。
const backend = process.env.FLEET_API_ORIGIN ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backend },
      '/auth': { target: backend },
    },
  },
  build: {
    // elkjs 打包后约 1.5 MB，只在桌面看板按需加载，不进首屏。
    chunkSizeWarningLimit: 1700,
  },
});
