// 决定索引命令行（逻辑在 ../decisions-index.ts）：
// pnpm decisions:index            按各份决定书头部重新生成 docs/decisions/README.md
// pnpm decisions:index --check    核对仓里的索引和生成结果一致：0 一致、1 不一致或头部不对、2 没查成
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkDecisionsIndex, generateDecisionsIndex, INDEX_PATH } from '../decisions-index.ts';
import { exitWith, runMain } from '../exit.ts';
import { fsRepo } from '../repo.ts';

runMain(() => {
  const USAGE = '用法：pnpm decisions:index [--check]';
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const repo = fsRepo(root);
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const unknown = args.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    console.error(`参数不对：认不出「${unknown.join(' ')}」。${USAGE}`);
    exitWith(2);
  }

  if (args.includes('--check')) {
    const problems = checkDecisionsIndex(repo);
    if (problems.length === 0) {
      console.log('决定索引和各份头部一致。');
      exitWith(0);
    }
    for (const p of problems) console.error(p.text);
    exitWith(problems.some((p) => p.notQueried) ? 2 : 1);
  }

  const { text, problems } = generateDecisionsIndex(repo);
  if (text === undefined) {
    for (const p of problems) console.error(p.text);
    console.error('一个字都没写。');
    exitWith(problems.some((p) => p.notQueried) ? 2 : 1);
  }
  if (repo.read(INDEX_PATH) === text) {
    console.log('决定索引本来就是最新的，没动。');
    exitWith(0);
  }
  try {
    writeFileSync(`${root}${INDEX_PATH}`, text, 'utf8');
  } catch (e) {
    console.error(`没查成：写不进 ${INDEX_PATH}（${e instanceof Error ? e.message : String(e)}）。`);
    exitWith(2);
  }
  console.log(`写好了：${INDEX_PATH}`);
  return undefined;
});
