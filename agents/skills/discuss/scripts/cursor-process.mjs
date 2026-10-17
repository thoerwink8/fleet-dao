import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// 只处理本次调用创建的子树；Windows shell 子孙不受 child.kill() 管。
export function stopProcessTree(child) {
  if (!(child.pid > 0)) throw new Error('执行体没有 PID，无法确认进程树');
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const r = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (r.error || r.status !== 0)
      throw new Error(r.error?.message ?? `taskkill 退出码 ${r.status}：${r.stderr.trim().slice(0, 200)}`);
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (e) {
      if (e?.code !== 'ESRCH') throw e;
    }
  }
}
