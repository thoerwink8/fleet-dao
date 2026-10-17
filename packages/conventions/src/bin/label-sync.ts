// 查询轴标签同步入口：node packages/conventions/src/bin/label-sync.ts
// 把 labels.ts 里 QUERY_LABEL_SPECS 的六个标签（域:…、性质:…）建到本仓上，已有的只改颜色和说明（gh label create --force）。
// 给 .github/workflows/label-sync.yml（主线上标签词汇有改动时、手动时跑）和人手跑用；开单、开 PR 前也会自己补建，这里保证仓上先有。
// 退出码 0 = 六个都在仓上了；2 = 有没建成的。
import { spawnSync } from 'node:child_process';
import { runMain } from '../exit.ts';
import { labelCreateFailure, QUERY_LABEL_SPECS, queryLabelCreateArgs } from '../labels.ts';

runMain(async () => {
  let failed = 0;
  for (const spec of QUERY_LABEL_SPECS) {
    const r = spawnSync('gh', queryLabelCreateArgs(spec), { encoding: 'utf8' });
    const problem = labelCreateFailure(spec, {
      code: r.status ?? 1,
      stdout: r.stdout ?? '',
      stderr: r.error ? String(r.error.message) : (r.stderr ?? ''),
    });
    if (problem) {
      console.error(problem);
      failed++;
    } else {
      console.log(`标签「${spec.name}」已在仓上。`);
    }
  }
  if (failed) process.exitCode = 2;
});
