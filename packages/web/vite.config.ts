import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { assetServingAllow } from './src/build/asset-access.ts';
import { LICENSE_DATA, thirdPartyLicenses } from './src/build/licenses.ts';
import { prerenderServerEntry, prerenderServerPreload } from './src/build/prerender-preload.ts';

// 开发时 /api、/auth 转给本机的驾驶舱后端（packages/api，默认 127.0.0.1:8787），页面和接口同源。
// 后端按 FLEET_PUBLIC_URL（开发默认 http://localhost:5173）核对写请求的来源，所以浏览器要开 localhost:5173。
const backend = process.env.FLEET_API_ORIGIN ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [
    tailwindcss(),
    reactRouter(),
    thirdPartyLicenses(),
    // 预览开听前先载入服务端产物，SPA 外壳那次 GET / 的 10 秒超时不再盖住冷加载（#3491）。
    prerenderServerPreload(prerenderServerEntry(import.meta.dirname)),
  ],
  server: {
    port: 5173,
    strictPort: true,
    // 全局虚拟仓下依赖的真实路径在工作区外：strict 照开，只补声明依赖的包目录（src/build/asset-access.ts）。
    fs: { allow: assetServingAllow(import.meta.dirname, searchForWorkspaceRoot(import.meta.dirname)) },
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
