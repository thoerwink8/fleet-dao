// 配置对账（deploy/france/auto-release/config.mjs，#323）每条路：照 systemd 读环境文件（和 deploy/lib/app-config.sh 的 env_parse
// 同一批样本）、期望文件认不认得出、私有值的指纹、线上手改了报哪一项、私有值不一致只报「不一致」不带值、期望和钥匙读不到记没查成、
// 命令行不打印值。仓里那份真的期望文件也在这里过一遍校验，和 france.sh 钉住的几个值对得上。
// 跑法：node --test deploy/test/config.test.mjs（deploy/test/run.sh 会跑）。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONFIG_FILES,
  ConfigError,
  cli,
  DESIRED_FILE,
  FINGERPRINT_ALGORITHM,
  fingerprintOf,
  judgeConfig,
  keyIdOf,
  parseDesired,
  parseEnv,
  parseFingerprintKey,
  readLive,
} from '../france/auto-release/config.mjs';

const KEY_TEXT = `${'5a'.repeat(32)}\n`;
const KEY = parseFingerprintKey(KEY_TEXT);
const SECRET = 'cli_fake-飞书-9f8e7d'; // 带 fake：卫生检查认得出是编的
const SECRET2 = 'thoerwink8/secret-canary';

/** 一份期望：engine.env 两个公开值、一个私有值，api.env 一个私有值。 */
function desiredText(over = {}) {
  return JSON.stringify({
    说明: '测试用',
    formatVersion: 1,
    selfHeal: false,
    fingerprint: { algorithm: FINGERPRINT_ALGORITHM, keyId: keyIdOf(KEY) },
    files: {
      'engine.env': {
        FLEET_WORK_DIR: { value: '/var/lib/fleet-work', 说明: '工作树的根' },
        FLEET_MACHINE_NAME: '法国',
        FLEET_CANARY_REPO: { private: fingerprintOf(KEY, 'engine.env', 'FLEET_CANARY_REPO', SECRET2) },
      },
      'api.env': {
        FEISHU_APP_SECRET: { private: fingerprintOf(KEY, 'api.env', 'FEISHU_APP_SECRET', SECRET) },
        FLEET_ENV: 'production',
      },
    },
    ...over,
  });
}
const ENGINE = `# 注释\nFLEET_WORK_DIR=/var/lib/fleet-work\nFLEET_MACHINE_NAME=法国\nFLEET_CANARY_REPO=${SECRET2}\n`;
const API = `FEISHU_APP_SECRET=${SECRET}\nFLEET_ENV=production\n`;
const live = (over = {}) => ({
  commit: 'a'.repeat(40),
  desired: { text: desiredText() },
  files: { 'engine.env': { text: ENGINE }, 'api.env': { text: API } },
  key: { text: KEY_TEXT },
  ...over,
});
/** 结果里（连同报警的标题和正文）一个值都没有：私有值、线上被改成的值都搜不到。 */
function noValues(result, ...values) {
  const all = JSON.stringify(result);
  for (const v of values) assert.ok(!all.includes(v), `结果里出现了值「${v}」`);
}

