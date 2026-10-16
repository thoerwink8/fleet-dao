// pnpm work claim|renew|done <单号> | queue [--json] | run <单号> | runs（= node packages/conventions/src/bin/work.ts）：本机领单、续租、结束（决定 0096），
// 本机队列（单 #2731），脱离聊天进程派无头工人（单 #2761）。判法、退出码见 ../work.ts、../work-queue.ts、../work-run.ts。
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Git } from '../directives.ts';
import { ghRunner } from '../issue-new.ts';
import { liveClaimsPost, readClaimsEndpoint, work } from '../work.ts';
import { readLeases, readLocalBeats, removeLease, writeLease } from '../work-queue.ts';
import { runsRoot } from '../work-run.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

const git: Git = (args) =>
  new Promise((done) =>
    execFile(
      'git',
      args,
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) =>
        done({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout,
          stderr: err && !stderr ? err.message : stderr,
        }),
    ),
  );

// agents 下的两份纯 node 脚本（agents-sync 原样装到各机器）：conventions 是零安装区、不静态引包外文件，按路径动态引，只声明用到的。
interface CapacityLib {
  readCapacityAsync: () => Promise<unknown>;
  judgeCapacity: (r: unknown) => { enough: boolean | null; text: string };
}
interface DetachLib {
  spawnDetached: (
    file: string,
    args: string[],
    opts: { cwd?: string },
  ) => { ok: true; pid: number; how: string } | { ok: false; why: string };
}
const agentsLib = async <T>(rel: string): Promise<T> =>
  (await import(pathToFileURL(join(root, rel)).href)) as T;

/** PATH 上的 reclaude（Windows 取 .exe 那一行）；找不到 null */
function findReclaude(): string | null {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['reclaude'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  const lines = (r.stdout ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.find((l) => /\.exe$/i.test(l)) ?? lines[0] ?? null;
}

const wantsRun = process.argv[2] === 'run' || process.argv[2] === 'runs';
const detach = wantsRun ? await agentsLib<DetachLib>('agents/local-sessions/detach.mjs') : null;
const capacity = wantsRun ? await agentsLib<CapacityLib>('agents/hooks/capacity.mjs') : null;

process.exitCode = await work(process.argv.slice(2), {
  gh: ghRunner(root),
  post: liveClaimsPost(() => readClaimsEndpoint()),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  queue: { git, readBeats: () => readLocalBeats(), readLeases: () => readLeases(), now: () => new Date() },
  leases: { write: (rec) => writeLease(rec), remove: (repo, issue) => removeLease(repo, issue) },
  ...(detach && capacity
    ? {
        run: {
          capacity: async () => capacity.judgeCapacity(await capacity.readCapacityAsync()),
          spawnDetached: (file, args, opts) => detach.spawnDetached(file, args, opts),
          git,
          env: process.env,
          now: () => new Date(),
          runsRoot: runsRoot(),
          repoRoot: root,
          node: process.execPath,
          supervisor: fileURLToPath(new URL('./work-supervisor.ts', import.meta.url)),
          findReclaude,
          hasLease: (repo, issue) =>
            readLeases().some(
              (l) => l.repo === repo && l.issue === issue && Date.parse(l.leaseUntil) > Date.now(),
            ),
          exists: (p) => existsSync(p),
          readText: (p) => readFileSync(p, 'utf8'),
        },
      }
    : {}),
});
