// fleet-api groom 的命令行本体（母单 #1335 第 3 片，#1338）：叫一次临时指挥官整理待办。只排队（记一条 groom.request），
// 法国引擎几秒内接手（jobs/groom.ts）。入口和驾驶舱按钮、引擎自己叫同一个判法，拒的情况都明说。
// 退出码：0 排上队了；1 拒了或没查成；2 参数不对。

import { errMessage } from '@fleet-dao/shared/util';
import { GROOM_USAGE, GroomUsageError, parseGroomArgs } from './groom.ts';
import { type GroomRequestDeps, requestGroom } from './groom-request.ts';

export interface GroomCommandIo {
  out(text: string): void;
  err(text: string): void;
  /** 连库（参数对了才连）；close 在用完后关连接。 */
  open(): Promise<{
    deps: GroomRequestDeps;
    /** 库里有没有这个受管的仓（不分大小写）。读不到照抛。 */
    repoKnown(slug: string): Promise<boolean>;
    /** 谁跑的（FLEET_OPS_OPERATOR），写进操作记录的 reason。 */
    operator: string;
    close(): Promise<void>;
  }>;
}

export async function runGroomCommand(argv: readonly string[], io: GroomCommandIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(GROOM_USAGE);
    return 0;
  }
  let args: ReturnType<typeof parseGroomArgs>;
  try {
    args = parseGroomArgs(argv);
  } catch (err) {
    if (!(err instanceof GroomUsageError)) throw err;
    io.err(err.message);
    return 2;
  }
  let opened: Awaited<ReturnType<GroomCommandIo['open']>> | undefined;
  try {
    opened = await io.open();
    if (!(await opened.repoKnown(args.repo))) {
      io.err(`没整理：库里没有仓 ${args.repo}（受管的仓就是 repos 表的行）`);
      return 1;
    }
    const by = `服务器上 ${opened.operator} 跑的 fleet-api groom ${args.repo}`;
    const got = await requestGroom(opened.deps, {
      repo: args.repo,
      source: 'cli',
      reason: args.note ? `${args.note}（${by}）` : by,
    });
    if (!got.ok) {
      io.err(`没整理（${got.reason}）：${got.why}`);
      return 1;
    }
    io.out(
      `排上队了：${args.repo} 的整理待办（编号 ${got.requestId}），引擎几秒内接手。今天还剩 ${got.remainingAfter} 次。结果看驾驶舱，或查操作记录 target=groom。`,
    );
    return 0;
  } catch (err) {
    io.err(`没查成：${errMessage(err)}`);
    return 1;
  } finally {
    await opened?.close().catch(() => undefined);
  }
}
