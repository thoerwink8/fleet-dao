// pnpm pr:open（= node packages/conventions/src/bin/pr-open.ts）：开 PR，没碰改标准路径就当场挂自动合并。
// 判法、退出码见 ../pr-open.ts；测试 packages/conventions/test/pr-open.test.ts。
import { fileURLToPath } from 'node:url';
import { liveGh } from '../pr-arm.ts';
import { prOpen } from '../pr-open.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
// pnpm 跑脚本时 cwd 换成了仓根，原来的目录在 INIT_CWD 里：正文文件的相对路径照人敲命令的地方算
const cwd = process.env.INIT_CWD ?? process.cwd();

process.exitCode = prOpen(process.argv.slice(2), {
  gh: liveGh(cwd),
  root,
  cwd,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
