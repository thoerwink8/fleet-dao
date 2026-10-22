import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactName, runtimeSourceHash } from './build.ts';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const name = artifactName(process.platform, process.arch);
const sourceHash = runtimeSourceHash(repo);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const dir = join(repo, '_tmp', name);
mkdirSync(dir, { recursive: true });
const file = process.platform === 'win32' ? 'mirasim-reclaude.exe' : 'mirasim-reclaude';
execFileSync(
  'go',
  [
    'build',
    '-trimpath',
    '-ldflags',
    `-s -w -X main.sourceCommit=${commit} -X main.sourceHash=${sourceHash}`,
    '-o',
    join(dir, file),
    '.',
  ],
  {
    cwd: join(repo, 'packages', 'mirasim-reclaude', 'launcher'),
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0' },
  },
);
const sha256 = createHash('sha256')
  .update(readFileSync(join(dir, file)))
  .digest('hex');
writeFileSync(
  join(dir, 'manifest.json'),
  `${JSON.stringify({ schema: 1, file, sha256, sourceHash, commit, platform: process.platform, arch: process.arch }, null, 2)}\n`,
);
console.log(`已构建 ${name}，源码与文件校验已写 manifest.json`);
