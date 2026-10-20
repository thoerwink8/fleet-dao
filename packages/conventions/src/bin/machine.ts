// pnpm machine join|issue|list|revoke（#3390）：逻辑在 ../machine.ts，这里只装真 ssh / 安装 / HTTP。
// 退出码：0 成；1 没成（参数不对、法国拒、安装或试推或试读没成）。通行证明文不进参数、不打屏。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runMain } from '../exit.ts';
import { type MachineArgs, type MachineDeps, type RunResult, runMachine, USAGE } from '../machine.ts';

const INSTALL = fileURLToPath(new URL('../../../../agents/local-sessions/install.mjs', import.meta.url));

function run(cmd: string, args: string[], env?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const liveDeps: MachineDeps = {
  ssh: (alias, remote) => run('ssh', ['-o', 'BatchMode=yes', alias, remote]),
  install: (args, env) => run(process.execPath, [INSTALL, ...args], env),
  get: async (url, headers) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: await r.text() };
  },
  readStdin: async () => readFileSync(0, 'utf8'),
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
};

runMain(async () => {
  let values: { name?: string; url?: string; ssh?: string; 'token-stdin'?: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      options: {
        name: { type: 'string' },
        url: { type: 'string' },
        ssh: { type: 'string' },
        'token-stdin': { type: 'boolean' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return 1;
  }
  const [cmd, id, ...extra] = positionals;
  if ((cmd !== 'join' && cmd !== 'issue' && cmd !== 'list' && cmd !== 'revoke') || extra.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const args: MachineArgs = {
    cmd,
    ...(id !== undefined ? { id } : {}),
    ...(values.name !== undefined ? { name: values.name } : {}),
    ...(values.url !== undefined ? { url: values.url } : {}),
    ...(values.ssh !== undefined ? { ssh: values.ssh } : {}),
    tokenStdin: values['token-stdin'] === true,
  };
  return runMachine(args, liveDeps);
});
