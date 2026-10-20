// Test-only intermediary: deliberate parent death; the real fixed SQL child retains its own watchdog.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL('../../src/real/legacy-admission-child.ts', import.meta.url))],
  {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { SystemRoot: process.env.SystemRoot },
  },
);
child.stdin.on('error', () => {});
child.stdin.end(Buffer.concat(chunks));
if (process.connected) process.send({ childPid: child.pid });
process.on('message', (message) => {
  if (message === 'exit-now') process.exit(0);
});
