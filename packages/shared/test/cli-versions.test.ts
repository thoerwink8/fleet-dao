// 命令行工具版本：读不到记「读不到」、落后现算、两个用户分开列。
// 库里只存读数。这一份不写「落后」，发布源没给版本列表时也不拿单元素列表冒充。
import { describe, expect, it } from 'vitest';
import {
  attachCliUpgrade,
  buildCliToolsResponse,
  cliToolStatus,
  compareVersions,
  countBehind,
  matchReclaudeArtifact,
  parseCursorChangelog,
  parseCursorInstallScript,
  parseInstalledOutput,
  parseMirasimChangelog,
  parseMirasimLatest,
  parseNpmGlobal,
  parseNpmRegistry,
  parseReclaudeStable,
  parseVersion,
  reclaudeOlderTags,
  resolveCursorRelease,
} from '../src/cli-versions.ts';
import { CliToolsResponseSchema } from '../src/web-api/cli-versions.ts';

function version(raw: string) {
  const parsed = parseVersion(raw);
  if (!parsed) throw new Error(`认不出的版本：${raw}`);
  return parsed;
}

const at = '2026-10-12T14:00:00.000Z';

describe('reclaude 只读安装摘要与官方 artifact', () => {
  // 2026-10-23 现有两份 Linux 二进制与官方 stable.json 实测匹配；不是合成 CLI 输出。
  const sha256 = '0c769d6b70da513cef6860e4788e97183e35782ef8d9189be453fe3d551c95fa';
  const probe = { source: 'reclaude-binary-sha256', platform: 'linux-amd64', sha256 };
  const stable = { version: 'v1.5.0', binaries: { 'linux-amd64': { sha256 } } };
  it('匹配具体平台的文件摘要才认版本，仍不接受任何猜测的 CLI stdout', () => {
    expect(matchReclaudeArtifact(JSON.stringify(probe), JSON.stringify(stable))).toEqual({
      version: '1.5.0',
    });
    expect(parseInstalledOutput('reclaude', JSON.stringify(probe))).toBeNull();
  });
  it.each([
    [{ ...probe, sha256: '1'.repeat(64) }, stable],
    [{ ...probe, platform: 'linux-arm64' }, stable],
    [{ ...probe, source: 'reclaude --version' }, stable],
    [{ ...probe, sha256: 'bad' }, stable],
    [probe, { version: '1.5.0' }],
    [probe, { ...stable, binaries: { 'linux-amd64': { sha256: '' } } }],
    [probe, { ...stable, version: 'garbled' }],
    [null, stable],
  ])('摘要/平台/来源/清单无效：%j，不能用 latest 冒充在用', (installed, manifest) => {
    expect(matchReclaudeArtifact(JSON.stringify(installed), JSON.stringify(manifest))).toHaveProperty(
      'error',
    );
  });
  it('落后一版：对上官方旧版清单就认旧版本；对不上仍带 mismatch 报摘要不符', () => {
    const newer = { version: 'v1.5.1', binaries: { 'linux-amd64': { sha256: '4'.repeat(64) } } };
    expect(matchReclaudeArtifact(JSON.stringify(probe), JSON.stringify(newer))).toEqual({
      error: '来源不明：reclaude 在用二进制与官方 linux-amd64 artifact 摘要不符',
      mismatch: true,
    });
    expect(
      matchReclaudeArtifact(JSON.stringify(probe), JSON.stringify(newer), ['<html>', JSON.stringify(stable)]),
    ).toEqual({ version: '1.5.0' });
    expect(
      matchReclaudeArtifact(JSON.stringify(probe), JSON.stringify(newer), [
        JSON.stringify({ ...stable, binaries: { 'linux-amd64': { sha256: '5'.repeat(64) } } }),
      ]),
    ).toHaveProperty('mismatch', true);
  });
  it('往回数的旧版标签只在同一小版本内', () => {
    expect(reclaudeOlderTags('1.5.3')).toEqual(['v1.5.2', 'v1.5.1', 'v1.5.0']);
    expect(reclaudeOlderTags('v1.5.9', 2)).toEqual(['v1.5.8', 'v1.5.7']);
    expect(reclaudeOlderTags('1.5.0')).toEqual([]);
    expect(reclaudeOlderTags('garbled')).toEqual([]);
  });
  it('旧帮手 Claude 输出或损坏清单都明确失败', () => {
    expect(matchReclaudeArtifact('2.1.308 (Claude Code)', JSON.stringify(stable))).toHaveProperty('error');
    expect(matchReclaudeArtifact(JSON.stringify(probe), '<html>failure</html>')).toHaveProperty('error');
  });
});

