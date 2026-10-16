// fleet-api daily-brief 的本体（法国上经 packages/api/bin/fleet-api 转过来，换成 fleet 身份、带 api.env 跑）：
//   node packages/engine/src/bin/daily-brief.ts [--as-today]
// 手动跑一次每日简报（jobs/daily-brief.ts），和定时那一轮同一份收集、同一份写法：写一行提醒（驾驶舱后端推飞书）、用引擎机器人在 #1055 发评论。
// 默认是「手动触发」：另一个键、另一个标题，不冒充今天 08:30 定时那一条（看门狗只认定时那一条，08:30 照常推）。
// --as-today：补发今天定时那一条（08:30 那一轮没发成、修好以后用）；今天那条已经推过的不会再推第二次。
// 退出码：0 发了（含有几块没查成）；1 没发成；2 参数不对。
import { createDb } from '@fleet-dao/db';
import { createGitHub } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { pgLedger, pgLocker } from '@fleet-dao/store';
import { runDailyBriefJob } from '../jobs/daily-brief.ts';
import { dailyBriefJob } from '../real/daily-brief.ts';

export const DAILY_BRIEF_USAGE =
  '用法：fleet-api daily-brief [--as-today]（手动跑一次每日简报：推飞书团队群、在 #1055 发评论；默认标成手动触发，不顶替今天 08:30 那一条；--as-today 补发今天定时那一条）';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(DAILY_BRIEF_USAGE);
  process.exit(0);
}
const unknown = args.filter((a) => a !== '--as-today');
if (unknown.length > 0) {
  console.error(`参数不对（${unknown.join(' ')}）。${DAILY_BRIEF_USAGE}`);
  process.exit(2);
}

const { db, close } = createDb({ env: process.env });
try {
  const gh = createGitHub({ ledger: pgLedger(db), locker: pgLocker(db) });
  const result = await runDailyBriefJob(dailyBriefJob({ db, gh })(), {
    manual: !args.includes('--as-today'),
  });
  console.log(`每日简报：${result.outcome}${'why' in result && result.why ? `（${result.why}）` : ''}`);
  process.exitCode = 0;
} catch (err) {
  console.error(`每日简报没发成：${errMessage(err)}`);
  process.exitCode = 1;
} finally {
  await close();
}
