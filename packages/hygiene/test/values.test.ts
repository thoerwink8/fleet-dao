// 已知敏感值名单：怎么找、怎么读、怎么比。值全是假的；读文件、找路径都在内存里换掉，不碰真家目录。
import { describe, expect, it } from 'vitest';
import { formatFinding, scanFiles } from '../src/scan.ts';
import {
  loadSensitiveValues,
  parseSensitiveValues,
  SENSITIVE_VALUES_ENV,
  sensitiveValuesPaths,
  valueMatcher,
} from '../src/values.ts';

const HOME = '/home/tester';
const IN_HOME = '/home/tester/.fleet-dao/sensitive-values.txt';
const IN_ETC = '/etc/fleet-dao/sensitive-values.txt';
const norm = (p: string) => p.replace(/\\/g, '/');

/** 假的文件系统：路径 → 内容；内容是 Error 就当读不了；没列的路径读的时候报 ENOENT（和真文件系统一样）。 */
function fakeFs(files: Record<string, string | Error>) {
  const get = (p: string) => files[norm(p)];
  return {
    read: (p: string) => {
      const c = get(p);
      if (c instanceof Error) throw c;
      if (c === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return c;
    },
  };
}

describe('名单格式', () => {
  it('一行一个值；空行、# 开头的行不算；首尾空白去掉；重复的只留一个', () => {
    expect(
      parseSensitiveValues('# 注释\n\n  4821  \r\nfake-account-778899\n4821\n   # 缩进的注释\n'),
    ).toEqual(['4821', 'fake-account-778899']);
  });
});

describe('找名单', () => {
  it('按顺序：环境变量指的文件 > ~/.fleet-dao > /etc/fleet-dao，第一个存在的算数', () => {
    expect(sensitiveValuesPaths({ [SENSITIVE_VALUES_ENV]: '/ci/tmp/list.txt' }, HOME).map(norm)).toEqual([
      '/ci/tmp/list.txt',
      IN_HOME,
      IN_ETC,
    ]);
    const both = fakeFs({ [IN_HOME]: 'home-value-1\n', [IN_ETC]: 'etc-value-1\n' });
    expect(loadSensitiveValues({ env: {}, home: HOME, ...both })).toMatchObject({
      ok: true,
      values: ['home-value-1'],
    });
    const fromEnv = fakeFs({ '/ci/tmp/list.txt': 'ci-value-1\n', [IN_HOME]: 'home-value-1\n' });
    expect(
      loadSensitiveValues({ env: { [SENSITIVE_VALUES_ENV]: '/ci/tmp/list.txt' }, home: HOME, ...fromEnv }),
    ).toMatchObject({ ok: true, source: '/ci/tmp/list.txt', values: ['ci-value-1'] });
    const onlyEtc = fakeFs({ [IN_ETC]: 'etc-value-1\n' });
    expect(loadSensitiveValues({ env: {}, home: HOME, ...onlyEtc })).toMatchObject({
      ok: true,
      values: ['etc-value-1'],
    });
  });

  it('环境变量指的文件不在：算没读到，不悄悄退回家目录或 /etc 那份', () => {
    const others = fakeFs({ [IN_HOME]: 'home-value-1\n', [IN_ETC]: 'etc-value-1\n' });
    const result = loadSensitiveValues({
      env: { [SENSITIVE_VALUES_ENV]: '/nope.txt' },
      home: HOME,
      ...others,
    });
    expect(result).toMatchObject({ ok: false, tried: ['/nope.txt'] });
    expect(result.ok ? '' : result.reason).toContain(
      `${SENSITIVE_VALUES_ENV} 指的已知敏感值名单 /nope.txt 不在`,
    );
    // 只有空白的环境变量当没设，照常往下找。
    expect(
      loadSensitiveValues({ env: { [SENSITIVE_VALUES_ENV]: '  ' }, home: HOME, ...others }),
    ).toMatchObject({
      ok: true,
      values: ['home-value-1'],
    });
  });

  it('一个都没有、存在但读不了、读出来是空的：都是没读到，不当成「没问题」', () => {
    const none = loadSensitiveValues({ env: {}, home: HOME, ...fakeFs({}) });
    expect(none).toMatchObject({ ok: false });
    expect(none.ok ? '' : none.reason).toContain('没读到');
    const denied = fakeFs({ [IN_HOME]: Object.assign(new Error('denied'), { code: 'EACCES' }) });
    expect(loadSensitiveValues({ env: {}, home: HOME, ...denied })).toMatchObject({ ok: false });
    const empty = fakeFs({ [IN_HOME]: '# 只有注释\n\n' });
    const result = loadSensitiveValues({ env: {}, home: HOME, ...empty });
    expect(result.ok ? '' : result.reason).toContain('是空的');
  });

  it('只有「一个都没有、也没设环境变量」才算 absent（本机钩子据此放行）；放了却坏了、环境变量指错都不算', () => {
    const absent = (r: ReturnType<typeof loadSensitiveValues>) => (r.ok ? undefined : r.absent);
    expect(absent(loadSensitiveValues({ env: {}, home: HOME, ...fakeFs({}) }))).toBe(true);
    const denied = fakeFs({ [IN_HOME]: Object.assign(new Error('denied'), { code: 'EACCES' }) });
    expect(absent(loadSensitiveValues({ env: {}, home: HOME, ...denied }))).toBeUndefined();
    const empty = fakeFs({ [IN_ETC]: '\n' });
    expect(absent(loadSensitiveValues({ env: {}, home: HOME, ...empty }))).toBeUndefined();
    const wrongEnv = loadSensitiveValues({
      env: { [SENSITIVE_VALUES_ENV]: '/nope.txt' },
      home: HOME,
      ...fakeFs({}),
    });
    expect(absent(wrongEnv)).toBeUndefined();
  });

  it('目录没权限（EACCES）不算没放：#184 第二意见——existsSync 在这种时候也回 false，会把放了读不了的名单当成没放', () => {
    const locked = fakeFs({ [IN_ETC]: Object.assign(new Error('denied'), { code: 'EACCES' }) });
    const result = loadSensitiveValues({ env: {}, home: HOME, ...locked });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? true : result.absent).toBeUndefined();
    expect(result.ok ? '' : result.reason).toContain(`${IN_ETC} 读不了（EACCES）`);
    // ENOTDIR（路径里有一段是文件）和 ENOENT 一样算没有这个文件，照常往下找。
    const notDir = fakeFs({
      [IN_HOME]: Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }),
      [IN_ETC]: 'etc-value-1\n',
    });
    expect(loadSensitiveValues({ env: {}, home: HOME, ...notDir })).toMatchObject({
      ok: true,
      values: ['etc-value-1'],
    });
  });
});

