// CI heavy job 的入口（.github/workflows/ci.yml，判法在 ../test-split.ts 的 heavyBox）：
//   node packages/conventions/src/bin/ci-heavy.ts
// 算出「重型 / 不确定测试」这一份（名单只在 test-split.ts 的 HEAVY_TESTS 一处），把 box=<JSON> 写进 $GITHUB_OUTPUT，
// 形状和 test 台的矩阵项一样，后面直接复用 ci-box.ts 的 files（写清单）和 verify（核对实际跑的 == 该跑的）。
// 退出码 0 = 算出来了；2 = 没算成（名单里的文件不在仓里、要库、要 Temporal 命令行、会被子串过滤拉上别的文件、写不进输出）——判红，不许静默少跑。
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exitWith, runMain } from '../exit.ts';
import { fsRepo } from '../repo.ts';
import { heavyBox, listTestFiles } from '../test-split.ts';

runMain(() => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const repo = fsRepo(root);
  const all = listTestFiles(repo);
  if (typeof all === 'string') {
    console.error(`::error::没算成 heavy 要跑什么：列不出测试文件：${all}`);
    exitWith(2);
  }
  const box = heavyBox(all, (rel) => repo.read(rel));
  if (typeof box === 'string') {
    console.error(`::error::没算成 heavy 要跑什么：${box}`);
    exitWith(2);
  }
  console.log(`heavy：${box.files.length} 个重型 / 不确定测试文件，串行、可重试地跑（不进必过检查）`);
  for (const f of box.files) console.log(`  ${f}`);
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    try {
      appendFileSync(outFile, `box=${JSON.stringify(box)}\n`);
    } catch (e) {
      console.error(`::error::写不进 GITHUB_OUTPUT（${e instanceof Error ? e.message : String(e)}）`);
      exitWith(2);
    }
  }
  return undefined;
});