describe('【故意造出的失败】读不到记「读不到」，不写成 0 或 ok', () => {
  it('探测失败：状态是读不到，在用版本不拿 0、ok 或空白顶', () => {
    const status = cliToolStatus({
      installedVersion: null,
      installedError: 'claude：退出码 127（找不到命令）',
      latestVersion: '2.1.296',
      latestError: null,
      releaseVersions: ['2.1.282', '2.1.296'],
    });
    expect(status).toEqual({ kind: 'unread', reason: 'claude：退出码 127（找不到命令）' });
    const view = buildCliToolsResponse(
      [
        {
          scope: 'user',
          owner: 'fleet-agent-carpool',
          tool: 'claude',
          installedVersion: null,
          installedError: 'claude：退出码 127（找不到命令）',
          latestVersion: '2.1.296',
          latestError: null,
          releaseVersions: ['2.1.282', '2.1.296'],
          checkedAt: at,
        },
      ],
      at,
    );
    expect(view.state).toBe('ok');
    if (view.state !== 'ok') return;
    const row = view.groups[0]?.rows.find((r) => r.tool === 'claude');
    expect(row?.installed).toEqual({ state: 'unread', why: 'claude：退出码 127（找不到命令）' });
    expect(row?.status).toEqual({
      kind: 'unread',
      reason: 'claude：退出码 127（找不到命令）',
      label: '读不到',
    });
    expect(JSON.stringify(row)).not.toMatch(/"version":"0"/);
    expect(JSON.stringify(row)).not.toMatch(/"version":"ok"/);
    expect(row?.latest).toEqual({ state: 'ok', version: '2.1.296' });
  });

  it('从没读过：写没查成和「还没读过」，不说读不到，也不留空', () => {
    const view = buildCliToolsResponse([], at);
    expect(view.state).toBe('ok');
    if (view.state !== 'ok') return;
    const row = view.groups[0]?.rows[0];
    expect(row?.status).toEqual({ kind: 'unreadable', reason: '还没读过', label: '没查成' });
    expect(row?.installed).toEqual({ state: 'unreadable', why: '还没读过' });
    expect(row?.latest).toEqual({ state: 'unreadable', why: '还没读过' });
    expect(row?.checkedAt).toBeNull();
  });

  it('官方最新没查成：两列都有话，状态是没查成，不当成最新', () => {
    const status = cliToolStatus({
      installedVersion: '1.0.41',
      installedError: null,
      latestVersion: null,
      latestError: 'npm 注册表没有 latest 渠道标签',
      releaseVersions: null,
    });
    expect(status).toEqual({ kind: 'unreadable', reason: 'npm 注册表没有 latest 渠道标签' });
  });
});

