// pnpm agents:sync 的可执行入口：接上真的 git、agents-sync 和输出。
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { realGit, realSync, syncNow } from './sync-now.ts';

process.exitCode = syncNow(process.argv.slice(2), {
  home: homedir(),
  platform: process.platform === 'win32' ? 'win32' : 'linux',
  defaultRepo: fileURLToPath(new URL('../../..', import.meta.url)),
  git: realGit(15_000),
  fetch: (repo) => realGit(60_000)(repo, ['fetch', '-q', 'origin']),
  sync: realSync,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
