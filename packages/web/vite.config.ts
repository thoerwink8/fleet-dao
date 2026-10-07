import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { LICENSE_DATA, thirdPartyLicenses } from './src/build/licenses.ts';

// 开发时 /api、/auth 转给本机的驾驶舱后端（packages/api，默认 127.0.0.1:8787），页面和接口同源。
// 后端按 FLEET_PUBLIC_URL（开发默认 http://localhost:5173）核对写请求的来源，所以浏览器要开 localhost:5173。
const backend = process.env.FLEET_API_ORIGIN ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), thirdPartyLicenses()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backend },
      '/auth': { target: backend },
    },
  },
  build: {
    sourcemap: false,
    // 第三方许可证声明：vite 汇总、src/build/licenses.ts 补全后写成产物根上的 licenses.txt。
    license: { fileName: LICENSE_DATA },
  },
});
