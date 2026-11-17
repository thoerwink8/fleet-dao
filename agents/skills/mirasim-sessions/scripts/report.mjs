// 执行会话向指挥会话回报：node report.mjs --to <会话key> --title <活名> --file <正文>
// 正文放文件里，避免命令行引号被吞。发完打印 ok；失败退出码 1；参数不对退出码 2。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hostPort, mirasimServer, realExec, Stop } from './dispatch.mjs';

export const USAGE = `用法：node report.mjs --to <会话key> --title <活名> --file <正文文件> [--port <端口>]
把正文发给指挥会话。看到 ok 才算发出；失败退出码 1，参数不对退出码 2。`;

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function parseReportArgs(argv) {
  /** @type {Record<string, string>} */
  const got = {};
  const known = ['to', 'title', 'file', 'port'];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Stop('参数', `不认识的参数 ${token}\n${USAGE}`, 2);
    const key = token.slice(2);
    if (!known.includes(key)) throw new Stop('参数', `不认识的参数 ${token}\n${USAGE}`, 2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Stop('参数', `${token} 缺值\n${USAGE}`, 2);
    got[key] = value;
    i += 1;
  }
  for (const key of ['to', 'title', 'file']) {
    if (!got[key]) throw new Stop('参数', `缺 --${key}\n${USAGE}`, 2);
  }
  return got;
}

/**
 * @param {string[]} argv
 * @param {{
 *   exec?: typeof realExec,
 *   env?: NodeJS.ProcessEnv,
 *   log?: (line: string) => void,
 *   server?: string,
 *   nodePath?: string,
 *   now?: number,
 *   readFile?: (path: string) => string,
 * }} [io]
 * @returns {number}
 */
export function reportRun(argv, io = {}) {
  const exec = io.exec ?? realExec;
  const env = io.env ?? process.env;
  const log = io.log ?? ((line) => console.log(line));
  const err = (line) => console.error(line);
  const read = io.readFile ?? ((path) => readFileSync(path, 'utf8'));
  try {
    const opt = parseReportArgs(argv);
    const server = io.server ?? mirasimServer(env);
    const nodePath = io.nodePath ?? process.execPath;
    const port = hostPort(env, opt.port);
    const body = read(opt.file);
    /** @type {string[]} */
    const args = [server, 'ui-cli', '--port', port];
    args.push(
      'call',
      'prompt',
      '--args',
      JSON.stringify({
        clientRef: `report-${io.now ?? Date.now()}`,
        sessionKey: opt.to,
        prompt: `[${opt.title} 回报]\n${body}`,
      }),
    );
    const result = exec(nodePath, args, { env, timeout: 120_000 });
    if (result.code !== 0) {
      throw new Stop(
        '回报',
        `prompt 没成（退出码 ${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 300)}`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Stop('回报', 'prompt 的输出不是 JSON');
    }
    if (parsed?.ok !== true) {
      throw new Stop('回报', `没发出去：${JSON.stringify(parsed).slice(0, 300)}`);
    }
    log(`ok 已发给 ${opt.to}`);
    return 0;
  } catch (error) {
    if (error instanceof Stop) {
      err(`停在：${error.step}`);
      err(`下一步：${error.next}`);
      return error.code;
    }
    err(`停在：脚本`);
    err(`下一步：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exit(reportRun(process.argv.slice(2)));
}
