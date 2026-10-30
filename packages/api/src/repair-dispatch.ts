// 看门狗交修复复用 dispatch-issue 的完整准入，不引入任意命令或 shell。
// 服务本身以 fleet 运行，继承同一 DATABASE_URL、Temporal 和 GitHub App 配置。
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type DispatchRunner = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<{ code: number; text: string }>;
/** 起 dispatch-issue 的真跑法；输出留多少字由 maxText 定（看门狗修复 400 够写一行，派单接口要列全每一道没过的原因）。 */
export const dispatchRunner =
  (maxText: number): DispatchRunner =>
  (file, args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { ...options, timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            reject(error);
            return;
          }
          resolve({
            code: error && typeof error.code === 'number' ? error.code : 0,
            text: `${stdout}${stderr}`.trim().slice(0, maxText),
          });
        },
      );
    });
const run = dispatchRunner(400);
export function repairDispatcher(runner: DispatchRunner = run) {
  const entry = fileURLToPath(new URL('../../engine/src/bin/dispatch-issue.ts', import.meta.url));
  return async (repo: { owner: string; name: string }, issueNumber: number, operator: string) => {
    if (
      !/^[\w.-]+$/.test(repo.owner) ||
      !/^[\w.-]+$/.test(repo.name) ||
      !Number.isSafeInteger(issueNumber) ||
      issueNumber < 1
    )
      throw new Error('派工目标不合法');
    const result = await runner(
      process.execPath,
      [entry, `${repo.owner}/${repo.name}`, String(issueNumber)],
      {
        env: {
          ...process.env,
          FLEET_OPS_OPERATOR: operator
            .replace(/[\r\n\0]/g, ' ')
            .trim()
            .slice(0, 64),
        },
      },
    );
    if (result.code !== 0 && !result.text.startsWith('没派：'))
      throw new Error(`派工结果未知（退出码 ${result.code}）：${result.text}`);
    return { ok: result.code === 0, text: result.text || `dispatch-issue 退出码 ${result.code}` };
  };
}