describe('版本比较：落后几个现算', () => {
  it('正式版按 semver，预发布小于正式版，比 latest 新的和预发布都不计入落后个数', () => {
    const installed = parseVersion('1.0.41');
    const latest = parseVersion('1.0.50');
    expect(installed).not.toBeNull();
    expect(latest).not.toBeNull();
    if (!installed || !latest) return;
    expect(compareVersions(installed, latest)).toBe(-1);
    expect(compareVersions(version('1.0.50-alpha.1'), version('1.0.50'))).toBe(-1);
    const versions = ['1.0.41', '1.0.42', '1.0.50', '1.0.51', '1.0.52-alpha.1', '1.0.49-rc.1'];
    expect(countBehind(installed, latest, versions)).toBe(2);
    expect(
      cliToolStatus({
        installedVersion: '1.0.41',
        installedError: null,
        latestVersion: '1.0.50',
        latestError: null,
        releaseVersions: versions,
      }),
    ).toEqual({ kind: 'behind', count: 2 });
  });

  it('一样就是最新；在用比发布源最新还新则没查成，不当成最新', () => {
    expect(
      cliToolStatus({
        installedVersion: '2.1.296',
        installedError: null,
        latestVersion: '2.1.296',
        latestError: null,
        releaseVersions: ['2.1.296'],
      }),
    ).toEqual({ kind: 'current' });
    expect(
      cliToolStatus({
        installedVersion: '2.1.300',
        installedError: null,
        latestVersion: '2.1.296',
        latestError: null,
        releaseVersions: ['2.1.296'],
      }),
    ).toEqual({ kind: 'unreadable', reason: '在用版本比发布源上的最新还新' });
  });

  it('日期版只比日期、忽略 hash；同一天不同 hash 当同一版', () => {
    expect(compareVersions(version('2026.09.23-86fc751'), version('2026.10.08'))).toBe(-1);
    expect(compareVersions(version('2026.10.01-aaaa'), version('2026.10.01-bbbb'))).toBe(0);
    expect(
      cliToolStatus({
        installedVersion: '2026.09.23-86fc751',
        installedError: null,
        latestVersion: '2026.10.08',
        latestError: null,
        releaseVersions: ['2026.09.23', '2026.10.01', '2026.10.01-deadbeef', '2026.10.08'],
      }),
    ).toEqual({ kind: 'behind', count: 2 });
    expect(
      cliToolStatus({
        installedVersion: '2026.10.01-aaaa',
        installedError: null,
        latestVersion: '2026.10.01-bbbb',
        latestError: null,
        releaseVersions: ['2026.10.01'],
      }),
    ).toEqual({ kind: 'current' });
  });

  it('发布源只给最新、没有列表：相等才是最新，更旧则数不出几个，不当成落后 1 个', () => {
    expect(parseReclaudeStable('{"version":"v1.4.1"}')).toEqual({ latest: '1.4.1', versions: null });
    expect(
      cliToolStatus({
        installedVersion: '1.4.1',
        installedError: null,
        latestVersion: '1.4.1',
        latestError: null,
        releaseVersions: null,
      }),
    ).toEqual({ kind: 'current' });
    expect(
      cliToolStatus({
        installedVersion: '1.3.0',
        installedError: null,
        latestVersion: '1.4.1',
        latestError: null,
        releaseVersions: null,
      }),
    ).toEqual({
      kind: 'behind-uncounted',
      reason: '发布源只给了最新版，没有版本列表，数不出落后几个',
    });
  });
});

describe('两个用户分开列，全局 npm 不按用户重复', () => {
  it('同一工具两人各一行，版本各看各的；npm 只有一组', () => {
    const view = buildCliToolsResponse(
      [
        {
          scope: 'user',
          owner: 'fleet-agent-carpool',
          tool: 'grok',
          installedVersion: '1.0.41',
          installedError: null,
          latestVersion: '1.0.50',
          latestError: null,
          releaseVersions: ['1.0.41', '1.0.50'],
          checkedAt: at,
        },
        {
          scope: 'user',
          owner: 'pilot',
          tool: 'codex',
          installedVersion: '1.0.50',
          installedError: null,
          latestVersion: '1.0.50',
          latestError: null,
          releaseVersions: ['1.0.41', '1.0.50'],
          checkedAt: at,
        },
        {
          scope: 'npm',
          owner: '',
          tool: 'pi',
          installedVersion: null,
          installedError: '全局 npm 里没有 @earendil-works/pi-coding-agent',
          latestVersion: '0.90.0',
          latestError: null,
          releaseVersions: ['0.87.1', '0.90.0'],
          checkedAt: at,
        },
      ],
      at,
    );
    expect(view.state).toBe('ok');
    if (view.state !== 'ok') return;
    expect(view.groups.map((g) => g.title)).toEqual(['fleet-agent-carpool', 'pilot', '全局 npm']);
    const car = view.groups[0]?.rows.find((r) => r.tool === 'grok');
    const pilot = view.groups[1]?.rows.find((r) => r.tool === 'codex');
    expect(car?.status.kind).toBe('behind');
    expect(pilot?.status).toEqual({ kind: 'current', label: '最新' });
    expect(view.groups[0]?.rows.map((r) => r.tool)).toEqual([
      'claude',
      'codex',
      'grok',
      'cursor-agent',
      'reclaude',
      'mirasim-server',
    ]);
    // pilot 上只装了这三样，别的不列（列了只会永远「读不到」）
    expect(view.groups[1]?.rows.map((r) => r.tool)).toEqual(['claude', 'codex', 'reclaude']);
    expect(view.groups[2]?.rows.map((r) => r.tool)).toEqual(['kimi-code', 'dsh', 'pi']);
    expect(view.groups[2]?.rows.find((r) => r.tool === 'pi')?.status.label).toBe('读不到');
    expect(CliToolsResponseSchema.safeParse(view).success).toBe(true);
  });
});

