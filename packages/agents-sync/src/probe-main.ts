// pnpm agents:probe [家的 id …]：真起每家 CLI 问一次读没读到规矩（./probe.ts）。在 fleet-dao 仓根跑（仓根 AGENTS.md 和验证命令按这个仓问）。
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { formatProbe, probeAll, probeExitCode, realRunner } from './probe.ts';
import { AGENTS, type AgentId } from './targets.ts';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const bad = only.filter((a) => !(a in AGENTS));
if (bad.length > 0) {
  process.stderr.write(`认不出：${bad.join('、')}。可选：${Object.keys(AGENTS).join('、')}\n`);
  process.exit(2);
}
const env = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);
const lines = await probeAll({
  detect: { env, platform: process.platform === 'win32' ? 'win32' : 'linux', home: homedir() },
  cwd: fileURLToPath(new URL('../../..', import.meta.url)),
  run: realRunner,
  env,
  ...(only.length > 0 ? { only: only as AgentId[] } : {}),
});
process.stdout.write(`${formatProbe(lines)}\n`);
process.exitCode = probeExitCode(lines);
