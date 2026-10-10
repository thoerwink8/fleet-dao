// 规矩瘦身单入口：node packages/conventions/src/bin/rules-budget.ts [--open]
// 不带参数：只读账本和文件，报现字数、累计增长、该不该瘦身（不读 GitHub）。
// --open：该瘦身且没有开着的瘦身单，就开一张（只给 .github/workflows/debt.yml 的定时任务用，不挡任何 PR）。
// 退出码 0 = 没事或已开/已有；2 = 没查成（读不到账本、文件或 GitHub，开单失败）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { liveGitHub, repoName } from '../github-api.ts';
import { countGeneral, countRepo, LABEL, parseLedger, slimDue, slimRun } from '../rules-budget.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const open = process.argv.includes('--open');
try {
  const ledger = parseLedger(readFileSync(`${root}agents/rules-budget.json`, 'utf8'));
  const actual = {
    general: countGeneral(readFileSync(`${root}agents/shared-rules.md`, 'utf8')),
    repo: countRepo(readFileSync(`${root}AGENTS.md`, 'utf8')),
  };
  for (const n of ['general', 'repo'] as const) {
    const s = ledger[n];
    console.log(
      `${LABEL[n]}：实际 ${actual[n]} 字，账上 ${s.chars}，baseline ${s.baseline}，阈值 ${ledger.threshold[n]}`,
    );
  }
  const due = slimDue(ledger);
  console.log(
    due.length
      ? `该瘦身：${due.map((d) => `${LABEL[d.section]}超了 ${d.over} 字`).join('；')}`
      : '不用瘦身。',
  );
  if (open) {
    const name = repoName(process.env, root);
    if (!name) throw new Error('认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）');
    const gh = liveGitHub(name, process.env);
    const r = await slimRun(ledger, gh);
    if (r.kind === 'opened') console.log(`开了瘦身单 #${r.number}`);
    else if (r.kind === 'already') console.log(`已有开着的瘦身单 #${r.number}，没再开。`);
  }
} catch (e) {
  console.error(`没查成：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
