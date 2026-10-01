// pnpm agents:sync 入口：把参数接到真的同步上。
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { realGit, realSync, syncNow } from './sync-now.ts';

process.exitCode = await syncNow(process.argv.slice(2), {
  home: homedir(),
  platform: process.platform === 'win32' ? 'win32' : 'linux',
  defaultRepo: fileURLToPath(new URL('../../..', import.meta.url)),
  git: realGit(15_000),
  fetch: realGit(60_000),
  sync: realSync,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
