// 开单脚本入口：pnpm issue:new --kind 需求 --milestone v1 --title "…" --body-file 正文.md [--specs 短名] [--mother] [--parent 母单号] [--local]（见 ../issue-new.ts）
// 退出码：0 开了；1 没开（或开没开说不准，照报的话去 GitHub 找）；3 开了，但 --local 替帅位在库里认领没成（别重开单）。
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghRunner, hasSeatRecord, issueNew, type LocalClaim, specsHint } from '../issue-new.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** --local：这台接过帅位就当场替帅位认领（claim.mjs take --owner seat，经 ssh 调法国），没接过就只贴标签。 */
async function claimLocal(issueNumber: number): Promise<LocalClaim> {
  if (!hasSeatRecord(homedir()))
    return {
      state: 'skipped',
      why: '这台没接过帅位（~/.fleet-dao/seat/ 里没有 main 的记录）：只贴了「本机做」，库里没认领',
    };
  const r = spawnSync(
    process.execPath,
    [
      join(root, 'agents', 'skills', 'commander-seat', 'scripts', 'claim.mjs'),
      'take',
      String(issueNumber),
      '--owner',
      'seat',
      '--label',
      '帅位',
      '--note',
      '开单时替帅位认领（本机做）',
    ],
    { cwd: root, encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  if (r.status === 0) return { state: 'claimed', text: r.stdout.trim() };
  const why = (r.stderr || r.stdout || '').trim() || String(r.error ?? `claim.mjs 退出码 ${r.status}`);
  return { state: 'failed', why };
}

try {
  const r = await issueNew(process.argv.slice(2), {
    gh: ghRunner(root),
    root,
    cwd: process.env.INIT_CWD || process.cwd(),
    claimLocal,
  });
  console.log(
    `开了 #${r.number}（${r.milestone}${r.parent === undefined ? '' : `，挂在母单 #${r.parent} 下面`}${r.local ? '，贴了「本机做」：接活不自动派' : ''}）：${r.url}`,
  );
  if (r.specsFile) console.log(`需求文档：${r.specsFile}（${specsHint(r.milestone)}）`);
  if (r.claimed?.state === 'claimed') console.log(`库里认领：${r.claimed.text}`);
  if (r.claimed?.state === 'skipped') console.log(r.claimed.why);
  if (r.claimed?.state === 'failed') {
    console.error(
      `单开了（#${r.number}），但替帅位在库里认领没成：${r.claimed.why}\n「本机做」标签照旧挡住自动派；认领用 node agents/skills/commander-seat/scripts/claim.mjs take ${r.number} --owner seat --label 帅位。别重开单。`,
    );
    process.exitCode = 3;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