describe('升级结果挂到版本行上', () => {
  it('升完的版本和上次升级时间挂到对应的人；没写渠道的也挂上跳过；全局 npm 不挂', () => {
    const view = attachCliUpgrade(buildCliToolsResponse([], at), {
      state: 'ok',
      reason: null,
      tools: [
        {
          id: 'claude-code',
          version: '2.1.287',
          upgradedAt: '2026-10-12T12:00:01.000Z',
          outcome: 'ok',
          detail: '升到 2.1.287',
        },
        {
          id: 'grok',
          version: '1.0.50',
          upgradedAt: '2026-10-12T12:00:02.000Z',
          outcome: 'ok',
          detail: '升到 1.0.50',
        },
        {
          id: 'cursor-agent',
          version: '2026.10.01',
          upgradedAt: null,
          outcome: 'skipped',
          detail: '没写渠道，不升',
        },
      ],
    });
    const claude = (owner: string) =>
      view.groups.find((g) => g.owner === owner)?.rows.find((r) => r.tool === 'claude');
    expect(claude('fleet-agent-carpool')?.upgrade).toMatchObject({
      version: '2.1.287',
      upgradedAt: '2026-10-12T12:00:01.000Z',
      outcome: 'ok',
    });
    expect(claude('pilot')?.upgrade?.version).toBe('2.1.287');
    const grok = (owner: string) =>
      view.groups.find((g) => g.owner === owner)?.rows.find((r) => r.tool === 'grok');
    expect(grok('fleet-agent-carpool')?.upgrade?.version).toBe('1.0.50');
    expect(grok('pilot')).toBeUndefined();
    expect(
      view.groups.find((g) => g.owner === 'fleet-agent-carpool')?.rows.find((r) => r.tool === 'cursor-agent')
        ?.upgrade?.outcome,
    ).toBe('skipped');
    expect(view.groups.find((g) => g.scope === 'npm')?.rows.every((r) => r.upgrade === null)).toBe(true);
    expect(view.upgradeNote).toBeNull();
    expect(CliToolsResponseSchema.safeParse(view).success).toBe(true);
  });

  it('【故意造出的失败】升级结果认不出：版本行还在，写明没查成，不假装还没升过', () => {
    const view = attachCliUpgrade(buildCliToolsResponse([], at), {
      state: 'unreadable',
      reason: '升级结果不是 JSON',
      tools: [],
    });
    expect(view.upgradeNote).toBe('升级结果不是 JSON');
    expect(view.groups[0]?.rows.every((r) => r.upgrade === null)).toBe(true);
    expect(view.groups[0]?.rows.length).toBeGreaterThan(0);
  });
});

