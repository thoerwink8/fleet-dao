// 写锁：同一个家目录同一时刻只许一个 --apply / --retire-old 在写。几个会话同时开，开会话钩子会同时跑同步，
// 两边一起删、一起写同一个 skill 目录，会留下写到一半的目录。锁是 ~/.fleet-dao/agents-sync.lock（里面记进程号和时间）；
// 拿锁的进程已经不在、或者锁放了超过 STALE_MS，当成上次崩了留下的，拿过来。
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { type Platform, placeOn, STATE_DIR, slashed } from './targets.ts';

export const STALE_MS = 2 * 60_000;

export type Lock = { ok: true; release: () => void } | { ok: false; key: string; why: string };

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 没权限发信号也说明进程在（换了身份跑的另一个同步）
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function takeLock(home: string, platform: Platform, now: Date, pid: number = process.pid): Lock {
  const rel = join(placeOn(STATE_DIR, platform), 'agents-sync.lock');
  const file = join(home, rel);
  const key = `~/${slashed(rel)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(join(home, placeOn(STATE_DIR, platform)), { recursive: true });
      const fd = openSync(file, 'wx');
      try {
        writeSync(fd, `${pid} ${now.toISOString()}\n`);
      } finally {
        closeSync(fd);
      }
      return {
        ok: true,
        release: () => {
          try {
            unlinkSync(file);
          } catch {
            // 已经不在了
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST')
        return { ok: false, key, why: `拿不到写锁（${(err as NodeJS.ErrnoException).code ?? String(err)}）` };
    }
    let holder = NaN;
    let age = 0;
    try {
      holder = Number(readFileSync(file, 'utf8').split(' ')[0]);
      // 锁文件的修改时间是真时钟，这里也用真时钟（now 可能是测试给的假时间）
      age = Date.now() - statSync(file).mtimeMs;
    } catch {
      // 刚被放掉：再试一次
      continue;
    }
    if (attempt === 0 && (!alive(holder) || age > STALE_MS)) {
      try {
        unlinkSync(file);
      } catch {
        // 别人先清掉了
      }
      continue;
    }
    return {
      ok: false,
      key,
      why: `另一个 agents-sync 在写（进程 ${Number.isNaN(holder) ? '认不出' : holder}，${Math.max(0, Math.round(age / 1000))} 秒前拿的锁），这次一样没动`,
    };
  }
  return { ok: false, key, why: '拿不到写锁（锁一直被人占着），这次一样没动' };
}