test('照 systemd 读环境文件：和 deploy/lib/app-config.sh 的 env_parse 同一批样本', () => {
  // 样本照抄 deploy/test/app-config.test.sh 的 parse_case：[说明, 期望的值（null = 没有生效的 K）, 赋了几次, 文件内容]
  const cases = [
    ['行首缩进', 'abc', 1, '  K=abc'],
    ['= 两边的空白、行尾空白', 'abc', 1, 'K = abc  '],
    ['双引号去一层', 'a b', 1, 'K="a b"'],
    ['单引号去一层，里面原样', 'a"b', 1, "K='a\"b'"],
    ['双引号里 \\" \\\\ \\$ 去掉反斜杠', 'a"b\\c$d', 1, 'K="a\\"b\\\\c\\$d"'],
    ['双引号里别的反斜杠照留', 'a\\nb', 1, 'K="a\\nb"'],
    ['不带引号：反斜杠留下后一个字符', 'a b', 1, 'K=a\\ b'],
    ['值里的 # 不是注释', 'a#b', 1, 'K=a#b'],
    ['; 开头的行是注释', 'y', 1, '; K=x\nK=y'],
    ['CRLF 换行', 'abc', 1, 'K=abc\r\n'],
    ['同一个键写两行：生效的是后一行', 'second', 2, 'K=first\nK=second'],
    ['引号前后几段拼成一个值', 'ab', 1, 'K="a" "b"'],
    ['空值', '', 1, 'K='],
    ['双引号可以跨行', 'l1\nl2', 1, 'K="l1\nl2"'],
    ['光写了键、没写 =', null, 0, 'K'],
    ['注释掉的赋值', null, 0, '# K=abc'],
    ['键名里有空白：整条不算', null, 0, 'K X=1'],
  ];
  for (const [what, want, count, text] of cases) {
    const hits = parseEnv(text).entries.filter((e) => e.key === 'K');
    assert.equal(hits.length, count, what);
    if (want !== null) assert.equal(hits.at(-1).value, want, what);
  }
  assert.throws(
    () => parseEnv('A=1\nK="abc\nB=2\n'),
    (e) => e instanceof ConfigError && /引号/.test(e.message),
  );
  assert.throws(
    () => parseEnv('K=abc\\\n'),
    (e) => e instanceof ConfigError && /反斜杠/.test(e.message),
  );
  // 注释掉的、光写了键的算「出现过」；每条赋值记着它在原文里的位置（发布时照期望改文件用）
  const p = parseEnv('# A=1\nB\n  C = x \nD="y\nz"\n');
  assert.deepEqual(p.mentioned, ['A', 'B']);
  const text = '# A=1\nB\n  C = x \nD="y\nz"\n';
  assert.deepEqual(
    p.entries.map((e) => [e.key, text.slice(e.start, e.end)]),
    [
      ['C', '  C = x '],
      ['D', 'D="y\nz"'],
    ],
  );
});

test('期望文件：认得出的和各种认不出的', () => {
  const ok = parseDesired(desiredText());
  assert.equal(ok.selfHeal, false);
  assert.deepEqual(
    ok.files['engine.env'].map((d) => [d.key, d.kind]),
    [
      ['FLEET_WORK_DIR', 'public'],
      ['FLEET_MACHINE_NAME', 'public'],
      ['FLEET_CANARY_REPO', 'private'],
    ],
  );
  const bad = [
    ['不是 JSON', '{', /不是 JSON/],
    ['格式版本不认识', desiredText({ formatVersion: 2 }), /formatVersion/],
    ['多了不认识的一项', desiredText({ 别的: 1 }), /不认识的一项/],
    ['selfHeal 没写成布尔', desiredText({ selfHeal: 'no' }), /selfHeal/],
    ['不认识的文件', desiredText({ files: { 'x.env': {} } }), /不认识的文件/],
    ['键名不合法', desiredText({ files: { 'engine.env': { 'bad-key': 'x' } } }), /键名/],
    ['公开的值带引号', desiredText({ files: { 'engine.env': { K: 'a"b' } } }), /引号/],
    ['公开的值带换行', desiredText({ files: { 'engine.env': { K: 'a\nb' } } }), /控制字符/],
    ['公开的值头尾有空白', desiredText({ files: { 'engine.env': { K: ' a' } } }), /空白/],
    [
      'value、private 都写了',
      desiredText({ files: { 'engine.env': { K: { value: 'a', private: null } } } }),
      /只写一样/,
    ],
    ['指纹不是 64 位十六进制', desiredText({ files: { 'engine.env': { K: { private: 'abc' } } } }), /64 位/],
    [
      '有私有值却没写 fingerprint',
      JSON.stringify({ formatVersion: 1, selfHeal: false, files: { 'api.env': { K: { private: null } } } }),
      /fingerprint/,
    ],
    ['指纹算法不认识', desiredText({ fingerprint: { algorithm: 'sha256', keyId: null } }), /指纹算法/],
    [
      '钥匙编号不对',
      desiredText({ fingerprint: { algorithm: FINGERPRINT_ALGORITHM, keyId: 'xyz' } }),
      /keyId/,
    ],
  ];
  for (const [what, text, why] of bad) {
    assert.throws(
      () => parseDesired(text),
      (e) => e instanceof ConfigError && why.test(e.message),
      what,
    );
  }
});

