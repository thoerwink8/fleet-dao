// 各家配置里的开关（src/tool-config.ts）：~/.grok/config.toml 的目录信任、反问选择题。假家目录，不碰真机器。
import { existsSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { findBin, installedAgents } from '../src/detect.ts';
import { AGENTS } from '../src/targets.ts';
import { applyToolConfig, checkToolConfig, locate, setKey } from '../src/tool-config.ts';
import { cleanup, ctxFor, fakeBin, get, kinds, PLATFORM, put, tempDir } from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-09-28T18:00:00Z');
const FILE = '~/.grok/config.toml';
const TRUST = `${FILE}#folder_trust.enabled`;
const ASK = `${FILE}#features.ask_user_question`;

function machine(installed = true) {
  const home = tempDir('home');
  const ctx = ctxFor(home, installed ? ['grok'] : ['claude']);
  return {
    home,
    check: () => checkToolConfig(ctx),
    apply: () => applyToolConfig(ctx, new Backups(home, PLATFORM, NOW)),
    read: () => get(home, '.grok/config.toml'),
    write: (text: string) => put(home, '.grok/config.toml', text),
  };
}

describe('找 [table] 下的 key', () => {
  it('普通表头、行尾注释、表名带空格和点号的子表都认得', () => {
    const text =
      '[ui]\npermission_mode = "always-approve"\n\n[ features ]\nask_user_question = true # 旧的\n[features.x]\na = 1\n';
    expect(locate(text, 'features', 'ask_user_question')).toEqual({ kind: 'has', line: 4, value: 'true' });
    expect(locate(text, 'folder_trust', 'enabled')).toEqual({ kind: 'no-table' });
    expect(locate('[folder_trust]\n', 'folder_trust', 'enabled')).toEqual({ kind: 'no-key', header: 0 });
  });

  it('[[数组表]] 里同名的 key 不算，多行数组的续行不当成 key', () => {
    const text = '[[features]]\nask_user_question = true\n[marketplace]\nsources = [\n  "a",\n]\n';
    expect(locate(text, 'features', 'ask_user_question')).toEqual({ kind: 'no-table' });
  });

  it('【故意造出的失败】读不懂的几种形状：报原因，不当成没有', () => {
    const cases: [string, RegExp][] = [
      ['a = """\n[features]\n"""\n', /多行字符串/],
      ['[features]\n[features]\n', /出现了 2 次/],
      ['[features]\nask_user_question = true\nask_user_question = false\n', /写了 2 遍/],
      ['features.ask_user_question = true\n', /点号或内联表/],
      ['features = { ask_user_question = true }\n', /点号或内联表/],
      ['["features"]\n', /表头认不出/],
    ];
    for (const [text, why] of cases) {
      const r = locate(text, 'features', 'ask_user_question');
      expect(r.kind, text).toBe('unreadable');
      if (r.kind === 'unreadable') expect(r.why).toMatch(why);
      expect(setKey(text, { table: 'features', key: 'ask_user_question', value: 'false', why: 'x' }).ok).toBe(
        false,
      );
    }
  });
});

describe('查和写', () => {
  it('没装 grok：跳过，不建文件', () => {
    const m = machine(false);
    expect(kinds(m.check(), FILE)).toEqual(['skip']);
    expect(kinds(m.apply(), FILE)).toEqual(['skip']);
    expect(existsSync(join(m.home, '.grok'))).toBe(false);
  });

  it('没有配置文件：查报两项缺失；写新建，只有这两项；再查一致、再写零改动', () => {
    const m = machine();
    expect([...kinds(m.check(), TRUST), ...kinds(m.check(), ASK)]).toEqual(['missing', 'missing']);
    const lines = m.apply();
    expect([...kinds(lines, TRUST), ...kinds(lines, ASK)]).toEqual(['changed', 'changed']);
    const text = m.read();
    expect(locate(text, 'folder_trust', 'enabled')).toMatchObject({ kind: 'has', value: 'false' });
    expect(locate(text, 'features', 'ask_user_question')).toMatchObject({ kind: 'has', value: 'false' });
    expect(text.startsWith('[folder_trust]')).toBe(true);
    expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true);
    expect(m.check().map((l) => l.kind)).toEqual(['ok', 'ok']);
    expect(m.apply().filter((l) => l.kind === 'changed')).toEqual([]);
  });

  it('已有配置：别的内容（注释、顺序、别的表、CRLF）一个字不动，只改或补这两项；改之前留备份', () => {
    const m = machine();
    const before =
      '# 我的配置\r\n[ui]\r\npermission_mode = "always-approve"\r\n\r\n[features]\r\n  ask_user_question = true  # 原来开着\r\nweb_fetch = true\r\n';
    m.write(before);
    expect(kinds(m.check(), ASK)).toEqual(['drift']);
    expect(kinds(m.check(), TRUST)).toEqual(['missing']);
    m.apply();
    const after = m.read();
    expect(after).toContain('  ask_user_question = false\r\n');
    expect(after).not.toContain('ask_user_question = true');
    expect(
      after.startsWith('# 我的配置\r\n[ui]\r\npermission_mode = "always-approve"\r\n\r\n[features]\r\n'),
    ).toBe(true);
    expect(after).toContain('web_fetch = true\r\n');
    expect(after).toMatch(
      /\r\n\r\n\[folder_trust\]\r\n# fleet-dao 同步脚本管[^\r\n]*\r\nenabled = false\r\n$/,
    );
    expect(after.replaceAll('\r\n', '')).toBe(after.replaceAll('\n', '').replaceAll('\r', ''));
    const backupRoot = join(m.home, '.fleet-dao', 'backups');
    const [stamp] = readdirSync(backupRoot);
    expect(get(join(backupRoot, stamp as string), '.grok/config.toml')).toBe(before);
  });

  it('有表没这一项：插在表头下面', () => {
    const m = machine();
    m.write('[folder_trust]\n[features]\nask_user_question = false\n');
    m.apply();
    expect(m.read()).toMatch(
      /^\[folder_trust\]\n# fleet-dao[^\n]*\nenabled = false\n\[features\]\nask_user_question = false\n$/,
    );
  });

  it('【故意造出的失败】一项读不懂：整份不写，两项都报没做成，查报没查成', () => {
    const m = machine();
    const before = '[features]\nask_user_question = true\n[features]\n';
    m.write(before);
    expect(kinds(m.check(), ASK)).toEqual(['unknown']);
    const lines = m.apply();
    expect(kinds(lines, ASK)).toEqual(['failed']);
    expect(kinds(lines, TRUST)).toEqual(['failed']);
    expect(m.read()).toBe(before);
  });

  it.skipIf(PLATFORM === 'win32')('【故意造出的失败】配置文件是个链接：不跟过去改，报出来', () => {
    const m = machine();
    const real = put(tempDir('dotfiles'), 'config.toml', '[ui]\n');
    put(m.home, '.grok/.keep', '');
    symlinkSync(real, join(m.home, '.grok', 'config.toml'));
    expect(kinds(m.check(), FILE)).toEqual(['drift']);
    expect(kinds(m.apply(), FILE)).toEqual(['failed']);
    expect(get(tempDir('x'), '../' + real.split(/[\\/]/).slice(-2).join('/'))).toBe('[ui]\n');
  });
});

describe('认不认得 grok', () => {
  it('官方安装在 ~/.grok/bin、不在 PATH 上：也算装了（法国就是这样装的）', () => {
    const home = tempDir('home');
    fakeBin(join(home, '.grok', 'bin'), 'grok');
    expect(installedAgents({ env: { PATH: '' }, platform: PLATFORM, home }).has('grok')).toBe(true);
    // 【故意造出的失败】别家不去 ~/.grok/bin 找：放在那儿的 codex 不算
    fakeBin(join(home, '.grok', 'bin'), 'codex');
    expect(installedAgents({ env: { PATH: '' }, platform: PLATFORM, home }).has('codex')).toBe(false);
    expect(findBin('grok', { env: { PATH: '' }, platform: PLATFORM, home })).toBeUndefined();
    expect(
      findBin('grok', { env: { PATH: '' }, platform: PLATFORM, home }, AGENTS.grok.homeDirs),
    ).toBeDefined();
  });
});
