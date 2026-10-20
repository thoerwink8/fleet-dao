import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseIsolatedArgs, parseIsolatedResource, runIsolatedTests } from '../isolated-test.ts';
import { acquireSlot, readSlotConfig, realSlotDeps, slotPolicy } from '../test-slots.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
let handle: ReturnType<typeof acquireSlot> | undefined;
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const args = parseIsolatedArgs(process.argv.slice(2));
  const resource = parseIsolatedResource(readFileSync(args.resource, 'utf8'));
  if (slotPolicy(process.env).kind === 'lock')
    handle = acquireSlot(readSlotConfig(process.env), realSlotDeps(console.log));
  const result = await runIsolatedTests(root, resource, args.files, process.env, controller.signal);
  if (result.error) console.error(result.error.message);
  process.exitCode = result.error ? 2 : (result.status ?? 2);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
} finally {
  handle?.release();
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
