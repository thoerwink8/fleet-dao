import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 迁移可能等 6 小时，不能因锁的年龄抢走仍活着的进程。
export function takeLock(home: string, name: 'migration' | 'worker'): (() => void) | undefined {
  const root = join(home, '.fleet-dao', 'mirasim-reclaude');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, `${name}.lock`);
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeFileSync(fd, owner);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(file, 'utf8') === owner) unlinkSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('迁移互斥记录创建失败');
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('迁移互斥记录读取失败');
    }
    // 另一个进程刚创建文件，还没写完时只等，不误删。
    if (!text) return undefined;
    let pid: number;
    try {
      pid = JSON.parse(text).pid;
    } catch {
      throw new Error('迁移互斥记录格式错误');
    }
    if (!Number.isInteger(pid) || pid < 1) throw new Error('迁移互斥记录进程编号错误');
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return undefined;
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('已有迁移进程状态无法确认');
    }
    // 只回收确认已退出且记录仍一致的进程；活着的后台任务永不过期。
    try {
      if (readFileSync(file, 'utf8') === text) unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('旧迁移互斥记录无法回收');
    }
  }
  return undefined;
}
