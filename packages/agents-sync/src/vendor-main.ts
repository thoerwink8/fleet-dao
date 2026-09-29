// agents-vendor 的进程入口：只接线，判断都在 vendor-cli.ts。
import { fileURLToPath } from 'node:url';
import { runVendorCli } from './vendor-cli.ts';

const defaultRepo = fileURLToPath(new URL('../../..', import.meta.url));
process.exitCode = runVendorCli(process.argv.slice(2), {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  defaultRepo,
});
