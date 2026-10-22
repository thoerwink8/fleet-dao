import { homedir } from 'node:os';
import { AuditUnreadable, audit, launchLogPath, localTime } from './audit.ts';
import { launchOverrides, overrideLines } from './launches.ts';
import { type LaunchStatus, readLaunchStatus } from './migrate.ts';

const args = process.argv.slice(2);
const usage =
  'pnpm mirasim:audit [--days N]\n只读对账：启动命令现状，以及近 N 天（默认 3）每条有回合的会话走了哪份额度。有标红退出 1，没查成退出 2。';

const STATUS_TEXT: Record<LaunchStatus, string> = {
  installed: '已是本工具装的启动器（经 reclaude 选路）',
  drift:
    '被改回了裸 claude（不经 reclaude，会话全走平台额度）；要恢复 pnpm mirasim:migrate，确定不用 pnpm mirasim:migrate --rollback',
  never: '从没装过新版启动器；pnpm mirasim:migrate 安装',
  restored: '已主动撤回；要重新启用 pnpm mirasim:migrate',
  custom: '自定义启动命令，本工具不管',
};

const red = (text: string) => (process.stdout.isTTY ? `\u001b[31m${text}\u001b[0m` : text);

function parseArgs(): { home: string; days: number } | undefined {
  let days = 3;
  let home = homedir();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return undefined;
    if (arg === '--days' || arg === '--home') {
      const next = args[++i];
      if (!next) throw new Error(`${arg} 缺值`);
      if (arg === '--home') home = next;
      else {
        days = Number(next);
        if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days 要是 1 到 90 的整数');
      }
      continue;
    }
    throw new Error('对账参数不认识');
  }
  return { home, days };
}

try {
  const parsed = parseArgs();
  if (!parsed) console.log(usage);
  else {
    const { home, days } = parsed;
    const now = Date.now();
    const status = readLaunchStatus(home);
    if (!status) throw new AuditUnreadable('Mirasim 设置读不到：~/.mirasim/setting.json');
    const headline = `启动命令：${STATUS_TEXT[status.status]}`;
    // 标红的都算进退出码：顶行、会话覆盖、会话对账任何一处红了就退 1。
    let redCount = 0;
    if (status.status === 'drift') {
      redCount++;
      console.log(red(headline));
    } else console.log(headline);
    let overrides: ReturnType<typeof launchOverrides>;
    try {
      overrides = launchOverrides(home);
    } catch (error) {
      throw new AuditUnreadable(error instanceof Error ? error.message : 'Mirasim 路由索引读不到');
    }
    const shown = overrideLines(overrides);
    shown.lines.forEach((line, i) => {
      console.log(shown.red[i] ? red(line) : line);
    });
    redCount += shown.bare;
    const logFile = launchLogPath(home, process.platform, process.env);
    const report = audit(home, logFile, days, now);
    console.log(
      `近 ${days} 天有回合的会话 ${report.sessions.length} 条；启动器日志最早到 ${
        report.logStart ? localTime(new Date(report.logStart).toISOString()) : '（日志里没有带时间的行）'
      }，更早的回合不判是否被绕过`,
    );
    let flagged = 0;
    for (const s of report.sessions) {
      const launches =
        Object.entries(s.launches)
          .map(([k, n]) => `${k}×${n}`)
          .join(' ') || '无';
      const line = `${s.sid.slice(0, 8)}  最近回合 ${localTime(new Date(s.lastTurn).toISOString())}  Mirasim 路由=${s.mirasimRoute}  启动器拉起 ${launches}  回合 ${s.turns}  账本 平台中继 ${s.relay} 直连 ${s.direct}`;
      if (s.flags.length) {
        flagged++;
        console.log(red(`${line}\n          ${s.flags.join('；')}`));
      } else console.log(line);
    }
    console.log(flagged ? red(`标红 ${flagged} 条会话`) : '没有标红');
    redCount += flagged;
    // 有标红退 1（确定的问题优先报）；没标红但有回合放不进对账＝没查全，退 2，不拿 0 冒充没事。
    if (redCount) process.exitCode = 1;
    else if (report.untimedTurns) {
      console.error(`对账没查成：另有 ${report.untimedTurns} 个回合没有开始时间，没放进对账`);
      process.exitCode = 2;
    } else process.exitCode = 0;
    if (redCount && report.untimedTurns)
      console.log(`另有 ${report.untimedTurns} 个回合没有开始时间，没放进对账（没查全）`);
  }
} catch (error) {
  // 读不到、格式不认识、参数错都算没查成：不拿空结果当没事。
  console.error(`对账没查成：${error instanceof Error ? error.message : '未知错误'}`);
  process.exitCode = 2;
}
