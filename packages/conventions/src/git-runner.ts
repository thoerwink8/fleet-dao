// 引导读写用的 git 执行器（bin/progress.ts 和测试共用）。
// 退出码非 0 时 stderr 只放 git 自己说的话：git 没说话（比如 git grep 没匹配，退出码 1、stderr 空）就留空，
// 不拿 Node 的 err.message（"Command failed: git ..."）顶上——那样 directives.ts 判「没匹配」永远不成立。
// 只有 git 根本没起来（找不到可执行文件、cwd 不存在，err.code 不是数字）才用 err.message 说原因。
import { execFile } from 'node:child_process';
import type { Git } from './directives.ts';

export function gitRunner(cwd: string): Git {
  return (args, opts = {}) =>
    new Promise((done) => {
      const child = execFile(
        'git',
        args,
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, ...(opts.env ?? {}) },
        },
        (err, stdout, stderr) => {
          if (!err) return done({ code: 0, stdout, stderr });
          if (typeof err.code === 'number') return done({ code: err.code, stdout, stderr });
          done({ code: 1, stdout, stderr: stderr || err.message });
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
}
