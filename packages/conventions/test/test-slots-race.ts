// test-slots.test.ts 的并发用例起的子进程：到点同时试一次拿槽，拿到的再占一会儿（别死太早，不然另一个会把它当死槽回收）。
//   node test-slots-race.ts <槽目录> <开抢时刻（毫秒时间戳）> <拿到后占多久（毫秒）>
// 输出一行：GOT 或 BUSY。拿槽出错（TestSlotError）输出 ERROR 和原因。
import {
  DEFAULT_SLOTS,
  realSlotDeps,
  type SlotConfig,
  TestSlotError,
  tryAcquire,
} from '../src/test-slots.ts';

const [dir, startAt, holdMs] = process.argv.slice(2);
if (dir === undefined || startAt === undefined || holdMs === undefined) {
  console.error('用法：test-slots-race.ts <槽目录> <开抢时刻> <占多久>');
  process.exit(2);
}
const cfg: SlotConfig = {
  dir,
  slots: Number(process.env.RACE_SLOTS ?? DEFAULT_SLOTS),
  maxWaitMs: 60_000,
  maxHoldMs: 600_000,
  pollMs: 1000,
  reportMs: 10_000,
};
while (Date.now() < Number(startAt)) {
  // 忙等到点：两个子进程尽量同一刻进 tryAcquire
}
try {
  const r = tryAcquire(
    cfg,
    realSlotDeps(() => {}),
  );
  if (r.kind === 'got') {
    console.log('GOT');
    const until = Date.now() + Number(holdMs);
    while (Date.now() < until) {
      // 占着
    }
    r.handle.release();
  } else {
    console.log('BUSY');
  }
} catch (e) {
  console.log(`ERROR ${e instanceof TestSlotError ? e.message : String(e)}`);
  process.exit(1);
}
