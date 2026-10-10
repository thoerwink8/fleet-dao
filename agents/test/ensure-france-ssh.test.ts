import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureFranceSsh } from '../skills/commander/scripts/ensure-france-ssh.mjs';

const FRAG = `Host fleet-fr-wg
  HostName 10.99.0.2
  User root
  ProxyJump myserver
  IdentityFile ~/.ssh/fleet_login
`;

describe('ensureFranceSsh（#1732）', () => {
  it('缺片段时写入；有 myserver 和钥匙才 ok', () => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-fr-ssh-'));
    const ssh = join(home, '.ssh');
    mkdirSync(ssh, { mode: 0o700 });
    writeFileSync(join(ssh, 'config'), 'Host myserver\n  HostName example\n', { mode: 0o600 });
    writeFileSync(join(ssh, 'fleet_login'), 'fake-key\n', { mode: 0o600 });

    const got = ensureFranceSsh({ home, fragmentText: FRAG });
    expect(got.wrote).toBe(true);
    expect(got.ok).toBe(true);
    expect(readFileSync(join(ssh, 'config'), 'utf8')).toContain('Host fleet-fr-wg');
    expect(readFileSync(join(ssh, 'config'), 'utf8')).toContain('BEGIN fleet-dao fleet-fr-wg');
  });

  it('--check 且缺钥匙：not ok、不写', () => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-fr-ssh-'));
    const ssh = join(home, '.ssh');
    mkdirSync(ssh, { mode: 0o700 });
    writeFileSync(join(ssh, 'config'), 'Host myserver\n', { mode: 0o600 });

    const before = readFileSync(join(ssh, 'config'), 'utf8');
    const got = ensureFranceSsh({ home, fragmentText: FRAG, checkOnly: true });
    expect(got.wrote).toBe(false);
    expect(got.ok).toBe(false);
    expect(got.missing.some((m) => m.includes('fleet_login'))).toBe(true);
    expect(readFileSync(join(ssh, 'config'), 'utf8')).toBe(before);
  });
});