describe('按名单比', () => {
  const matcher = valueMatcher(['4821', 'acct-5566778899']);
  const lines = (text: string) => matcher.find(text).map((h) => h.line);

  it('短值（少于 6 个字符）没上下文不报：行号、端口、计数里撞上的不算', () => {
    expect(lines('见 errors.md:4821-4830 · 端口 4821 · 共 4821 条')).toEqual([]);
  });

  it('短值带上下文（org / 组织 / 账号 / 独享 / 拼车……）就报', () => {
    expect(lines('第一行\n切回 4821 接轻活，拼车号的会话用户\nreclaude 的 org 是 4821')).toEqual([2, 3]);
  });

  it('短值要整词：更长数字、小数、带点分段的编号的一截都不算', () => {
    // 拼起来写：「组织 + 数字」本身就会被上下文规则拦，这个测试文件自己不能带。
    const org = (n: string) => ['组织', n].join(' ');
    expect(
      lines([org('148210'), org('48211'), org('4821a'), org('1.4821'), org('4821.5')].join(' · ')),
    ).toEqual([]);
    // 句末的点不是小数点。
    expect(lines(`${org('4821')}。\n${org('4821')}.`)).toEqual([1, 2]);
  });

  it('键名里的 org 用下划线、连字符、驼峰连着也算上下文；值用下划线连着也算整词', () => {
    const kv = (k: string, v = '4821') => [k, v].join('=');
    expect(
      lines(
        [
          kv('ANTHROPIC_ORG_ID'),
          kv('CLAUDE_ORG'),
          ['reclaude', '--org', '4821'].join(' '),
          `{"anthropicOrgId": ${'4821'}}`,
          ['CLAUDE', 'ORG', '4821'].join('_'),
        ].join('\n'),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
    // org 是别的词的一部分（organ、morgan、forge）不算上下文。
    expect(lines(['organic 4821', 'morgan 4821', 'forge 4821'].join('\n'))).toEqual([]);
  });

  it('长值（6 个字符及以上）整词出现就报，不要上下文；大小写不管', () => {
    expect(lines('随便一行 acct-5566778899 结尾\nACCT-5566778899\nxacct-5566778899')).toEqual([1, 2]);
  });

  it('命中只报文件、行、规则名，名单里的值不打出来', () => {
    const report = scanFiles(
      ['docs/a.md'],
      () => Buffer.from('\n用户 acct-5566778899\n'),
      [],
      ['acct-5566778899'],
    );
    expect(report.findings.map(formatFinding)).toEqual(['docs/a.md:2 名单里的敏感值']);
    expect(JSON.stringify(report.findings.map(formatFinding))).not.toContain('5566778899');
  });

  it('文件名（路径）里带名单上的值也报：记在打了码的路径上，报出来不带值；内容干净也照报', () => {
    const report = scanFiles(
      ['specs/acct-5566778899-login/需求.md', 'docs/ok.md', 'src/acct-5566778899.ts'],
      (path) => Buffer.from(path.startsWith('src/') ? '\n用户 acct-5566778899\n' : '# 干净的内容\n'),
      [],
      ['acct-5566778899'],
    );
    expect(report.findings.map(formatFinding)).toEqual([
      'specs/〔名单上的值〕-login/需求.md 名单里的敏感值',
      // 名字带值的文件里内容也命中：内容那一条的位置同样用打了码的名字
      'src/〔名单上的值〕.ts 名单里的敏感值',
      'src/〔名单上的值〕.ts:2 名单里的敏感值',
    ]);
    // 命中的原文（match）只给程序比白名单用；报出来的位置里不带值
    expect(report.findings.map((f) => f.path).join()).not.toContain('5566778899');
  });
});
