// 桌面第 0 片实测 ①（#3868）：esbuild 把内核入口打成单文件 kernel.mjs，旁边放 node.exe 和 PGlite 的运行资源。
// 用法：node probes/desktop/bundle-kernel.ts <输出目录> [node.exe 路径，默认当前 node]
// 输出目录里：kernel.mjs、node.exe、pglite.wasm/pglite.data/initdb.wasm；迁移目录放在输出目录的上一级 migrations/。
// 不进内核运行代码；只是量"打成一个 JS 文件加官方 node.exe 能不能起来"。
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (!process.argv[2]) {
  console.error('用法：node probes/desktop/bundle-kernel.ts <输出目录> [node.exe]');
  process.exit(2);
}
const out = resolve(process.argv[2]);
const nodeExe = process.argv[3] ?? process.execPath;
mkdirSync(out, { recursive: true });

// 版本号构建期内联（profiles/version.ts 的 __FLEET2_VERSION__），运行时不读 package.json
const { version } = JSON.parse(
  readFileSync(join(root, 'packages/harness-dispatch/package.json'), 'utf8'),
) as {
  version: string;
};

await build({
  entryPoints: [join(root, 'packages/harness-dispatch/src/bin/kernel.ts')],
  outfile: join(out, 'kernel.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // 依赖里的 CJS 在 ESM 产物里要 require；import.meta.url 保留（PGlite 靠它找 wasm）
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  define: { __FLEET2_VERSION__: JSON.stringify(version) },
  logLevel: 'info',
});

// PGlite 的 wasm、数据包、initdb 放在 kernel.mjs 旁边（它按 import.meta.url 找）
const req = createRequire(join(root, 'packages/harness-store/package.json'));
const pgDist = dirname(req.resolve('@electric-sql/pglite'));
for (const f of ['pglite.wasm', 'pglite.data', 'initdb.wasm']) copyFileSync(join(pgDist, f), join(out, f));
// 迁移目录：MIGRATIONS_FOLDER 是 new URL('../migrations', import.meta.url)，打包后落在 kernel.mjs 的上一级
cpSync(join(root, 'packages/harness-store/migrations'), join(out, '..', 'migrations'), { recursive: true });
copyFileSync(nodeExe, join(out, 'node.exe'));

let total = 0;
for (const f of readdirSync(out)) total += statSync(join(out, f)).size;
console.log(
  JSON.stringify({
    out,
    kernelMjsBytes: statSync(join(out, 'kernel.mjs')).size,
    nodeExeBytes: statSync(join(out, 'node.exe')).size,
    dirBytes: total,
  }),
);
