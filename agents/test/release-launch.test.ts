// 发版车第 4 步在法国上跑的 release-launch.sh（#1995）：起发布服务、或接着看已有的那个。
// 真的 bash 跑脚本，systemctl、systemd-run、flock 换成放在 PATH 最前面的假命令（不碰任何真服务）；发布目录用临时目录。
// 钉住的是幂等：同一个令牌重发不起第二个；服务在跑就接着看；跑完回退出码；没了又没退出码不重起；别的发布占着锁不起。
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../skills/commander/scripts/release-launch.sh', import.meta.url));
const SHA = 'ab12cd34'.repeat(5);
const UNIT = `fleet-train-release-${SHA.slice(0, 12)}`;
const BOOT = '#!/usr/bin/env bash\necho 假的 release-boot\n';
const B64 = Buffer.from(BOOT, 'utf8').toString('base64');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world() {
  const root = mkdtempSync(join(tmpdir(), 'release-launch-'));
  dirs.push(root);
  const bin = join(root, 'bin');
  const fake = join(root, 'fake');
  const releases = join(root, 'releases');
  mkdirSync(bin);
  mkdirSync(fake);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    'systemctl',
    `if [[ $1 == is-active ]]; then cat "${fake.replace(/\\/g, '/')}/state-$2" 2>/dev/null || echo inactive; fi`,
  );
  stub(
    'systemd-run',
    `f="${fake.replace(/\\/g, '/')}"; for a in "$@"; do case $a in --unit=*) u=\${a#--unit=};; esac; done
echo "$@" >>"$f/run-$u"; if [[ -n \${FAKE_RUN_FAIL:-} ]]; then exit 1; fi; echo active >"$f/state-$u"`,
  );
  stub('flock', `exit \${FAKE_LOCK_BUSY:-0}`);
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        FLEET_RELEASES_DIR: releases,
        ...env,
      },
    });
    const head = String(r.stdout).split('\n---')[0] ?? '';
    const kv = Object.fromEntries(
      head
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    ) as Record<string, string>;
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr), kv };
  };
  const runs = () => {
    const f = join(fake, `run-${UNIT}`);
    return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').length : 0;
  };
  const setActive = (v: 'active' | 'inactive') => writeFileSync(join(fake, `state-${UNIT}`), `${v}\n`);
  const log = join(releases, '.train-launch', `${SHA.slice(0, 12)}.log`);
  return { run, runs, setActive, log, releases };
}

describe('release-launch.sh：幂等地起发布服务、看现状', () => {
  it('第一次：起服务（systemd-run 一次），回 started；送来的 release-boot 原样落盘', () => {
    const w = world();
    const r = w.run([SHA, 'tok1', B64]);
    expect(r.status).toBe(0);
    expect(r.kv.state).toBe('started');
    expect(r.kv.exit).toBe('none');
    expect(w.runs()).toBe(1);
    expect(readFileSync(join(w.releases, '.train-launch', `${SHA.slice(0, 12)}.boot.sh`), 'utf8')).toBe(BOOT);
  });

  it('服务在跑：同一个令牌或新令牌都回 attached，不起第二个、不报锁冲突', () => {
    const w = world();
    w.run([SHA, 'tok1', B64]);
    expect(w.run([SHA, 'tok1', B64]).kv.state).toBe('attached');
    expect(w.run([SHA, 'tok2', B64], { FAKE_LOCK_BUSY: '1' }).kv.state).toBe('attached'); // 锁被它自己占着也一样
    expect(w.runs()).toBe(1);
  });

  it('跑完（服务没了、日志末行有退出码）：同一个令牌回 finished 和退出码，不重起', () => {
    const w = world();
    w.run([SHA, 'tok1', B64]);
    w.setActive('inactive');
    writeFileSync(w.log, '发布日志\nfleet-dao-release-exit=0\n');
    const r = w.run([SHA, 'tok1', B64]);
    expect(r.kv.state).toBe('finished');
    expect(r.kv.exit).toBe('0');
    expect(r.stdout).toContain('发布日志');
    expect(w.runs()).toBe(1);
    writeFileSync(w.log, 'x\nfleet-dao-release-exit=1\n');
    expect(w.run([SHA, 'tok1', B64]).kv.exit).toBe('1');
  });

  it('【故意造出的失败】本趟起过、服务没了、日志里没有退出码：回 lost，不重起（重起会盖掉现场）', () => {
    const w = world();
    w.run([SHA, 'tok1', B64]);
    w.setActive('inactive');
    writeFileSync(w.log, '半截日志\n');
    const r = w.run([SHA, 'tok1', B64]);
    expect(r.kv.state).toBe('lost');
    expect(r.kv.exit).toBe('none');
    expect(w.runs()).toBe(1);
  });

  it('新的一趟（新令牌）遇到上一趟留下的结果：重新起，日志清掉重来', () => {
    const w = world();
    w.run([SHA, 'tok1', B64]);
    w.setActive('inactive');
    writeFileSync(w.log, 'fleet-dao-release-exit=1\n');
    const r = w.run([SHA, 'tok2', B64]);
    expect(r.kv.state).toBe('started');
    expect(r.kv.exit).toBe('none');
    expect(w.runs()).toBe(2);
  });

  it('【故意造出的失败】别的发布占着锁、这个提交没有服务在跑：回 busy，不起', () => {
    const w = world();
    const r = w.run([SHA, 'tok1', B64], { FAKE_LOCK_BUSY: '1' });
    expect(r.status).toBe(0);
    expect(r.kv.state).toBe('busy');
    expect(w.runs()).toBe(0);
  });

  it('【故意造出的失败】systemd-run 起不来：退出码 1、不留令牌（下一次能重试）', () => {
    const w = world();
    const r = w.run([SHA, 'tok1', B64], { FAKE_RUN_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('systemd-run');
    expect(existsSync(join(w.releases, '.train-launch', `${SHA.slice(0, 12)}.token`))).toBe(false);
  });

  it('【故意造出的失败】提交号、令牌认不出：拒（退出码 64），什么都没起', () => {
    const w = world();
    expect(w.run(['不是提交', 'tok1', B64]).status).toBe(64);
    expect(w.run([SHA, 'a b;rm', B64]).status).toBe(64);
    expect(w.run([SHA, 'tok1', '']).status).toBe(64);
    expect(w.runs()).toBe(0);
  });
});
