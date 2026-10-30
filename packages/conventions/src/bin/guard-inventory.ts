// pnpm exec node packages/conventions/src/bin/guard-inventory.ts [--weekly-progress]
// 零安装、只读库存；可选周一写 #1055。读失败明确退出 2，定时调用方只展示、不挡对账结果。
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runMain } from '../exit.ts';
import { resolveRepo } from '../github-api.ts';
import { collectGuardInventory, renderGuardInventory } from '../guard-inventory.ts';
import { weeklyGuardProgress } from '../guard-inventory-progress.ts';
import { ghRunner } from '../issue-new.ts';
import { progressNoteWithLedger } from '../ledger-note.ts';
import { PROGRESS_ISSUE } from '../progress.ts';
import { fsRepo } from '../repo.ts';

runMain(async () => {
  try {
    const { values } = parseArgs({ options: { 'weekly-progress': { type: 'boolean' } }, strict: true });
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const now = new Date();
    const report = collectGuardInventory(fsRepo(root), now);
    const text = renderGuardInventory(report);
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    if (values['weekly-progress']) {
      const gh = ghRunner(root);
      const result = await weeklyGuardProgress(report, now, {
        async readSince(since) {
          const r = await gh([
            'api',
            `repos/thoerwink8/fleet-dao/issues/${PROGRESS_ISSUE}/comments?since=${since}&per_page=100`,
            '--paginate',
            '--slurp',
          ]);
          if (r.code !== 0) throw new Error('库存周报没查成：读进度评论失败');
          const pages: unknown = JSON.parse(r.stdout);
          if (!Array.isArray(pages) || !pages.every(Array.isArray))
            throw new Error('库存周报没查成：评论分页认不出');
          const comments = pages.flat();
          if (!comments.every((c) => c && typeof c.body === 'string'))
            throw new Error('库存周报没查成：评论正文认不出');
          return comments.map((c) => c.body as string);
        },
        async note(note) {
          // 双写（#3741 片 2b）：先写法国账本（CI 里没有机器通行证时只警告），再照旧贴 #1055；幂等键用当天日期
          await progressNoteWithLedger(
            note,
            { gh },
            {
              repo: resolveRepo(process.env, root).repo,
              kind: 'report.guards',
              idempotencyKey: `guard-inventory:${now.toISOString().slice(0, 10)}`,
            },
          );
        },
      });
      console.log(`库存周报：${result}`);
    }
    if (report.problems.length) process.exitCode = 2;
  } catch (e) {
    console.error(`护栏库存没查成：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
});
