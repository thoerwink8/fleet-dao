// git pre-push 钩子（.githooks/pre-push 调它）：推之前把要推的新内容过一遍卫生检查，查出来就拒推。
// pnpm install 的 prepare 会把 core.hooksPath 设成 .githooks（bin/install-hooks.ts）。判定在 prepush.ts。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type GitSync, parsePushedRefs, prePushCheck } from '../prepush.ts';
import { loadSensitiveValues } from '../values.ts';

const git: GitSync = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
};

const [remote = 'origin'] = process.argv.slice(2);
const { code, lines } = prePushCheck({
  remote,
  refs: parsePushedRefs(readFileSync(0, 'utf8')),
  git,
  values: loadSensitiveValues(),
});
for (const line of lines) (code === 0 ? console.log : console.error)(line);
process.exitCode = code;
