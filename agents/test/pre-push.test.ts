// `.githooks/pre-push` 这个壳：git 给的几行参数原样转交给卫生检查、退出码原样交回。
// 从 seat-claim.test.ts 搬过来的（#446 把认领账那半删了，这条和认领无关，不能跟着丢）。
// 判定本身在 packages/hygiene/test/prepush.test.ts；这里只钉钩子文件本身怎么接。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../../.githooks/pre-push', import.meta.url));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWithStub(hygieneExit: number) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-hook-'));
  made.push(dir);
  const hygieneDir = join(dir, 'packages', 'hygiene', 'src', 'bin');
  mkdirSync(hygieneDir, { recursive: true });
  writeFileSync(
    join(hygieneDir, 'pre-push.ts'),
    `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'hygiene.json'))}, JSON.stringify({ argv: process.argv.slice(2), stdin: readFileSync(0, 'utf8') }));
process.exitCode = ${hygieneExit};
`,
  );
  return dir;
}
const run = (dir: string, stdin: string) =>
  spawnSync('sh', [HOOK, 'origin', 'https://example.test/repo.git'], {
    cwd: dir,
    input: stdin,
    encoding: 'utf8',
  });

describe('.githooks/pre-push：只跑卫生检查', () => {
  it('卫生检查收到 git 给的几行和参数，退出码原样交回', () => {
    const lines = `refs/heads/a ${'1'.repeat(40)} refs/heads/a ${'2'.repeat(40)}
`;
    const dir = repoWithStub(0);
    expect(run(dir, lines).status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'hygiene.json'), 'utf8'))).toEqual({
      argv: ['origin', 'https://example.test/repo.git'],
      stdin: lines,
    });
    expect(run(repoWithStub(1), lines).status).toBe(1);
  });

  it('【故意造出的失败】钩子不引用技能目录里的脚本：core.hooksPath 常指向主检出，在别的工作树里跑时那个路径可能不存在', () => {
    expect(readFileSync(HOOK, 'utf8')).not.toMatch(/^[^#]*agents\/skills\//m);
  });
});
