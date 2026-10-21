// 发布构建驾驶舱前端时，@react-router/dev 在 ssr:false 下用 vite preview 发一个本机 GET /，
// 10 秒不回就中止（dist/vite.js 的 timeout 默认 10000、retryCount 0）。这 10 秒从请求发出才开始算，
// 而预览服务要等请求进来才第一次动态 import dist/server/index.js。
// 本机冷加载这一份要数秒（第二次同一条 file URL 是 0），构建过程里那次也占掉请求的绝大部分，并且堵住事件循环。
// 这里在 preview 开始听之前、用和框架相同的 file URL 先 import 一次，请求里的那次变成缓存命中。
// 不改超时、不加重试、不吞错：文件不在就跳过（还没构建、或只预览静态文件），在但载入失败就抛出去，构建失败、不切版本。
// 只在 Node 里跑（vite 配置），不进浏览器的包。
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';

/** 和框架预览服务头一次请求时 import 的是同一个文件：buildDirectory 解析成 <web 根>/dist，serverBuildFile 默认 index.js。 */
export function prerenderServerEntry(webRoot: string): string {
  return resolve(webRoot, 'dist/server/index.js');
}

export function prerenderServerPreload(serverEntry: string): Plugin {
  return {
    name: 'fleet-prerender-server-preload',
    async configurePreviewServer() {
      if (!existsSync(serverEntry)) return;
      try {
        await import(pathToFileURL(serverEntry).href);
      } catch (error) {
        throw new Error(`预渲染前载入服务端产物失败（${serverEntry}）`, { cause: error });
      }
    },
  };
}
