// fleet 可执行入口：接上真的 stdin/stdout、环境变量和网络。
import { runFleet } from './cli.ts';

process.exitCode = await runFleet(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  fetch: globalThis.fetch,
});
