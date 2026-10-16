// pnpm subagent:stats [--enforce | --lift]（= node packages/conventions/src/bin/subagent-stats.ts）：Haiku 改代码的结果记账、超线收回。
// 判法、退出码见 ../subagent-stats.ts；规矩见 agents/subagents/README.md「护栏」。
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Gh } from '../pr-arm.ts';
import { type PolicyLib, subagentStats } from '../subagent-stats.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
// 策略文件的读写在 agents/hooks/subagent-ledger.mjs（钩子也用它）：conventions 是零安装区、不静态引包外文件，按路径动态引
const lib = (await import(pathToFileURL(join(root, 'agents/hooks/subagent-ledger.mjs')).href)) as PolicyLib;

/** 跑 gh：近 30 天一千来个 PR 的正文、提交全文一次读下来有好几兆，spawnSync 默认 1MB 的输出上限不够（ENOBUFS），放宽到 256MB。 */
const gh: Gh = (args) => {
  const r = spawnSync('gh', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    return { code: e.code === 'ENOENT' ? 127 : 1, stdout: r.stdout ?? '', stderr: e.message };
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

process.exitCode = await subagentStats(process.argv.slice(2), {
  gh,
  now: () => new Date(),
  home: process.env.FLEET_DAO_HOME || join(homedir(), '.fleet-dao'),
  policy: lib,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