test('指纹：绑着文件名和键名，钥匙编号固定；钥匙文件只认 64 位十六进制一行', () => {
  const a = fingerprintOf(KEY, 'api.env', 'FEISHU_APP_ID', 'v');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(fingerprintOf(KEY, 'api.env', 'FEISHU_APP_ID', 'v'), a, '同一个值算出来一样');
  assert.notEqual(fingerprintOf(KEY, 'api.env', 'FEISHU_APP_SECRET', 'v'), a, '换个键就不一样');
  assert.notEqual(fingerprintOf(KEY, 'engine.env', 'FEISHU_APP_ID', 'v'), a, '换个文件就不一样');
  const other = parseFingerprintKey(`${'01'.repeat(32)}`);
  assert.notEqual(fingerprintOf(other, 'api.env', 'FEISHU_APP_ID', 'v'), a, '换把钥匙就不一样');
  assert.match(keyIdOf(KEY), /^[0-9a-f]{32}$/);
  assert.notEqual(keyIdOf(other), keyIdOf(KEY));
  for (const t of ['', 'ABCD', `${'5A'.repeat(32)}\n`, `${'5a'.repeat(32)}\n\n`, `${'5a'.repeat(31)}\n`]) {
    assert.throws(() => parseFingerprintKey(t), ConfigError, JSON.stringify(t));
  }
});

test('线上和期望一致：ok，没有一条偏离', () => {
  const r = judgeConfig(live());
  assert.equal(r.result, 'ok');
  assert.deepEqual(r.drift, []);
  assert.deepEqual(r.unchecked, []);
});

test('线上配置被手改：报出偏离，指明是哪份文件的哪一项；线上的值不打印', () => {
  const edited = ENGINE.replace('FLEET_WORK_DIR=/var/lib/fleet-work', 'FLEET_WORK_DIR=/tmp/手改的');
  const r = judgeConfig(live({ files: { 'engine.env': { text: edited }, 'api.env': { text: API } } }));
  assert.equal(r.result, 'drift');
  assert.deepEqual(
    r.drift.map((d) => [d.id, d.kind]),
    [['engine.env:FLEET_WORK_DIR', 'value']],
  );
  assert.match(r.drift[0].title, /engine\.env 的 FLEET_WORK_DIR/);
  assert.match(r.drift[0].body, /期望「\/var\/lib\/fleet-work」/, '公开的期望照写，人知道该改成什么');
  noValues(r, '/tmp/手改的', SECRET, SECRET2);
});

test('私有值不一致：只报「不一致」，结果和报警里搜不到线上的值，也搜不到原来的值', () => {
  const changed = API.replace(SECRET, 'cli_手改成的新密钥');
  const r = judgeConfig(live({ files: { 'engine.env': { text: ENGINE }, 'api.env': { text: changed } } }));
  assert.equal(r.result, 'drift');
  assert.deepEqual(
    r.drift.map((d) => [d.id, d.kind]),
    [['api.env:FEISHU_APP_SECRET', 'private']],
  );
  assert.match(r.drift[0].body, /私有值.*对不上（值不打印）/);
  noValues(r, 'cli_手改成的新密钥', SECRET, SECRET2);
});

test('缺了、写重了、被注释掉、期望里没有的：各报一条，值都不打印', () => {
  const engine =
    '# FLEET_WORK_DIR=/var/lib/fleet-work\nFLEET_MACHINE_NAME=法国\nFLEET_MACHINE_NAME=法国\n' +
    `FLEET_CANARY_REPO=${SECRET2}\nFLEET_HAND_ADDED=机密的东西\n`;
  const r = judgeConfig(live({ files: { 'engine.env': { text: engine }, 'api.env': { text: API } } }));
  assert.deepEqual(
    r.drift.map((d) => [d.id, d.kind]),
    [
      ['engine.env:FLEET_WORK_DIR', 'missing'],
      ['engine.env:FLEET_MACHINE_NAME', 'duplicate'],
      ['engine.env:FLEET_HAND_ADDED', 'undeclared'],
    ],
  );
  noValues(r, '机密的东西', SECRET2);
});

test('期望读不到、认不出：记没查成，不当成一致', () => {
  for (const [what, desired, why] of [
    [
      '在用的那一版没有期望文件',
      { error: '没有 /srv/fleet-dao-releases/aaa/deploy/france/desired-config.json' },
      /没有/,
    ],
    ['不是 JSON', { text: '{"formatVersion": 1,' }, /不是 JSON/],
    ['格式版本不认识', { text: desiredText({ formatVersion: 9 }) }, /formatVersion/],
    ['还没发布过', { error: '还没发布过（current 不在）' }, /还没发布过/],
  ]) {
    const r = judgeConfig(live({ desired }));
    assert.equal(r.result, 'unchecked', what);
    assert.notEqual(r.result, 'ok', what);
    assert.equal(r.unchecked.length, 1, what);
    assert.match(r.unchecked[0], why, what);
  }
  assert.equal(judgeConfig({}).result, 'unchecked', '什么都没给');
});

