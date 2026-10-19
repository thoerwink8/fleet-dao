// #3282：真 Temporal 命令行的准备边界。全部隔离：假运输、临时目录，不连网络、不起真 temporal。
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { temporalPreflight } from '../src/local-vitest.ts';
import {
  ARCHIVE_SHA256,
  FIX_COMMAND,
  type InstallDeps,
  installCli,
  managedCliPath,
  type ProbeDeps,
  parsePin,
  probeCli,
  type RunResult,
  resolveCli,
  startWithDeadline,
} from '../src/temporal-cli.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PIN = { version: '1.9.1', sha256: 'a'.repeat(64) };
const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' });
const GOOD = ok('temporal version 1.9.1 (Server 1.32.0, UI 2.0)\n');

function fakeProbe(files: Record<string, RunResult | 'dir'>): ProbeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    kind: (p) => (p in files ? (files[p] === 'dir' ? 'dir' : 'file') : 'none'),
    run: (p) => {
      calls.push(p);
      return files[p] as RunResult;
    },
  };
}

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'temporal-cli-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('固定版本', () => {
  it('france.sh 的版本和校验和读得出，linux 校验和与 CI 同一份', () => {
    const pin = parsePin(readFileSync(join(ROOT, 'deploy/france.sh'), 'utf8'));
    expect(pin).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(typeof pin).toBe('object');
    if (typeof pin === 'string') return;
    expect(ARCHIVE_SHA256[pin.version]?.darwin_arm64).toMatch(/^[0-9a-f]{64}$/);
  });
  it('读不全就是明确的原因，不是默认值', () => {
    expect(parsePin('X=1')).toContain('TEMPORAL_CLI_VERSION');
    expect(parsePin('TEMPORAL_CLI_VERSION=1.9.1\nTEMPORAL_CLI_SHA256=zz')).toContain('TEMPORAL_CLI_SHA256');
  });
});

describe('probeCli：五类失败各自明确，都带修复命令', () => {
  it('正常', () => {
    expect(probeCli('/c/t', '1.9.1', fakeProbe({ '/c/t': GOOD }))).toMatchObject({ ok: true, path: '/c/t' });
  });
  it('缺失/坏路径', () => {
    const r = probeCli('/nope', '1.9.1', fakeProbe({}));
    expect(r).toMatchObject({ ok: false, stage: 'bad-path' });
    expect(!r.ok && r.message).toContain(FIX_COMMAND);
    expect(probeCli('/d', '1.9.1', fakeProbe({ '/d': 'dir' }))).toMatchObject({
      ok: false,
      stage: 'bad-path',
    });
    const spawnFail = {
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    };
    expect(probeCli('/x', '1.9.1', fakeProbe({ '/x': spawnFail }))).toMatchObject({
      ok: false,
      stage: 'bad-path',
    });
  });
  it('错版本', () => {
    const r = probeCli('/c/t', '1.9.1', fakeProbe({ '/c/t': ok('temporal version 1.8.0\n') }));
    expect(r).toMatchObject({ ok: false, stage: 'version' });
    expect(!r.ok && r.message).toContain('1.8.0');
    expect(probeCli('/c/t', '1.9.1', fakeProbe({ '/c/t': ok('garbage') }))).toMatchObject({
      stage: 'version',
    });
  });
  it('卡住', () => {
    const hung = {
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }),
    };
    const r = probeCli('/c/t', '1.9.1', fakeProbe({ '/c/t': hung }));
    expect(r).toMatchObject({ ok: false, stage: 'hung' });
    expect(!r.ok && r.message).toContain(FIX_COMMAND);
  });
  it('执行失败', () => {
    const r = probeCli('/c/t', '1.9.1', fakeProbe({ '/c/t': { status: 3, stdout: '', stderr: 'boom' } }));
    expect(r).toMatchObject({ ok: false, stage: 'exec-failed' });
  });
});

