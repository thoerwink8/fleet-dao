// pnpm work claim|renew|done <单号> | queue [--json]（= node packages/conventions/src/bin/work.ts）：本机领单、续租、结束（决定 0096），
// 本机队列（单 #2731）。判法、退出码见 ../work.ts、../work-queue.ts。
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Git } from '../directives.ts';
import { ghRunner } from '../issue-new.ts';
import { liveClaimsPost, readClaimsEndpoint, work } from '../work.ts';
import { readLocalBeats } from '../work-queue.ts';

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

process.exitCode = await work(process.argv.slice(2), {
  gh: ghRunner(root),
  post: liveClaimsPost(() => readClaimsEndpoint()),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  queue: { git, readBeats: () => readLocalBeats(), now: () => new Date() },
});