test('指纹钥匙读不到、认不出、不是期望记的那把、期望还没记编号：私有值只记一句没查成，公开的照比', () => {
  for (const [what, over, why] of [
    ['钥匙文件不在', { key: { error: '没有 /etc/fleet-dao/config-fingerprint.key' } }, /读不到/],
    ['钥匙认不出', { key: { text: 'not-hex' } }, /认不出/],
    ['换机后没放回钥匙', { key: { text: `${'01'.repeat(32)}\n` } }, /不是期望文件记的那一把/],
    [
      '期望还没记钥匙编号',
      { desired: { text: desiredText({ fingerprint: { algorithm: FINGERPRINT_ALGORITHM, keyId: null } }) } },
      /还没记指纹钥匙的编号/,
    ],
  ]) {
    const edited = ENGINE.replace('FLEET_MACHINE_NAME=法国', 'FLEET_MACHINE_NAME=别处');
    const r = judgeConfig(
      live({ ...over, files: { 'engine.env': { text: edited }, 'api.env': { text: API } } }),
    );
    assert.equal(r.unchecked.length, 1, `${what}：只记一句，不展开成一堆不一致`);
    assert.match(r.unchecked[0], /私有值 2 项都没比/, what);
    assert.match(r.unchecked[0], why, what);
    assert.deepEqual(
      r.drift.map((d) => d.id),
      ['engine.env:FLEET_MACHINE_NAME'],
      `${what}：公开的照比`,
    );
  }
});

test('私有值还没记指纹、线上文件读不到或认不出：那几项记没查成', () => {
  const noFp = JSON.parse(desiredText());
  noFp.files['api.env'].FEISHU_APP_SECRET = { private: null };
  let r = judgeConfig(live({ desired: { text: JSON.stringify(noFp) } }));
  assert.equal(r.result, 'unchecked');
  assert.deepEqual(r.unchecked, ['api.env 的 FEISHU_APP_SECRET 是私有值，仓里还没记它的指纹']);
  r = judgeConfig(
    live({ files: { 'engine.env': { error: '没有 /etc/fleet-dao/engine.env' }, 'api.env': { text: API } } }),
  );
  assert.equal(r.result, 'unchecked');
  assert.match(r.unchecked.join(), /engine\.env 读不到.*3 项都没比/);
  r = judgeConfig(live({ files: { 'engine.env': { text: 'A="没配上\n' }, 'api.env': { text: API } } }));
  assert.match(r.unchecked.join(), /engine\.env 认不出/);
});

test('仓里的期望文件认得出，钉住的几个值和 france.sh 一样，法国几份文件都在里面', () => {
  const text = readFileSync(new URL(`../../${DESIRED_FILE}`, import.meta.url), 'utf8');
  const want = parseDesired(text);
  assert.equal(want.selfHeal, false, '自动改回先关着，开不开等创始人定');
  assert.deepEqual(Object.keys(want.files).sort(), [...CONFIG_FILES].sort());
  const france = readFileSync(new URL('../france.sh', import.meta.url), 'utf8');
  const constant = (name) => new RegExp(`^${name}=(\\S+)`, 'm').exec(france)?.[1];
  const engine = Object.fromEntries(want.files['engine.env'].map((d) => [d.key, d.value]));
  assert.equal(engine.FLEET_WORK_DIR, constant('WORK_DIR'), 'FLEET_WORK_DIR 和 france.sh 的 WORK_DIR 一样');
  assert.equal(engine.FLEET_ENGINE_STATE_DIR, constant('ENGINE_STATE_DIR'));
  assert.equal(engine.FLEET_SENSITIVE_VALUES_FILE, constant('SENSITIVE_VALUES'));
  assert.equal(engine.FLEET_ENGINE_PORTS, 'real');
});

