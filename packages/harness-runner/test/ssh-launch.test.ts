import { describe, expect, it } from 'vitest';
import { remoteHostd, sshHostdLaunch } from '../src/host-hostd.ts';

describe('ssh hostd launch（#3928）', () => {
  it('是 ssh -T 别名 fleet2-hostd --stdio', () => {
    expect(sshHostdLaunch('desk')).toEqual(['ssh', '-T', 'desk', 'fleet2-hostd', '--stdio']);
    expect([...remoteHostd('desk').launch]).toEqual(['ssh', '-T', 'desk', 'fleet2-hostd', '--stdio']);
  });

  it('别名不能当 ssh 参数', () => {
    expect(() => sshHostdLaunch('-oProxyJump')).toThrow(/别名不合法/);
    expect(() => sshHostdLaunch('a b')).toThrow(/别名不合法/);
  });
});
