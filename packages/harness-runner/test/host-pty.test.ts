// 终端帧（#3927）：真 hostd 开一个 pty，中文原样回来，关掉之后有 exit。没有 hostd 二进制就跳过。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostdBinary, makeHostdHost } from '../src/host-hostd.ts';
import { HostdPty } from '../src/host-pty.ts';

const BIN = hostdBinary();

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return cond();
}

describe.skipIf(!BIN)('hostd：终端', () => {
  it('打出中文，改大小，关掉之后有退出帧', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hostd-pty-'));
    const host = makeHostdHost({ bin: BIN, stateDir: join(cwd, 'state') });
    const pty = new HostdPty(host);
    const chunks: Buffer[] = [];
    let exited: { code: number | null; signal: string | null } | undefined;
    const runId = `pty-${process.pid}`;
    await pty.open({
      runId,
      cwd,
      cols: 80,
      rows: 24,
      onData: (b64) => chunks.push(Buffer.from(b64, 'base64')),
      onExit: (code, signal) => {
        exited = { code, signal };
      },
    });
    const command =
      process.platform === 'win32'
        ? "Write-Output ('FLEET3927-' + [char]0x4E2D + [char]0x6587)\r"
        : "printf 'FLEET3927-\\344\\270\\255\\346\\226\\207\\n'\n";
    await pty.input(runId, Buffer.from(command).toString('base64'));
    const seen = await until(() => Buffer.concat(chunks).includes('FLEET3927-中文'), 15_000);
    expect(seen, Buffer.concat(chunks).toString('utf8')).toBe(true);
    await pty.resize(runId, 100, 40);
    await pty.close(runId);
    expect(await until(() => exited !== undefined, 5_000)).toBe(true);
    await host.close();
  }, 25_000);
});