describe('发布源解析：认不出就写原因', () => {
  it('npm 没有 latest 渠道标签', () => {
    expect(parseNpmRegistry('{"dist-tags":{},"versions":{"1.0.0":{}}}')).toEqual({
      error: 'npm 注册表没有 latest 渠道标签',
    });
    expect(
      parseNpmRegistry(
        '{"dist-tags":{"latest":"1.0.50"},"versions":{"1.0.41":{},"1.0.50":{},"1.0.52-alpha.1":{}}}',
      ),
    ).toEqual({
      latest: '1.0.50',
      versions: ['1.0.41', '1.0.50', '1.0.52-alpha.1'],
    });
  });

  it('全局 npm 里没有这个包，不当成 0', () => {
    expect(
      parseNpmGlobal(
        '{"dependencies":{"@moonshot-ai/kimi-code":{"version":"2.1.1"}}}',
        '@earendil-works/pi-coding-agent',
      ),
    ).toEqual({
      error: '全局 npm 里没有 @earendil-works/pi-coding-agent',
    });
  });

  it('在用输出版本号', () => {
    expect(parseInstalledOutput('claude', '2.1.282 (Claude Code)\n')).toBe('2.1.282');
    expect(parseInstalledOutput('codex', 'codex-cli 0.156.1\n')).toBe('0.156.1');
    expect(parseInstalledOutput('grok', 'grok 1.0.41 (abc123)\n')).toBe('1.0.41');
    expect(parseInstalledOutput('grok', 'grok 1.0.41\n')).toBe('1.0.41');
    expect(parseInstalledOutput('grok', 'grok 1.0.62 (1474f9cbdd91) [stable]\n')).toBe('1.0.62');
    expect(parseInstalledOutput('grok', 'grok 1.0.63 (1474f9cbdd91) [beta]\n')).toBe('1.0.63');
    expect(parseInstalledOutput('grok', 'grok 1.0.64 stable\n')).toBeNull();
    expect(parseInstalledOutput('grok', 'not grok\n')).toBeNull();
    expect(
      parseInstalledOutput(
        'cursor-agent',
        '/home/u/.local/share/cursor-agent/versions/2026.09.23-86fc751/cursor-agent\n2026.09.23-86fc751\n',
      ),
    ).toBe('2026.09.23-86fc751');
    expect(parseInstalledOutput('mirasim-server', '0.0.355\n')).toBe('0.0.355');
  });

  it('reclaude 没有经证实的自身版本输出：Claude Code 的版本、裸数字、未证实的「reclaude x.y.z」、没有版本都不当成它的', () => {
    expect(parseInstalledOutput('reclaude', 'reclaude 1.4.0\n')).toBeNull();
    expect(parseInstalledOutput('reclaude', 'Syncing config...\nreclaude 1.5.0\n')).toBeNull();
    expect(
      parseInstalledOutput('reclaude', 'Syncing config...\nreclaude 1.5.0\n2.1.308 (Claude Code)\n'),
    ).toBeNull();
    expect(parseInstalledOutput('reclaude', '2.1.308 (Claude Code)\n')).toBeNull();
    expect(parseInstalledOutput('reclaude', 'Syncing config...\n2.1.308 (Claude Code)\n')).toBeNull();
    expect(parseInstalledOutput('reclaude', '1.5.0\n')).toBeNull();
    expect(parseInstalledOutput('reclaude', 'reclaude 1.5.0 (Claude Code)\n')).toBeNull();
    expect(parseInstalledOutput('reclaude', 'Syncing config...\n')).toBeNull();
    expect(parseInstalledOutput('reclaude', '')).toBeNull();
    expect(parseInstalledOutput('claude', '2.1.308 (Claude Code)\n')).toBe('2.1.308');
  });

  it('Cursor 更新日志优先，失败再退回安装脚本；都没有就两个原因', () => {
    const md = '## v2026.10.08\n\n## v2026.10.01\n';
    expect(parseCursorChangelog(md)).toEqual({
      latest: '2026.10.08',
      versions: ['2026.10.08', '2026.10.01'],
    });
    expect(parseCursorChangelog('没有标题')).toEqual({ error: 'Cursor 更新日志里没认出版本号' });
    expect(parseCursorChangelog('<span>v2026.10.08</span><a>v2026.09.28</a>')).toEqual({
      latest: '2026.10.08',
      versions: ['2026.10.08', '2026.09.28'],
    });
    expect(
      parseCursorInstallScript('DOWNLOAD_URL=https://downloads.cursor.com/lab/2026.10.01-e373342/x'),
    ).toEqual({
      latest: '2026.10.01-e373342',
      versions: null,
    });
    const preferred = resolveCursorRelease({ ok: true, body: md }, { ok: false, error: '没抓到' });
    if ('error' in preferred) throw new Error(preferred.error);
    expect(preferred.latest).toBe('2026.10.08');
    const fallback = resolveCursorRelease(
      { ok: false, error: 'Cursor 更新日志里没认出版本号' },
      { ok: true, body: 'versions/2026.10.01-e373342' },
    );
    expect(fallback).toEqual({ latest: '2026.10.01-e373342', versions: null });
    expect(resolveCursorRelease({ ok: false, error: '日志失败' }, { ok: false, error: '脚本失败' })).toEqual({
      error: '更新日志：日志失败；安装脚本：脚本失败',
    });
  });

  it('Mirasim 更新日志零匹配就没查成，不编落后个数', () => {
    expect(parseMirasimChangelog('<p>没有号</p>')).toEqual({ error: '更新日志里没认出版本号' });
    expect(
      parseMirasimChangelog('<h2>Version 0.0.479</h2><p>版本 0.0.465</p><p>Version 0.0.479</p>'),
    ).toEqual({
      latest: '0.0.479',
      versions: ['0.0.479', '0.0.465'],
    });
    expect(parseMirasimChangelog('<div>Version<span>0.0.479</span></div>')).toEqual({
      latest: '0.0.479',
      versions: ['0.0.479'],
    });
  });

  it('Mirasim latest.json 用顶层 version，不取 stable，也不编版本列表', () => {
    expect(parseMirasimLatest('{"version":"0.0.481","stable":{"version":"0.0.479"}}')).toEqual({
      latest: '0.0.481',
      versions: null,
    });
    expect(parseMirasimLatest('{"stable":{"version":"0.0.479"}}')).toEqual({
      error: 'Mirasim 的 latest.json 没有 version',
    });
    expect(parseMirasimLatest('不是 json')).toEqual({ error: 'Mirasim 的 latest.json 不是 JSON' });
  });
});
