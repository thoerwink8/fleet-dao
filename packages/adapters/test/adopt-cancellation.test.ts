import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptWorktree } from '../src/procs.ts';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile,
}));

const CAPABILITIES = JSON.stringify({
  version: 1,
  state: 'ok',
  features: [
    'tree-usage',
    'identity-remove',
    'cleanup-status',
    'cleanup-rollback',
    'locked-adopt',
    'temporary-files',
  ],
});
const ADOPTED = JSON.stringify({
  version: 1,
  state: 'adopted',
  identity: {
    lex: '/var/lib/fleet-work/acme_demo/3343-probe',
    real: '/var/lib/fleet-work/acme_demo/3343-probe',
    dev: '1',
    ino: '2',
    uid: '993',
  },
});
type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const input = (signal: AbortSignal) => ({
  dir: '/var/lib/fleet-work/acme_demo/3343-probe',
  user: 'fleet-agent-carpool' as const,
  helper: '/fixed-root-helper',
  sudo: [],
  signal,
});

beforeEach(() => {
  execFile.mockReset();
});

describe('root helper 未发送的认领服从取消', () => {
  it('已取消时连 capabilities 都不启动，并保留原取消', async () => {
    execFile.mockImplementation((_bin, args: string[], _options, callback: Callback) => {
      callback(null, args[0] === 'capabilities' ? CAPABILITIES : ADOPTED, '');
    });
    const stop = new AbortController();
    const reason = new Error('before capabilities');
    stop.abort(reason);
    await expect(adoptWorktree(input(stop.signal))).rejects.toBe(reason);
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(['return', 'throw'] as const)('capabilities 慢读后取消（%s），零 adopt exec', async (finish) => {
    let reply: Callback = () => undefined;
    execFile.mockImplementation((_bin, args: string[], _options, callback: Callback) => {
      if (args[0] === 'capabilities') reply = callback;
      else callback(null, ADOPTED, '');
    });
    const stop = new AbortController();
    const reason = new Error('during capabilities');
    const checked = expect(adoptWorktree(input(stop.signal))).rejects.toBe(reason);
    // execFile is invoked synchronously by the real adapter before its first await.
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1]).toEqual(['capabilities']);
    expect(execFile.mock.calls[0]?.[2].signal).toBe(stop.signal);
    stop.abort(reason);
    reply(finish === 'throw' ? new Error('late helper read error') : null, CAPABILITIES, '');
    await checked;
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('adopt 已发出后取消不报成功，也不声称撤回已发出的操作', async () => {
    let reply: Callback = () => undefined;
    let reachedAdopt: () => void = () => undefined;
    const sent = new Promise<void>((resolve) => {
      reachedAdopt = resolve;
    });
    execFile.mockImplementation((_bin, args: string[], _options, callback: Callback) => {
      if (args[0] === 'capabilities') callback(null, CAPABILITIES, '');
      else {
        reply = callback;
        reachedAdopt();
      }
    });
    const stop = new AbortController();
    const reason = new Error('after adopt sent');
    const checked = expect(adoptWorktree(input(stop.signal))).rejects.toBe(reason);
    await sent;
    stop.abort(reason);
    reply(null, ADOPTED, '');
    await checked;
    expect(execFile.mock.calls.map((call) => call[1][0])).toEqual(['capabilities', 'adopt']);
  });
});
