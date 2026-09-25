// 假的 fleet-agent-scope：只在测试里用。run 把自己的参数和环境记下来，然后照帮手脚本的规矩起 -- 后面的命令；
// stop 只记一笔。记录写到环境变量 FLEET_FAKE_SCOPE_LOG 指的文件（一行一条 JSON）。
// 真帮手（deploy/france/fleet-agent-scope.sh）以 root 跑、换身份、进 scope；这里只验插头交给它的东西对不对。
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [action, ...rest] = process.argv.slice(2);
const log = process.env.FLEET_FAKE_SCOPE_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ action, args: rest, env: process.env })}\n`);

if (action === 'run') {
  const at = rest.indexOf('--');
  const cwdAt = rest.indexOf('--cwd');
  const command = rest.slice(at + 1);
  // 和真帮手一样：环境只剩 FLEET_* 这几类；PATH 取 FLEET_SESSION_PATH（没给用同一个默认），会话用户自己写得动的
  // ~/.local/bin 接在最后
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v !== undefined &&
      /^(FLEET_[A-Z0-9_]+|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|GIT_TERMINAL_PROMPT)$/.test(k)
    )
      env[k] = v;
  }
  env.HOME = '/home/fake-session-user';
  env.PATH = `${process.env.FLEET_SESSION_PATH ?? '/usr/local/bin:/usr/bin:/bin'}:${env.HOME}/.local/bin`;
  const child = spawn(command[0] as string, command.slice(1), {
    cwd: cwdAt >= 0 ? rest[cwdAt + 1] : '/',
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
} else {
  process.exit(0);
}
