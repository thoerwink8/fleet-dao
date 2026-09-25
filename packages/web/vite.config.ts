import { fileURLToPath } from 'node:url';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { demoRenamed } from './src/build/demo-renames.ts';
import { LICENSE_DATA, thirdPartyLicenses } from './src/build/licenses.ts';

// 开发时 /api、/auth 转给本机的驾驶舱后端（packages/api，默认 127.0.0.1:8787），页面和接口同源。
// 后端按 FLEET_PUBLIC_URL（开发默认 http://localhost:5173）核对写请求的来源，所以浏览器要开 localhost:5173。
const backend = process.env.FLEET_API_ORIGIN ?? 'http://127.0.0.1:8787';

/** 演示版的包里要换掉的几处，表在 src/build/demo-renames.ts。 */
function demoRename(): Plugin {
  return {
    name: 'demo-rename',
    apply: 'build',
    enforce: 'post',
    renderChunk(code) {
      const out = demoRenamed(code);
      return out === code ? null : { code: out, map: null };
    },
  };
}

/** 路径要以 / 开头、以 / 结尾，不带查询。 */
function basePath(name: string, value: string): string {
  if (!/^\/([^?#]*\/)?$/.test(value))
    throw new Error(`${name} 要以 / 开头、以 / 结尾（例如 /demo/），现在是「${value}」`);
  return value;
}

/** 站内路径或 http(s) 地址，以 / 结尾，不带查询。 */
function urlOrPath(name: string, value: string): string {
  if (!/^(https?:\/\/[^/?#]+)?\/([^?#]*\/)?$/.test(value)) {
    throw new Error(`${name} 要是以 / 结尾的站内路径或 http(s) 地址（例如 /demo/），现在是「${value}」`);
  }
  return value;
}

export default defineConfig(({ mode }) => {
  // 演示版：品牌换成 src/brand/demo.tsx（正式那套名字进不了包）、不带源码对照文件、不留注释。
  // 要用 scripts/demo.ts 起（它把 --mode demo 和 FLEET_WEB_TARGET=demo 一起给，路由表也跟着换）。
  // （构建末尾预渲染外壳时，react-router 会不带 --mode 再读一遍这份配置起预览服务，所以只查这一个方向。）
  const demo = mode === 'demo';
  if (demo && process.env.FLEET_WEB_TARGET !== 'demo') {
    throw new Error(
      '演示版用 pnpm build:demo 或 pnpm dev:demo 起：--mode demo 和 FLEET_WEB_TARGET=demo 要一起给',
    );
  }
  const base = basePath('FLEET_WEB_BASE', process.env.FLEET_WEB_BASE ?? '/');
  const scopes = process.env.FLEET_DEMO_SCOPES;
  return {
    base,
    plugins: [tailwindcss(), reactRouter(), thirdPartyLicenses(), ...(demo ? [demoRename()] : [])],
    resolve: demo
      ? {
          alias: [
            {
              find: /^#brand$/,
              replacement: fileURLToPath(new URL('./src/brand/demo.tsx', import.meta.url)),
            },
          ],
        }
      : {},
    define: {
      'import.meta.env.FLEET_DEMO_URL': JSON.stringify(
        urlOrPath('FLEET_DEMO_URL', process.env.FLEET_DEMO_URL ?? '/demo/'),
      ),
      ...(scopes
        ? { 'import.meta.env.FLEET_DEMO_SCOPES': JSON.stringify(urlOrPath('FLEET_DEMO_SCOPES', scopes)) }
        : {}),
    },
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
      sourcemap: false,
      // 第三方许可证声明：vite 汇总、src/build/licenses.ts 补全后写成产物根上的 licenses.txt（两个版本都有）。
      license: { fileName: LICENSE_DATA },
      ...(demo ? { rolldownOptions: { output: { comments: false } } } : {}),
    },
  };
});
