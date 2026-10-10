import { describe, expect, it } from 'vitest';
import {
  CARPOOL_HOST,
  ensureFranceSsh,
  franceSshLine,
  hasHost,
  mergeSshConfig,
  WG_HOST,
} from '../skills/commander/scripts/ensure-france-ssh.mjs';

describe('ensure-france-ssh', () => {
  it('空配置补两个 Host', () => {
    const r = mergeSshConfig('');
    expect(r.added).toEqual([WG_HOST, CARPOOL_HOST]);
    expect(hasHost(r.config, WG_HOST)).toBe(true);
    expect(hasHost(r.config, CARPOOL_HOST)).toBe(true);
    expect(r.config).toContain('ProxyJump myserver');
    expect(r.config).toContain('User fleet-agent-carpool');
    expect(r.config).toContain('IdentitiesOnly yes');
  });

  it('已有同名 Host 不覆盖', () => {
    const existing = `Host ${WG_HOST}\n  HostName keep-me\n`;
    const r = mergeSshConfig(existing);
    expect(r.skipped).toContain(WG_HOST);
    expect(r.added).toEqual([CARPOOL_HOST]);
    expect(r.config).toContain('HostName keep-me');
  });

  it('france-ssh 默认指 wg，prefer carpool 时换名', () => {
    expect(franceSshLine('wg')).toBe(`${WG_HOST}\n`);
    expect(franceSshLine('carpool')).toBe(`${CARPOOL_HOST}\n`);
  });

  it('ensure：缺文件时写入 config 与 france-ssh；第二遍不动', () => {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const writes: string[] = [];
    const home = '/tmp/ensure-fr-ssh-fake-home';
    const io = {
      home,
      prefer: 'carpool' as const,
      env: {},
      exists: (p: string) => files.has(p) || dirs.has(p),
      readText: (p: string) => {
        const t = files.get(p);
        if (t === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return t;
      },
      writeText: (p: string, text: string) => {
        writes.push(p);
        files.set(p, text);
      },
      mkdirp: (p: string) => {
        dirs.add(p);
      },
    };
    const first = ensureFranceSsh(io);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.added).toEqual([WG_HOST, CARPOOL_HOST]);
    expect(first.franceSsh).toBe('wrote');
    expect(first.preferHost).toBe(CARPOOL_HOST);
    expect(files.get(`${home}/.fleet-dao/france-ssh`)).toBe(`${CARPOOL_HOST}\n`);

    writes.length = 0;
    const second = ensureFranceSsh(io);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.added).toEqual([]);
    expect(second.skipped).toEqual([WG_HOST, CARPOOL_HOST]);
    expect(second.franceSsh).toBe('unchanged');
    expect(writes).toEqual([]);
  });

  it('--check 不写盘', () => {
    let wrote = false;
    const r = ensureFranceSsh({
      home: '/tmp/ensure-fr-ssh-check-home',
      checkOnly: true,
      exists: () => false,
      readText: () => '',
      writeText: () => {
        wrote = true;
      },
      mkdirp: () => {},
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checkOnly).toBe(true);
    expect(r.wouldAdd).toEqual([WG_HOST, CARPOOL_HOST]);
    expect(wrote).toBe(false);
  });
});
