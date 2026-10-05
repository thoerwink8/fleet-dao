// 法国现在有几个会话在跑，命令行版（#618）：node france-sessions.mjs [--json]。
// 经 ssh 读法国库里 session_runs 中 ended_at 为空的会话（读法见 france-sessions-query.mjs）。发版前「等收尾」和平时看都用它。
// 登法国的 ssh 名字：环境变量 FLEET_FRANCE_SSH，或 ~/.fleet-dao/france-ssh 的第一行（同 france.mjs）。
// 退出码：0 读到了（0 个也是读到了）；2 没读到（没配 ssh、连不上、查库没成、回来的认不出）——不当成 0 个。
import { fetchRunningSessions } from './france-sessions-lib.mjs';

const USAGE = `用法：node france-sessions.mjs [--json]
经 ssh 读法国现在有几个会话在跑（库里 ended_at 为空的）；--json 打整理好的结果。
退出码：0 读到了；2 没读到。`;

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const r = await fetchRunningSessions();
  if (!r.ok) {
    console.error(`没读到法国在跑的会话数（${r.kind}）：${r.why}`);
    return 2;
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  console.log(`法国在跑的会话：${r.running}`);
  for (const row of r.rows)
    console.log(
      `  ${row.repo ?? '（无单）'}${row.n ? `#${row.n}` : ''} ${row.stage}，${row.queued_at} 排的队`,
    );
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
