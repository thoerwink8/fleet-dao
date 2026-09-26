// 后端管理命令的入口：node packages/api/src/bin/fleet-api.ts <命令> ...（法国上经 packages/api/bin/fleet-api 跑）。
import { CliError, runCli } from '../cli.ts';

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`没设成：${err instanceof CliError ? err.message : String(err)}\n`);
  process.exitCode = err instanceof CliError ? err.exitCode : 1;
}