test('命令行：算指纹只打印指纹；对账不打印值、退出码分得清一致、不一致、没查成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-config-'));
  try {
    const etc = join(dir, 'etc');
    writeFileSync(join(dir, 'key'), KEY_TEXT);
    writeFileSync(join(dir, 'desired.json'), desiredText());
    const { mkdirSync } = await import('node:fs');
    mkdirSync(etc);
    writeFileSync(join(etc, 'engine.env'), ENGINE);
    writeFileSync(join(etc, 'api.env'), API);
    const run = async (...argv) => {
      const out = [];
      const err = [];
      const code = await cli(argv, {
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        stdin: () => `${SECRET}\n`,
      });
      return { code, text: `${out.join('\n')}\n${err.join('\n')}` };
    };
    const base = ['--desired', join(dir, 'desired.json'), '--etc', etc, '--key', join(dir, 'key')];
    let r = await run('check', ...base);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /^ok 本机配置和期望/m);
    writeFileSync(join(etc, 'api.env'), API.replace(SECRET, 'cli_另一个'));
    r = await run('check', ...base);
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /^red .*api\.env 的 FEISHU_APP_SECRET/m);
    assert.ok(!r.text.includes('cli_另一个') && !r.text.includes(SECRET), '对账的输出里没有值');
    r = await run('check', '--desired', join(dir, 'no-such.json'), '--etc', etc, '--key', join(dir, 'key'));
    assert.equal(r.code, 2, `期望读不到：没查成（${r.text}）`);
    // 算指纹：线上现在的值、标准输入给的新值；都只打印指纹
    r = await run('fingerprint', 'api.env', 'FEISHU_APP_SECRET', '--etc', etc, '--key', join(dir, 'key'));
    assert.equal(r.code, 0, r.text);
    assert.equal(r.text.trim(), fingerprintOf(KEY, 'api.env', 'FEISHU_APP_SECRET', 'cli_另一个'));
    r = await run('fingerprint', 'api.env', 'FEISHU_APP_SECRET', '--stdin', '--key', join(dir, 'key'));
    assert.equal(r.text.trim(), fingerprintOf(KEY, 'api.env', 'FEISHU_APP_SECRET', SECRET));
    writeFileSync(join(etc, 'api.env'), API);
    r = await run('fingerprint', '--all', ...base);
    assert.equal(r.code, 0, r.text);
    const all = JSON.parse(r.text);
    assert.deepEqual(all.fingerprint, { algorithm: FINGERPRINT_ALGORITHM, keyId: keyIdOf(KEY) });
    assert.equal(
      all.files['engine.env'].FLEET_CANARY_REPO.private,
      fingerprintOf(KEY, 'engine.env', 'FLEET_CANARY_REPO', SECRET2),
    );
    assert.ok(!r.text.includes(SECRET) && !r.text.includes(SECRET2), '--all 的输出里没有值');
    r = await run('key-id', '--key', join(dir, 'key'));
    assert.equal(r.text.trim(), keyIdOf(KEY));
    // 读不到：明说没做成，不拿空串算指纹
    r = await run('fingerprint', 'api.env', 'FLEET_NOPE', '--etc', etc, '--key', join(dir, 'key'));
    assert.equal(r.code, 2);
    assert.match(r.text, /没有生效的 FLEET_NOPE/);
    r = await run('fingerprint', 'api.env', 'FEISHU_APP_SECRET', '--etc', etc, '--key', join(dir, 'no-key'));
    assert.equal(r.code, 2);
    assert.match(r.text, /指纹钥匙读不到/);
    r = await run('bogus');
    assert.equal(r.code, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读法国上的原文：在用那一版里的期望、几份环境文件、钥匙；不在、是符号链接都说清', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-config-'));
  try {
    const { mkdirSync, symlinkSync } = await import('node:fs');
    const sha = 'b'.repeat(40);
    mkdirSync(join(dir, 'releases', sha, 'deploy', 'france'), { recursive: true });
    writeFileSync(join(dir, 'releases', sha, DESIRED_FILE), desiredText());
    mkdirSync(join(dir, 'etc'));
    writeFileSync(join(dir, 'etc', 'engine.env'), ENGINE);
    let got = readLive({ releases: join(dir, 'releases'), etc: join(dir, 'etc'), key: join(dir, 'key') });
    assert.equal(got.commit, null, 'current 不在');
    assert.match(got.desired.error, /还没发布过/);
    assert.match(got.key.error, /没有/);
    assert.match(got.files['api.env'].error, /没有/);
    assert.equal(got.files['engine.env'].text, ENGINE);
    let canLink = true;
    try {
      symlinkSync(sha, join(dir, 'releases', 'current'));
    } catch {
      canLink = false; // Windows 上建符号链接要管理员：这一段在 CI（Linux）上跑
    }
    if (canLink) {
      got = readLive({ releases: join(dir, 'releases'), etc: join(dir, 'etc'), key: join(dir, 'key') });
      assert.equal(got.commit, sha);
      assert.equal(got.desired.text, desiredText());
      symlinkSync(join(dir, 'etc', 'engine.env'), join(dir, 'etc', 'api.env'));
      got = readLive({ releases: join(dir, 'releases'), etc: join(dir, 'etc'), key: join(dir, 'key') });
      assert.match(got.files['api.env'].error, /符号链接/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
