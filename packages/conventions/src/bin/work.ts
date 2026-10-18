// pnpm work claim|renew|done <单号> | queue [--json] | run <单号> | runs（= node packages/conventions/src/bin/work.ts）：本机领单、续租、结束（决定 0096），
// 本机队列（单 #2731），脱离聊天进程派无头工人（单 #2761）。判法、退出码见 ../work.ts、../work-queue.ts、../work-run.ts。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Git } from '../directives.ts';
import { gitRunner } from '../git-runner.ts';
import { ghRunner } from '../issue-new.ts';
import { liveClaimsPost, readClaimsEndpoint, work } from '../work.ts';
import { readLeases, readLocalBeats, removeLease, writeLease } from '../work-queue.ts';
import { runsRoot } from '../work-run.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

// 不自己拼 git 执行器：git grep 没匹配时退出码 1、stderr 空，自己拼的把 err.message 塞进 stderr 会让 directives.ts 判不出「没匹配」
// （gitRunner 的注释写了；test/bin-git-runner.test.ts 钉着入口脚本里不许再有自己拼的）
const git: Git = gitRunner(root);

// agents 的纯 node 脚本：conventions 是零安装区，不静态引包外文件，按路径动态引，只声明用到的。
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
interface SessionLib {
  selectSessionId: NonNullable<import('../work.ts').WorkDeps['run']>['selectSessionId'];
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
const session = wantsRun ? await agentsLib<SessionLib>('agents/hooks/unattended.mjs') : null;

process.exitCode = await work(process.argv.slice(2), {
  gh: ghRunner(root),
  post: liveClaimsPost(() => readClaimsEndpoint()),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
  root,
  queue: {
    git,
    readBeats: () => readLocalBeats(),
    readLeases: () => readLeases(),
    now: () => new Date(),
    env: process.env,
    root,
  },
  leases: { write: (rec) => writeLease(rec), remove: (repo, issue) => removeLease(repo, issue) },
  ...(detach && capacity && session
    ? {
        run: {
          capacity: async () => capacity.judgeCapacity(await capacity.readCapacityAsync()),
          spawnDetached: (file, args, opts) => detach.spawnDetached(file, args, opts),
          git,
          env: process.env,
          selectSessionId: session.selectSessionId,
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
