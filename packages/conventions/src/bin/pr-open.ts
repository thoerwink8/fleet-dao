// pnpm pr:open（= node packages/conventions/src/bin/pr-open.ts）：开 PR，没碰改标准路径就当场挂自动合并。
// 判法、退出码见 ../pr-open.ts；不给 --body-file 时正文由 ../pr-compose.ts 生成；测试 test/pr-open.test.ts、test/pr-compose.test.ts。
import { fileURLToPath } from 'node:url';
import { ghRunner } from '../issue-new.ts';
import { liveGit, livePrGh } from '../pr-arm.ts';
import { prOpenCli } from '../pr-compose.ts';
import { pickGitCwd } from '../pr-open.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
// pnpm 跑脚本时 cwd 换成了仓根，原来的目录在 INIT_CWD 里：正文文件的相对路径照人敲命令的地方算
const cwd = process.env.INIT_CWD ?? process.cwd();
// gh / git 跑在脚本所在仓里：INIT_CWD 在仓外（pnpm --dir <别处> 调用）时用仓根，否则 gh 报 not a git repository
const gitCwd = pickGitCwd(process.env.INIT_CWD, root);

process.exitCode = await prOpenCli(process.argv.slice(2), {
  gh: livePrGh(gitCwd),
  git: liveGit(gitCwd),
  issueGh: ghRunner(root),
  root,
  cwd,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
