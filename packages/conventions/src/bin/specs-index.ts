// 方案索引命令行（逻辑在 ../specs-index.ts）：
// pnpm specs:index            按各方案目录主文件的头部重新生成 specs/README.md
// pnpm specs:index --check    核对仓里的索引和生成结果一致（进 pnpm check）：0 一致、1 不一致或头部不对、2 没查成
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exitWith, runMain } from '../exit.ts';
import { fsRepo } from '../repo.ts';
import { checkSpecsIndex, generateSpecsIndex, SPECS_INDEX_PATH } from '../specs-index.ts';

runMain(() => {
  const USAGE = '用法：pnpm specs:index [--check]';
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const repo = fsRepo(root);
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const unknown = args.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    console.error(`参数不对：认不出「${unknown.join(' ')}」。${USAGE}`);
    exitWith(2);
  }

  if (args.includes('--check')) {
    const problems = checkSpecsIndex(repo);
    if (problems.length === 0) {
      console.log('方案索引和各目录头部一致。');
      exitWith(0);
    }
    for (const p of problems) console.error(p.text);
    exitWith(problems.some((p) => p.notQueried) ? 2 : 1);
  }

  const { text, problems } = generateSpecsIndex(repo);
  if (text === undefined) {
    for (const p of problems) console.error(p.text);
    console.error('一个字都没写。');
    exitWith(problems.some((p) => p.notQueried) ? 2 : 1);
  }
  if (repo.read(SPECS_INDEX_PATH) === text) {
    console.log('方案索引本来就是最新的，没动。');
    exitWith(0);
  }
  try {
    writeFileSync(`${root}${SPECS_INDEX_PATH}`, text, 'utf8');
  } catch (e) {
    console.error(`没查成：写不进 ${SPECS_INDEX_PATH}（${e instanceof Error ? e.message : String(e)}）。`);
    exitWith(2);
  }
  console.log(`写好了：${SPECS_INDEX_PATH}`);
  return undefined;
});
