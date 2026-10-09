// `.githooks/pre-push` 这个壳：git 给的几行参数原样转交给卫生检查、退出码原样交回。
// 判定本身在 packages/hygiene/test/prepush.test.ts（卫生检查）和 packages/conventions/test/prepare-push.test.ts（推前预检）；
// 这里只钉钩子文件本身怎么接：先卫生检查、再预检，两段的退出码都原样交回，前一段红了后一段不跑。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

const HOOK = fileURLToPath(new URL('../../.githooks/pre-push', import.meta.url));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWithStub(hygieneExit: number, prepareExit = 0) {
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
  const prepareDir = join(dir, 'packages', 'conventions', 'src', 'bin');
  mkdirSync(prepareDir, { recursive: true });
  writeFileSync(
    join(prepareDir, 'prepare-push.ts'),
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'prepare.json'))}, 'ran');
process.exitCode = ${prepareExit};
`,
  );
  return dir;
}
const ranPrepare = (dir: string) => existsSync(join(dir, 'prepare.json'));
const run = (dir: string, stdin: string) =>
  runChild('sh', [HOOK, 'origin', 'https://example.test/repo.git'], {
    cwd: dir,
    input: stdin,
  });

describe('.githooks/pre-push：卫生检查 + 推前预检', () => {
  it('卫生检查收到 git 给的几行和参数，退出码原样交回', () => {
    const lines = `refs/heads/a ${'1'.repeat(40)} refs/heads/a ${'2'.repeat(40)}
`;
    const dir = repoWithStub(0);
    expect(run(dir, lines).status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'hygiene.json'), 'utf8'))).toEqual({
      argv: ['origin', 'https://example.test/repo.git'],
      stdin: lines,
    });
    expect(ranPrepare(dir)).toBe(true);
  });

  it('【故意造出的失败】卫生检查红了：退出码原样交回，推前预检不跑', () => {
    const dir = repoWithStub(1);
    expect(run(dir, 'x').status).toBe(1);
    expect(ranPrepare(dir)).toBe(false);
  });

  it('【故意造出的失败】推前预检红了（1）或没查成（2）：退出码原样交回，不被吞成通过', () => {
    expect(run(repoWithStub(0, 1), 'x').status).toBe(1);
    expect(run(repoWithStub(0, 2), 'x').status).toBe(2);
  });

  it('【故意造出的失败】钩子不引用技能目录里的脚本：core.hooksPath 常指向主检出，在别的工作树里跑时那个路径可能不存在', () => {
    expect(readFileSync(HOOK, 'utf8')).not.toMatch(/^[^#]*agents\/skills\//m);
  });
});
