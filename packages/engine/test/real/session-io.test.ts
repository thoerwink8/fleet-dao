// 会话脱开引擎跑的收发目录（real/session-io.ts）：根目录核不过就不脱开（明说原因），接回记录认不出就接不回（明说哪一项）。
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkIoRoot,
  META_FILE,
  parseSessionMeta,
  readSessionMeta,
  type SessionMeta,
  writeSessionMeta,
} from '../../src/real/session-io.ts';

const onPosix = process.platform !== 'win32';
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'fleet-session-io-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const META: SessionMeta = {
  v: 1,
  runId: '6f1c2b1e-8a57-4d0c-9d3e-0c1c9e2f4a11',
  sessionId: '0b4c7a2e-3f5d-4a8b-9c1d-2e3f4a5b6c7d',
  agentSessionId: '0b4c7a2e-3f5d-4a8b-9c1d-2e3f4a5b6c7d',
  hostId: 'claude-code',
  taskId: 'a1b2c3d4-0000-4000-8000-000000000001',
  stage: 'execute',
  kind: 'delivery',
  mode: 'new',
  user: 'fleet-agent-carpool',
  poolId: 'claude-carpool',
  routeId: 'carpool',
  dir: '/var/lib/fleet-work/o_r/12-x',
  baseHead: null,
  defaultBranch: 'main',
  reviewHead: null,
  verifyCriteria: null,
  startedAt: Date.parse('2026-09-28T01:00:00.000Z'),
  oomBefore: { slice: 0 },
  limits: { idleMs: 360_000, wallClockMs: 5_340_000 },
  testCommands: ['pnpm test'],
  cgroupLimits: { memoryHigh: '1536M', memoryMax: '2048M', memorySwapMax: '0' },
  model: 'claude-opus-5-5',
  session: { mode: 'new', id: '0b4c7a2e-3f5d-4a8b-9c1d-2e3f4a5b6c7d' },
  purpose: 'work',
};

describe('收发目录的根', () => {
  it.skipIf(!onPosix)('归引擎、711：能用', () => {
    const d = temp();
    chmodSync(d, 0o711);
    expect(checkIoRoot(d)).toBeUndefined();
  });

  it.skipIf(!onPosix)('别人读得了（755）、写得进（777）、进不去（700）：不脱开，说清权限要 711', () => {
    const d = temp();
    for (const mode of [0o755, 0o777, 0o700]) {
      chmodSync(d, mode);
      expect(checkIoRoot(d)).toMatch(/要 711/);
    }
  });

  it.skipIf(!onPosix)('不归引擎：不脱开，说清属主', () => {
    const d = temp();
    chmodSync(d, 0o711);
    expect(checkIoRoot(d, (process.getuid?.() ?? 0) + 1)).toMatch(/不归引擎/);
  });

  it('不在、不是目录、相对路径、认不出用户号：不脱开，说清原因', () => {
    const d = temp();
    expect(checkIoRoot('/nonexistent-fleet-io-root', 1000)).toMatch(/france\.sh/);
    writeFileSync(join(d, 'file'), '');
    if (onPosix) expect(checkIoRoot(join(d, 'file'), 1000)).toMatch(/不是目录/);
    expect(checkIoRoot('relative/io', 1000)).toMatch(/绝对路径/);
    expect(checkIoRoot('/var/lib/fleet-sessions', undefined)).toMatch(/不是 Linux/);
  });
});

describe('接回记录', () => {
  it('写了读得回；不存环境和通行证', async () => {
    const d = join(temp(), 'run');
    await writeSessionMeta(d, META);
    const got = await readSessionMeta(d);
    expect(got).toEqual({ meta: META });
    const text = JSON.stringify(META);
    expect(text).not.toMatch(/fleetToken|FLEET_TOKEN|fleetApi/);
  });

  it('没有记录：接不回（这个会话不是脱开跑的）', async () => {
    const d = temp();
    expect(await readSessionMeta(d)).toEqual({ error: expect.stringContaining('没有接回记录') });
  });

  it('不是 JSON、版本不对、缺项、执行方式没接上、会话用户不认识：都接不回，说清哪一项', async () => {
    const d = temp();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, META_FILE), '{半截');
    expect(await readSessionMeta(d)).toEqual({ error: expect.stringContaining('不是 JSON') });
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ ...META, v: 2 }, /版本/],
      [{ ...META, runId: '' }, /runId/],
      [{ ...META, hostId: 'codex' }, /hostId/],
      [{ ...META, user: 'root' }, /user/],
      [{ ...META, mode: 'teleport' }, /mode/],
      [{ ...META, startedAt: 'yesterday' }, /startedAt/],
      [{ ...META, session: { mode: 'fork', id: 'x' } }, /session/],
      [{ ...META, previousCost: 'free' }, /previousCost/],
      [{ ...META, testCommands: [1] }, /testCommands/],
    ];
    for (const [meta, why] of bad) {
      expect(() => parseSessionMeta(JSON.stringify(meta))).toThrow(why);
    }
  });
});