describe('resolveCli：不隐式下载', () => {
  const base = { version: '1.9.1', platform: 'darwin', home: '/h' };
  it('没给也没缓存：缺失并指向 pnpm temporal:cli', () => {
    const r = resolveCli({ ...base, env: {}, deps: fakeProbe({}) });
    expect(r).toMatchObject({ ok: false, stage: 'missing' });
    expect(!r.ok && r.message).toContain(FIX_COMMAND);
  });
  it('显式路径优先，坏了不回退到受管缓存', () => {
    const managed = managedCliPath('1.9.1', 'darwin', '/h');
    const probe = fakeProbe({ [managed]: GOOD });
    const r = resolveCli({ ...base, env: { FLEET_TEST_TEMPORAL_CLI: '/bad' }, deps: probe });
    expect(r).toMatchObject({ ok: false, stage: 'bad-path' });
    expect(probe.calls).toEqual([]);
  });
  it('受管缓存可用', () => {
    const managed = managedCliPath('1.9.1', 'darwin', '/h');
    expect(resolveCli({ ...base, env: {}, deps: fakeProbe({ [managed]: GOOD }) })).toMatchObject({
      ok: true,
      path: managed,
    });
  });
});

describe('正式入口 temporalPreflight', () => {
  function repoRoot(files: Record<string, string>): string {
    const root = tmp();
    mkdirSync(join(root, 'agents/test'), { recursive: true });
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    return root;
  }
  const FRANCE = `TEMPORAL_CLI_VERSION=1.9.1\nTEMPORAL_CLI_SHA256=${'b'.repeat(64)}\n`;
  const files = {
    'deploy/france.sh': FRANCE,
    'packages/engine/test/real.test.ts': `await create${'RealEnv'}();\n`,
    'packages/engine/test/plain.test.ts': "import { it } from 'vitest';\nit('x', () => {});\n",
  };
  const deps = (probe: ProbeDeps) => ({ home: '/h', probe });

  it('不用真服务端的选测不碰命令行', () => {
    const probe = fakeProbe({});
    const r = temporalPreflight(repoRoot(files), ['run', 'plain.test'], {}, 'darwin', deps(probe));
    expect(r).toMatchObject({ ok: true });
    expect(probe.calls).toEqual([]);
  });
  it('选到真服务端的文件：缺失明确失败', () => {
    const r = temporalPreflight(repoRoot(files), ['run', 'real.test'], {}, 'darwin', deps(fakeProbe({})));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain(FIX_COMMAND);
    expect(!r.ok && r.message).toContain('real.test.ts');
  });
  it('没带过滤的全跑也认得出', () => {
    const r = temporalPreflight(repoRoot(files), ['run'], {}, 'darwin', deps(fakeProbe({})));
    expect(r.ok).toBe(false);
  });
  it('核实通过后把路径写进子进程 env（显式准备路径传进正式入口）', () => {
    const managed = managedCliPath('1.9.1', 'darwin', '/h');
    const r = temporalPreflight(
      repoRoot(files),
      ['run'],
      { A: '1' },
      'darwin',
      deps(fakeProbe({ [managed]: GOOD })),
    );
    expect(r).toMatchObject({ ok: true, env: { A: '1', FLEET_TEST_TEMPORAL_CLI: managed } });
  });
  it('错版本明确失败', () => {
    const managed = managedCliPath('1.9.1', 'darwin', '/h');
    const r = temporalPreflight(
      repoRoot(files),
      ['run'],
      {},
      'darwin',
      deps(fakeProbe({ [managed]: ok('temporal version 1.0.0') })),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('版本不符');
  });
  it('读不到 france.sh 明确失败', () => {
    const { 'deploy/france.sh': _drop, ...rest } = files;
    const r = temporalPreflight(repoRoot(rest), ['run'], {}, 'darwin', deps(fakeProbe({})));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('france.sh');
  });
});

describe('startWithDeadline：迟到起来的服务端有人回收', () => {
  it('超时报启动阶段；迟到成功后被 dispose', async () => {
    const disposed: string[] = [];
    let release!: (v: string) => void;
    const late = new Promise<string>((r) => {
      release = r;
    });
    await expect(
      startWithDeadline(
        () => late,
        async (v) => void disposed.push(v),
        20,
      ),
    ).rejects.toThrow(/启动或连接/);
    expect(disposed).toEqual([]);
    release('env-1');
    await new Promise((r) => setTimeout(r, 5));
    expect(disposed).toEqual(['env-1']);
  });
  it('按时起来不 dispose，起失败带阶段', async () => {
    const disposed: string[] = [];
    await expect(
      startWithDeadline(
        async () => 'a',
        async (v) => void disposed.push(v),
        1000,
      ),
    ).resolves.toBe('a');
    await expect(
      startWithDeadline(
        async () => Promise.reject(new Error('port')),
        async () => {},
        1000,
      ),
    ).rejects.toThrow(/起服务端失败：port/);
    expect(disposed).toEqual([]);
  });
});

describe('installCli：固定版本、校验和、原子落盘', () => {
  const body = new Uint8Array([1, 2, 3]);
  const countingDownload = (tick: () => void) => async () => {
    tick();
    return body;
  };
  const sha = createHash('sha256').update(body).digest('hex');
  const dirFor = (home: string) => join(home, '.cache', 'fleet-temporal-cli', '1.9.1');
  function deps(over: Partial<InstallDeps> = {}, probe: ProbeDeps = fakeProbe({})): InstallDeps {
    let t = 0;
    return {
      download: async () => body,
      extract: (_a, dest) => {
        writeFileSync(join(dest, 'temporal'), 'bin');
        return { ok: true, message: '' };
      },
      probe,
      now: () => (t += 1),
      log: () => {},
      ...over,
    };
  }
  const probeAny: ProbeDeps = {
    kind: (p) => (existsSync(p) ? 'file' : 'none'),
    run: () => GOOD,
  };
  const input = (home: string) => ({
    pin: { version: '1.9.1', sha256: sha },
    platform: 'linux',
    arch: 'x64',
    home,
  });

  it('成功：原子落到受管路径，临时目录清干净', async () => {
    const home = tmp();
    const r = await installCli({ ...input(home), deps: deps({}, probeAny) });
    expect(r).toMatchObject({ ok: true, path: managedCliPath('1.9.1', 'linux', home) });
    expect(readdirSync(dirFor(home))).toEqual(['temporal']);
  });
  it('校验和不符：不安装、不重试、不留文件', async () => {
    const home = tmp();
    let n = 0;
    const r = await installCli({
      ...input(home),
      pin: { version: '1.9.1', sha256: 'c'.repeat(64) },
      deps: deps({ download: countingDownload(() => n++) }, probeAny),
    });
    expect(r.ok).toBe(false);
    expect(n).toBe(1);
    expect(readdirSync(dirFor(home))).toEqual([]);
  });
  it('下载有界重试，用完明确失败，不留 .installing', async () => {
    const home = tmp();
    let n = 0;
    const r = await installCli({
      ...input(home),
      attempts: 2,
      deps: deps({ download: async () => Promise.reject(new Error(`net${++n}`)) }, probeAny),
    });
    expect(n).toBe(2);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('net2');
    expect(readdirSync(dirFor(home))).toEqual([]);
  });
  it('整体期限用完不再下载', async () => {
    const home = tmp();
    let n = 0;
    const r = await installCli({
      ...input(home),
      totalMs: 0,
      deps: deps({ download: countingDownload(() => n++) }, probeAny),
    });
    expect(n).toBe(0);
    expect(r.ok).toBe(false);
  });
  it('解出来版本不对：不落盘', async () => {
    const home = tmp();
    const wrong: ProbeDeps = { kind: probeAny.kind, run: () => ok('temporal version 9.9.9') };
    const r = await installCli({ ...input(home), deps: deps({}, wrong) });
    expect(r).toMatchObject({ ok: false, stage: 'version' });
    expect(readdirSync(dirFor(home))).toEqual([]);
  });
  it('仓内没有该平台校验和：不下载', async () => {
    let n = 0;
    const r = await installCli({
      ...input(tmp()),
      platform: 'freebsd',
      deps: deps({ download: countingDownload(() => n++) }),
    });
    expect(r.ok).toBe(false);
    expect(n).toBe(0);
  });
});
