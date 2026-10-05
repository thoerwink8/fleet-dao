// 配置对账（deploy/france/auto-release/config.mjs，#323）每条路：照 systemd 读环境文件（和 deploy/lib/app-config.sh 的 env_parse
// 同一批样本）、期望文件认不认得出、私有值的指纹、线上手改了报哪一项、私有值不一致只报「不一致」不带值、期望和钥匙读不到记没查成、
// 命令行不打印值。仓里那份真的期望文件也在这里过一遍校验，和 france.sh 钉住的几个值对得上。
// 发布时照期望写（apply，方案第四节）：只写期望变了的键、人手改的不改回、selfHeal 开了才改回并留痕、期望里没有了的删掉、
// 退回照旧版写回去；期望认不出、线上文件认不出、要写的键写了几行、写后读回不一致、记录认不出、档位认不出，一律不写（写了的改回原样）。
// 新机器照期望建文件（render）：公开的写值、私有的只留空位。档位文件挑哪一份期望（readProfile、readLive）。
// 跑法：node --test deploy/test/config.test.mjs（deploy/test/run.sh 会跑）。
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APPLY_FILES,
  applyConfig,
  CARPOOL_CAP,
  CONFIG_FILES,
  ConfigError,
  carpoolCapProblems,
  cli,
  DESIRED_FILE,
  diffProfiles,
  FINGERPRINT_ALGORITHM,
  FRANCE_DESIRED_FILE,
  fingerprintOf,
  judgeConfig,
  keyIdOf,
  LOCAL_DESIRED_FILE,
  PROFILE_DESIRED,
  parseApplied,
  parseDesired,
  parseEnv,
  parseFingerprintKey,
  planApply,
  readLive,
  readProfile,
  renderEnv,
  unregisteredDesiredFiles,
} from '../france/auto-release/config.mjs';

const KEY_TEXT = `${'5a'.repeat(32)}\n`;
const KEY = parseFingerprintKey(KEY_TEXT);
const SECRET = 'cli_fake-飞书-9f8e7d'; // 带 fake：卫生检查认得出是编的
const SECRET2 = 'thoerwink8/secret-canary';

/** 一份期望：engine.env 两个公开值、一个私有值，api.env 一个私有值，release.env 一个公开值，france.env 一项都不管。 */
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
      'release.env': { FLEET_SERVICES: 'fleet-engine fleet-api' },
      'france.env': {},
    },
    ...over,
  });
}
const ENGINE = `# 注释\nFLEET_WORK_DIR=/var/lib/fleet-work\nFLEET_MACHINE_NAME=法国\nFLEET_CANARY_REPO=${SECRET2}\n`;
const API = `FEISHU_APP_SECRET=${SECRET}\nFLEET_ENV=production\n`;
/** 线上的四份文件，默认和期望一致；over 换掉其中几份。 */
const files = (over = {}) => ({
  'engine.env': { text: ENGINE },
  'api.env': { text: API },
  'release.env': { text: 'FLEET_SERVICES=fleet-engine fleet-api\n' },
  'france.env': { text: '' },
  ...over,
});
const live = (over = {}) => ({
  commit: 'a'.repeat(40),
  desired: { text: desiredText() },
  files: files(),
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

const VERSIONS = { postgresMajor: '16', nodeMajor: '22', temporalServer: '1.32.0', temporalCli: '1.9.1' };

test('期望文件：认得出的和各种认不出的', () => {
  const ok = parseDesired(desiredText());
  assert.equal(ok.selfHeal, false);
  assert.equal(ok.versions, null, '没写 versions 就是 null，老的期望文件不用跟着改');
  assert.deepEqual(
    ok.files['engine.env'].map((d) => [d.key, d.kind]),
    [
      ['FLEET_WORK_DIR', 'public'],
      ['FLEET_MACHINE_NAME', 'public'],
      ['FLEET_CANARY_REPO', 'private'],
    ],
  );
  const withVersions = parseDesired(desiredText({ versions: { 说明: '随便写点', ...VERSIONS } }));
  assert.deepEqual(withVersions.versions, VERSIONS, '说明字段不算进解析出来的版本里');
  const bad = [
    ['不是 JSON', '{', /不是 JSON/],
    ['格式版本不认识', desiredText({ formatVersion: 2 }), /formatVersion/],
    ['多了不认识的一项', desiredText({ 别的: 1 }), /不认识的一项/],
    ['selfHeal 没写成布尔', desiredText({ selfHeal: 'no' }), /selfHeal/],
    ['不认识的文件', desiredText({ files: { 'x.env': {} } }), /不认识的文件/],
    [
      '少了一份受管的文件（漏写就没人比它）',
      JSON.stringify({
        ...JSON.parse(desiredText()),
        files: { ...JSON.parse(desiredText()).files, 'france.env': undefined },
      }),
      /少了 france\.env/,
    ],
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
      JSON.stringify({ ...JSON.parse(desiredText()), fingerprint: undefined }),
      /fingerprint/,
    ],
    ['指纹算法不认识', desiredText({ fingerprint: { algorithm: 'sha256', keyId: null } }), /指纹算法/],
    [
      '钥匙编号不对',
      desiredText({ fingerprint: { algorithm: FINGERPRINT_ALGORITHM, keyId: 'xyz' } }),
      /keyId/,
    ],
    ['versions 不是对象', desiredText({ versions: '1.32.0' }), /versions 要是一个对象/],
    [
      'versions 里有不认识的键',
      desiredText({ versions: { ...VERSIONS, 别的: '1' } }),
      /不认识的一项「别的」/,
    ],
    [
      'versions 少了一项（#451：漏一项就比不全）',
      desiredText({ versions: { postgresMajor: '16' } }),
      /versions 少了.*nodeMajor/,
    ],
    [
      'versions 的值不是字符串',
      desiredText({ versions: { ...VERSIONS, nodeMajor: 22 } }),
      /nodeMajor 要是非空字符串/,
    ],
    [
      'versions 的值是空字符串',
      desiredText({ versions: { ...VERSIONS, temporalCli: '' } }),
      /temporalCli 要是非空字符串/,
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
  const r = judgeConfig(live({ files: files({ 'engine.env': { text: edited }, 'api.env': { text: API } }) }));
  assert.equal(r.result, 'drift');
  assert.deepEqual(
    r.drift.map((d) => [d.id, d.kind]),
    [['engine.env:FLEET_WORK_DIR', 'value']],
  );
  assert.match(r.drift[0].title, /engine\.env 的 FLEET_WORK_DIR/);
  assert.match(r.drift[0].body, /期望「\/var\/lib\/fleet-work」/, '公开的期望照写，人知道该改成什么');
  noValues(r, '/tmp/手改的', SECRET, SECRET2);
});

test('不一致时报哪份文件要改：默认指仓里的法国期望，本机档（#451）传了 desiredPath 就指那一份', () => {
  const edited = ENGINE.replace('FLEET_WORK_DIR=/var/lib/fleet-work', 'FLEET_WORK_DIR=/tmp/手改的');
  const withFiles = { files: files({ 'engine.env': { text: edited }, 'api.env': { text: API } }) };
  const france = judgeConfig(live(withFiles));
  assert.match(
    france.drift[0].body,
    new RegExp(`期望在仓里 ${DESIRED_FILE.replaceAll('/', '\\/')}`),
    '不传 desiredPath（readback_config 不带本机档时的样子）：还是指法国那份，行为不变',
  );
  const local = judgeConfig(live({ ...withFiles, desiredPath: LOCAL_DESIRED_FILE }));
  assert.match(
    local.drift[0].body,
    new RegExp(`期望在仓里 ${LOCAL_DESIRED_FILE.replaceAll('\\', '\\\\').replaceAll('/', '\\/')}`),
    '传了 desiredPath（readback_config 本机档时的样子）：指本机档那份，不是法国那份',
  );
});

test('本机档：私有值对不上、多了一项、标题，也都指本机档那份期望，一处都不提法国那份（#323）', () => {
  // 私有值改了、engine.env 多一项、release.env 的公开值改了、api.env 写重一行、engine.env 缺一项：五种报警全出
  const engine = `${ENGINE.replace(`FLEET_CANARY_REPO=${SECRET2}`, 'FLEET_CANARY_REPO=canary-handedit-xyz')}FLEET_EXTRA=1\n`;
  const over = {
    'engine.env': { text: engine.replace('FLEET_MACHINE_NAME=法国\n', '') },
    'api.env': { text: `${API}FLEET_ENV=production\n` },
    'release.env': { text: 'FLEET_SERVICES=fleet-engine\n' },
  };
  for (const desiredPath of [PROFILE_DESIRED.local, LOCAL_DESIRED_FILE]) {
    const r = judgeConfig(live({ files: files(over), desiredPath }));
    assert.deepEqual(r.drift.map((d) => d.kind).sort(), [
      'duplicate',
      'missing',
      'private',
      'undeclared',
      'value',
    ]);
    for (const d of r.drift) {
      assert.match(d.title, /^本机档配置/, `${d.id} 的标题说的是本机档，不是法国`);
      assert.ok(!`${d.title}${d.body}`.includes(DESIRED_FILE), `${d.id} 不许指法国那份期望：${d.body}`);
    }
    const byKind = Object.fromEntries(r.drift.map((d) => [d.kind, d.body]));
    for (const kind of ['private', 'undeclared', 'missing', 'value'])
      assert.ok(byKind[kind].includes(desiredPath), `${kind} 要写清改本机档那份：${byKind[kind]}`);
    assert.match(byKind.private, /在本机档上以 root 跑/);
    noValues(r, 'canary-handedit-xyz', SECRET, SECRET2);
  }
  // 法国（不传 desiredPath）照旧
  const france = judgeConfig(live({ files: files(over) }));
  for (const d of france.drift) assert.match(d.title, /^法国配置/);
  assert.ok(france.drift.find((d) => d.kind === 'private').body.includes(DESIRED_FILE));
});

test('私有值不一致：只报「不一致」，结果和报警里搜不到线上的值，也搜不到原来的值', () => {
  const changed = API.replace(SECRET, 'cli_手改成的新密钥');
  const r = judgeConfig(
    live({ files: files({ 'engine.env': { text: ENGINE }, 'api.env': { text: changed } }) }),
  );
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
  const r = judgeConfig(live({ files: files({ 'engine.env': { text: engine }, 'api.env': { text: API } }) }));
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
      live({ ...over, files: files({ 'engine.env': { text: edited }, 'api.env': { text: API } }) }),
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
    live({
      files: files({ 'engine.env': { error: '没有 /etc/fleet-dao/engine.env' }, 'api.env': { text: API } }),
    }),
  );
  assert.equal(r.result, 'unchecked');
  assert.match(r.unchecked.join(), /engine\.env 读不到.*3 项都没比/);
  r = judgeConfig(
    live({ files: files({ 'engine.env': { text: 'A="没配上\n' }, 'api.env': { text: API } }) }),
  );
  assert.match(r.unchecked.join(), /engine\.env 认不出/);
  // 线上空着也一样：null 是「还没记指纹」，不是「登记成留空」——还没放的私有值（比如等 GitHub App 的 webhook 密钥）
  // 不能因为线上空着就当成对得上；真要留空的登记成公开的空值（下一条）
  r = judgeConfig(
    live({
      desired: { text: JSON.stringify(noFp) },
      files: files({ 'api.env': { text: 'FEISHU_APP_SECRET=\nFLEET_ENV=production\n' } }),
    }),
  );
  assert.deepEqual(r.drift, []);
  assert.deepEqual(r.unchecked, ['api.env 的 FEISHU_APP_SECRET 是私有值，仓里还没记它的指纹']);
});

test('本机档不接飞书，飞书一对登记成留空（公开的空值，#731）：线上空着对得上、不记没查成；填了值报不一致，值不打印', () => {
  const localText = readFileSync(LOCAL_DESIRED_FILE, 'utf8');
  const want = parseDesired(localText);
  for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']) {
    const d = want.files['api.env'].find((x) => x.key === key);
    assert.deepEqual([d.kind, d.value], ['public', ''], `${key}：登记成公开的空值`);
    assert.match(d.note ?? '', /不接飞书/, `${key}：说明里写清为什么留空`);
  }
  // 线上照期望建出来的样子（公开的照期望写、私有的留空位）：飞书一对本来就该空着
  const liveFiles = Object.fromEntries(CONFIG_FILES.map((f) => [f, { text: renderEnv(want, f, 'x') }]));
  const judge = (over = {}) =>
    judgeConfig({
      desired: { text: localText },
      files: { ...liveFiles, ...over },
      key: { error: '这台还没有指纹钥匙' },
      desiredPath: LOCAL_DESIRED_FILE,
    });
  let r = judge();
  assert.deepEqual(r.drift, []);
  assert.ok(
    !r.unchecked.some((u) => u.includes('FEISHU')),
    `飞书一对按登记留空，不该记没查成：${r.unchecked.join('；')}`,
  );
  const filled = liveFiles['api.env'].text.replace(/^FEISHU_APP_ID=$/m, `FEISHU_APP_ID=${SECRET}`);
  assert.notEqual(filled, liveFiles['api.env'].text, '故意填上值');
  r = judge({ 'api.env': { text: filled } });
  assert.equal(r.result, 'drift');
  assert.deepEqual(
    r.drift.map((d) => [d.id, d.kind]),
    [['api.env:FEISHU_APP_ID', 'value']],
  );
  noValues(r, SECRET);
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
  assert.equal(engine.FLEET_ENGINE_PORTS, 'real');
});

/**
 * 一对期望：france、local 默认和 desiredText() 一样（含同一份 versions），patch.files 按文件把某几个键换掉
 * （同一份文件里没提到的键照旧留着），patch.versions 整个换掉。深合并只到「文件」这一层，够这里的用例用。
 */
function profilePair(patchFrance = {}, patchLocal = {}) {
  // 巡检仓 / 演练仓两边必须是不同的公开值（MUST_DIFFER，#777）：默认就各写一个，本机那份带说明（登记过的差别）
  const canary = {
    france: 'acme/patrol',
    local: { value: 'acme/drill', 说明: '登记过：本机档只接演练仓' },
  };
  const build = (patch, side) => {
    const obj = JSON.parse(desiredText({ versions: VERSIONS }));
    obj.files['engine.env'].FLEET_CANARY_REPO = canary[side];
    for (const [file, keys] of Object.entries(patch.files ?? {}))
      obj.files[file] = { ...obj.files[file], ...keys };
    if (patch.versions) obj.versions = patch.versions;
    return parseDesired(JSON.stringify(obj));
  };
  return { france: build(patchFrance, 'france'), local: build(patchLocal, 'local') };
}

test('diffProfiles：本机档和法国逐项比，没登记的差别报红，版本没有例外（#451）', () => {
  const { france, local } = profilePair();
  assert.deepEqual(diffProfiles(france, local), { result: 'ok', drift: [], unchecked: [] }, '两份一样：ok');

  // 公开值不一样、本机那份写了说明：登记过的差别，不报
  {
    const r = diffProfiles(
      ...Object.values(
        profilePair(
          {},
          { files: { 'engine.env': { FLEET_MACHINE_NAME: { value: '本机', 说明: '登记过' } } } },
        ),
      ),
    );
    assert.equal(r.result, 'ok', '写了说明就不算没登记的差别');
  }

  // 公开值不一样、本机那份没写说明：没登记的差别，报红
  {
    const r = diffProfiles(
      ...Object.values(profilePair({}, { files: { 'engine.env': { FLEET_MACHINE_NAME: '本机' } } })),
    );
    assert.equal(r.result, 'drift');
    assert.deepEqual(
      r.drift.map((d) => [d.scope, d.file, d.key]),
      [['files', 'engine.env', 'FLEET_MACHINE_NAME']],
    );
    assert.match(r.drift[0].title, /engine\.env 的 FLEET_MACHINE_NAME/);
  }

  // 两边都是私有值（各自的凭据）：本来就不比、不用登记，哪怕没写说明
  {
    const r = diffProfiles(
      ...Object.values(
        profilePair(
          {},
          { files: { 'api.env': { FEISHU_APP_SECRET: { private: fingerprintOf(KEY, 'x', 'y', 'z') } } } },
        ),
      ),
    );
    assert.equal(r.result, 'ok', '两边都是私有值，各自的凭据，不需要登记');
  }

  // 一边私有一边公开：换了种类，也要登记
  {
    const r = diffProfiles(
      ...Object.values(profilePair({}, { files: { 'api.env': { FEISHU_APP_SECRET: '公开的' } } })),
    );
    assert.equal(r.result, 'drift');
    assert.match(r.drift[0].title, /FEISHU_APP_SECRET/);
  }

  // 一边声明了一个键、另一边没有：也要登记（两边键集合要一样）
  {
    const r = diffProfiles(
      ...Object.values(profilePair({}, { files: { 'engine.env': { FLEET_ONLY_LOCAL: '仅本机' } } })),
    );
    assert.equal(r.result, 'drift');
    assert.deepEqual(
      r.drift.map((d) => d.key),
      ['FLEET_ONLY_LOCAL'],
    );
  }

  // 故意改一处没登记的版本（比如本机期望里的 Temporal 版本）：版本钉死，报红，写了说明也不例外
  {
    const r = diffProfiles(
      ...Object.values(profilePair({}, { versions: { ...VERSIONS, temporalServer: '1.31.0' } })),
    );
    assert.equal(r.result, 'drift');
    assert.deepEqual(
      r.drift.map((d) => [d.scope, d.key]),
      [['versions', 'temporalServer']],
    );
    assert.match(r.drift[0].body, /1\.32\.0.*1\.31\.0/);
  }

  // 两份里至少一份没写 versions：没查成，不当成一致
  {
    const noVersions = parseDesired(desiredText());
    const r = diffProfiles(noVersions, profilePair().local);
    assert.equal(r.result, 'unchecked');
    assert.match(r.unchecked[0], /versions/);
  }
});

test('diffProfiles：巡检仓和演练仓两边必须是不同的公开值，一样、私有、空、缺了都报红，写了说明也不例外（#777）', () => {
  const canary = (france, local) => {
    const r = diffProfiles(
      ...Object.values(
        profilePair(
          france === undefined ? {} : { files: { 'engine.env': { FLEET_CANARY_REPO: france } } },
          local === undefined ? {} : { files: { 'engine.env': { FLEET_CANARY_REPO: local } } },
        ),
      ),
    );
    return { r, must: r.drift.filter((d) => d.scope === 'must-differ') };
  };
  assert.deepEqual(canary().r, { result: 'ok', drift: [], unchecked: [] }, '两个不同的公开仓：ok');

  // 故意造出的失败：本机档写成和法国同一个仓（带说明也不放过）
  {
    const { r, must } = canary(undefined, { value: 'acme/patrol', 说明: '写了说明也不行' });
    assert.equal(r.result, 'drift');
    assert.deepEqual(
      must.map((d) => [d.file, d.key]),
      [['engine.env', 'FLEET_CANARY_REPO']],
    );
    assert.match(must[0].title, /必须不一样/);
    assert.match(must[0].body, /两边都是「acme\/patrol」/);
  }
  // 大小写不同还是同一个仓（GitHub 仓名不分大小写）
  {
    const { must } = canary(undefined, { value: 'ACME/Patrol', 说明: '登记过' });
    assert.equal(must.length, 1, '只差大小写：同一个仓');
  }
  // 任一边是私有值：比不出，报红，不当成不一样
  {
    const { must } = canary({ private: fingerprintOf(KEY, 'engine.env', 'FLEET_CANARY_REPO', 'x/y') });
    assert.equal(must.length, 1);
    assert.match(must[0].body, /法国写成了私有值/);
  }
  {
    const { must } = canary(
      { private: null },
      { private: fingerprintOf(KEY, 'engine.env', 'FLEET_CANARY_REPO', 'x/y') },
    );
    assert.equal(must.length, 1, '两边都是私有值：照样报红（这一项不按「各自的凭据」放行）');
    assert.match(must[0].body, /法国和本机档写成了私有值/);
  }
  // 一边是空的：报红
  {
    const { must } = canary('', undefined);
    assert.equal(must.length, 1);
    assert.match(must[0].body, /法国这一项是空的/);
  }
  // 两边都没声明这一项（删掉了）：报红，钉子不会跟着悄悄消失
  {
    const pair = profilePair();
    for (const side of [pair.france, pair.local])
      side.files['engine.env'] = side.files['engine.env'].filter((d) => d.key !== 'FLEET_CANARY_REPO');
    const r = diffProfiles(pair.france, pair.local);
    assert.equal(r.result, 'drift');
    const must = r.drift.filter((d) => d.scope === 'must-differ');
    assert.equal(must.length, 1);
    assert.match(must[0].body, /法国和本机档的期望里没有这一项/);
  }
});

test('仓里 deploy/local 和 deploy/france 的期望：差别都登记过了（#451，改一处没登记的这里会红）', () => {
  const franceText = readFileSync(FRANCE_DESIRED_FILE, 'utf8');
  const localText = readFileSync(LOCAL_DESIRED_FILE, 'utf8');
  const france = parseDesired(franceText);
  const r = diffProfiles(france, parseDesired(localText));
  assert.deepEqual(r, { result: 'ok', drift: [], unchecked: [] }, JSON.stringify(r.drift, null, 2));

  // 故意把本机档里一条登记过的差别，换成另一个没写说明的值：诚实地报红，不是摆设（#451「怎么算做完」要求的用例）
  const brokenObj = JSON.parse(localText);
  brokenObj.files['release.env'].FLEET_HK_PARTS = 'gateway'; // 原来是 { value: "", 说明: "..." }
  const rBroken = diffProfiles(france, parseDesired(JSON.stringify(brokenObj)));
  assert.equal(rBroken.result, 'drift', '换成没写说明的新值：没登记的差别，报红');
  assert.deepEqual(
    rBroken.drift.map((d) => d.key),
    ['FLEET_HK_PARTS'],
  );

  // 故意改本机档里的 Temporal 版本，不动说明：版本钉死，报红
  const brokenVersions = JSON.parse(localText);
  brokenVersions.versions.temporalServer = '1.0.0';
  const rVersion = diffProfiles(france, parseDesired(JSON.stringify(brokenVersions)));
  assert.equal(rVersion.result, 'drift');
  assert.deepEqual(
    rVersion.drift.map((d) => [d.scope, d.key]),
    [['versions', 'temporalServer']],
  );

  // 故意把本机档的演练仓写成法国的巡检仓（#777）：两边是同一个仓，报红
  const franceRepo = JSON.parse(franceText).files['engine.env'].FLEET_CANARY_REPO.value;
  assert.ok(franceRepo, '法国的巡检仓是公开值，仓里比得出');
  const sameRepo = JSON.parse(localText);
  sameRepo.files['engine.env'].FLEET_CANARY_REPO.value = franceRepo;
  const rSame = diffProfiles(france, parseDesired(JSON.stringify(sameRepo)));
  assert.equal(rSame.result, 'drift');
  assert.deepEqual(
    rSame.drift.map((d) => [d.scope, d.file, d.key]),
    [['must-differ', 'engine.env', 'FLEET_CANARY_REPO']],
  );
});

// ── 拼车并发总上限登记（#194 方案 4.7）──

const DEPLOY_DIR = fileURLToPath(new URL('../', import.meta.url));

/** 仓里两份真期望，解析好的样子。 */
const realMachines = () => [
  { name: '法国', desired: parseDesired(readFileSync(FRANCE_DESIRED_FILE, 'utf8')) },
  { name: '本机档', desired: parseDesired(readFileSync(LOCAL_DESIRED_FILE, 'utf8')) },
];
/** 把某台某一项换成别的写法（undefined = 删掉这一项）。 */
function withCap(machines, name, key, spec) {
  return machines.map((m) => {
    if (m.name !== name) return m;
    const list = m.desired.files['engine.env'].filter((d) => d.key !== key);
    if (spec !== undefined) list.push({ key, ...spec });
    return { ...m, desired: { ...m.desired, files: { ...m.desired.files, 'engine.env': list } } };
  });
}
const pub = (value) => ({ kind: 'public', value });

test('拼车并发登记：仓里两份期望都登记了、加起来不超过总上限，没有没登记的机器档', () => {
  const machines = realMachines();
  assert.deepEqual(carpoolCapProblems(machines), []);
  assert.deepEqual(unregisteredDesiredFiles(DEPLOY_DIR), []);
  const own = (n) =>
    Number(
      machines.find((m) => m.name === n).desired.files['engine.env'].find((d) => d.key === CARPOOL_CAP.own)
        .value,
    );
  assert.equal(own('法国') + own('本机档') <= 6, true);
  // diff-local 命令行把它也算进去：真文件现在是一致的
  return cli(['diff-local'], { out: () => {}, err: () => {} }).then((code) => assert.equal(code, 0));
});

test('拼车并发登记：加起来超过总上限判红（故意造出失败）', () => {
  const over = withCap(realMachines(), '法国', CARPOOL_CAP.own, pub('5'));
  const r = carpoolCapProblems(over);
  assert.deepEqual(
    r.map((d) => [d.scope, d.key]),
    [['carpool-cap', CARPOOL_CAP.own]],
  );
  assert.match(r[0].title, /超过总上限：7 > 6/);
  assert.deepEqual(carpoolCapProblems(withCap(realMachines(), '法国', CARPOOL_CAP.own, pub('4'))), []);
});

test('拼车并发登记：加一台机器不改登记也判红；没登记、私有、空、不是正整数都判红，不当成「不限」', () => {
  // 第三台机器登记了 1：4 + 2 + 1 > 6，必须有人把别台往下调
  const third = [...realMachines(), { name: 'WSL2', desired: realMachines()[1].desired }];
  const r3 = carpoolCapProblems(withCap(third, 'WSL2', CARPOOL_CAP.own, pub('1')));
  assert.equal(r3.length, 1);
  assert.match(r3[0].title, /7 > 6/);
  // 第三台干脆没登记这一项
  const missing = carpoolCapProblems(withCap(third, 'WSL2', CARPOOL_CAP.own, undefined));
  assert.equal(missing.length, 1);
  assert.match(missing[0].title, /WSL2没登记拼车并发上限/);
  for (const [spec, why] of [
    [{ kind: 'private', fp: null }, /私有值/],
    [pub(''), /不是正整数/],
    [pub('0'), /不是正整数/],
    [pub('-1'), /不是正整数/],
    [pub('四'), /不是正整数/],
    [pub('2.5'), /不是正整数/],
  ]) {
    const r = carpoolCapProblems(withCap(realMachines(), '本机档', CARPOOL_CAP.own, spec));
    assert.equal(r.length, 1, JSON.stringify(spec));
    assert.match(r[0].body, why);
  }
});

test('拼车并发登记：总上限没写、写成私有、两边不一样都判红', () => {
  const noTotal = carpoolCapProblems(withCap(realMachines(), '法国', CARPOOL_CAP.total, undefined));
  assert.equal(noTotal.length, 1);
  assert.match(noTotal[0].title, /法国没登记拼车并发总上限/);
  const differ = carpoolCapProblems(withCap(realMachines(), '本机档', CARPOOL_CAP.total, pub('8')));
  assert.equal(differ.length, 1);
  assert.match(differ[0].title, /总上限不一样/);
  const priv = carpoolCapProblems(
    withCap(realMachines(), '本机档', CARPOOL_CAP.total, { kind: 'private', fp: null }),
  );
  assert.equal(priv.length, 1);
  assert.match(priv[0].body, /私有值/);
});

test('拼车并发登记：仓里多出一份没登记的机器档判红，读不了目录是没查成', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-deploy-'));
  try {
    for (const rel of Object.values(PROFILE_DESIRED)) {
      mkdirSync(join(dir, rel.split('/')[1]), { recursive: true });
      writeFileSync(join(dir, rel.split('/')[1], 'desired-config.json'), '{}');
    }
    mkdirSync(join(dir, 'newbox'));
    writeFileSync(join(dir, 'newbox', 'desired-config.json'), '{}');
    mkdirSync(join(dir, 'examples')); // 没有 desired-config.json 的目录不算机器档
    writeFileSync(join(dir, 'cursor-key.sh'), '#!/bin/sh\n'); // deploy/ 下的脚本（普通文件）也不算，不能因 ENOTDIR 当成没查成
    const r = unregisteredDesiredFiles(dir);
    assert.deepEqual(
      r.map((d) => d.file),
      ['deploy/newbox/desired-config.json'],
    );
    assert.throws(() => unregisteredDesiredFiles(join(dir, '不存在')), ConfigError);
    // Linux 上 stat「普通文件/desired-config.json」报 ENOTDIR（Windows 报 ENOENT）：照样不算机器档；别的读不了的错照常抛
    const errno = (code) => Object.assign(new Error(code), { code });
    const linuxStat = (path) => {
      if (path.includes('cursor-key.sh')) throw errno('ENOTDIR');
      return statSync(path);
    };
    assert.deepEqual(
      unregisteredDesiredFiles(dir, linuxStat).map((d) => d.file),
      ['deploy/newbox/desired-config.json'],
    );
    assert.throws(
      () =>
        unregisteredDesiredFiles(dir, (path) => {
          if (path.includes('newbox')) throw errno('EACCES');
          return statSync(path);
        }),
      ConfigError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('命令行 diff-local：拼车并发超了退出码 1、写明加起来多少', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-config-'));
  try {
    const france = JSON.parse(readFileSync(FRANCE_DESIRED_FILE, 'utf8'));
    france.files['engine.env'].FLEET_CARPOOL_MAX_CONCURRENCY.value = '5';
    writeFileSync(join(dir, 'a.json'), JSON.stringify(france));
    const out = [];
    const code = await cli(['diff-local', '--france', join(dir, 'a.json'), '--local', LOCAL_DESIRED_FILE], {
      out: (s) => out.push(s),
      err: () => {},
    });
    assert.equal(code, 1);
    assert.match(out.join('\n'), /red .*加起来超过总上限：7 > 6/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 法国期望里「引擎待命」的那一项该有的样子（创始人 2026-10-05：关闭＝进程开着但不接活）：值带 fleet-engine 和 fleet-api，
 * 说明里写清待命是什么、探针的代价、上线不用手动恢复定时任务（#1072：定时任务是引擎进程里的定时器），不再留「进程停着」的临时说法。返回哪里不对（空 = 都对）。
 */
function franceEngineStandbyProblems(desired) {
  const item = desired.files?.['release.env']?.FLEET_SERVICES;
  if (item === null || typeof item !== 'object') return ['FLEET_SERVICES 没写成带说明的对象'];
  const problems = [];
  if (item.value !== 'fleet-engine fleet-api')
    problems.push(`值是「${item.value}」，不是 fleet-engine fleet-api`);
  for (const word of ['待命', '路由探针', '2026-10-05', '引擎进程里的定时器']) {
    if (!String(item.说明 ?? '').includes(word)) problems.push(`说明里没写「${word}」`);
  }
  if (String(item.说明 ?? '').includes('--unpause'))
    problems.push('说明里还留着手动恢复 Temporal 定时任务的 --unpause（#1072 起不用了）');
  if (String(item.说明 ?? '').includes('最迟 2026-10-05 复查'))
    problems.push('说明里还留着「最迟复查」的临时说法');
  return problems;
}

test('法国期望里引擎开着待命（FLEET_SERVICES 带 fleet-engine）、待命的代价和「上线不用手动恢复定时任务」写全；本机档同样带引擎，两边现在一样（创始人 2026-10-05 撤回「进程停着」）', () => {
  const france = JSON.parse(readFileSync(FRANCE_DESIRED_FILE, 'utf8'));
  const local = JSON.parse(readFileSync(LOCAL_DESIRED_FILE, 'utf8'));
  assert.deepEqual(franceEngineStandbyProblems(france), []);
  assert.equal(
    local.files['release.env'].FLEET_SERVICES.value,
    france.files['release.env'].FLEET_SERVICES.value,
    '两边的引擎都开着，值一样',
  );
  assert.doesNotMatch(
    local.files['release.env'].FLEET_SERVICES.说明,
    /^登记的差别/,
    '两边一样了，本机档这一项不再是「登记的差别」',
  );

  // 故意造出失败：改回「进程停着」的旧值、抹掉说明、留着旧的临时说法，这个检查都要红（不是摆设）
  const stopped = structuredClone(france);
  stopped.files['release.env'].FLEET_SERVICES.value = 'fleet-api';
  assert.deepEqual(franceEngineStandbyProblems(stopped), ['值是「fleet-api」，不是 fleet-engine fleet-api']);
  const bare = structuredClone(france);
  bare.files['release.env'].FLEET_SERVICES = 'fleet-engine fleet-api';
  assert.deepEqual(franceEngineStandbyProblems(bare), ['FLEET_SERVICES 没写成带说明的对象']);
  const noNote = structuredClone(france);
  noNote.files['release.env'].FLEET_SERVICES.说明 = '开着';
  assert.equal(
    franceEngineStandbyProblems(noNote).length,
    4,
    '说明只写了「开着」：待命、探针代价、日期、定时器说明都缺',
  );
  const oldNote = structuredClone(france);
  oldNote.files['release.env'].FLEET_SERVICES.说明 += '最迟 2026-10-05 复查，没撤回要写明为什么续。';
  assert.deepEqual(franceEngineStandbyProblems(oldNote), ['说明里还留着「最迟复查」的临时说法']);
});

test('命令行 diff-local：不给路径就用仓里两份真文件，退出码分得清一致、不一致、没查成', async () => {
  const r = await cli(['diff-local'], { out: () => {}, err: () => {} });
  assert.equal(r, 0, '仓里现在这两份应该是一致的（差别都登记过了）');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-config-'));
  try {
    writeFileSync(join(dir, 'a.json'), desiredText({ versions: VERSIONS }));
    writeFileSync(join(dir, 'b.json'), desiredText({ versions: { ...VERSIONS, nodeMajor: '20' } }));
    const out = [];
    const code = await cli(['diff-local', '--france', join(dir, 'a.json'), '--local', join(dir, 'b.json')], {
      out: (s) => out.push(s),
      err: () => {},
    });
    assert.equal(code, 1);
    assert.match(out.join('\n'), /red .*版本没钉住一样.*nodeMajor/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('命令行：算指纹只打印指纹；对账不打印值、退出码分得清一致、不一致、没查成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-config-'));
  try {
    const etc = join(dir, 'etc');
    writeFileSync(join(dir, 'key'), KEY_TEXT);
    writeFileSync(join(dir, 'desired.json'), desiredText());
    mkdirSync(etc);
    for (const [name, got] of Object.entries(files())) writeFileSync(join(etc, name), got.text);
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
    assert.equal(
      got.desiredPath,
      DESIRED_FILE,
      '不给 --desired：不一致时指仓里的法国期望，和加本机档之前一样',
    );
    got = readLive({
      releases: join(dir, 'releases'),
      etc: join(dir, 'etc'),
      key: join(dir, 'key'),
      desired: join(dir, 'local-desired.json'),
    });
    assert.equal(
      got.desiredPath,
      join(dir, 'local-desired.json'),
      '给了 --desired（本机档，#451）：指那份文件，不是法国的',
    );
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

// ── 发布时照期望写（#323 方案第四节）、新机器照期望建文件、档位 ──

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DOMAIN = 'cockpit.fake-domain.invalid';

/**
 * 照期望写用的期望：engine.env 两个公开值、一个私有值，api.env 一公开一私有，release.env 两个公开值、一个私有值。
 * patch 按文件换掉几个键（值是 null 就删掉那个键），top 换掉顶上几项（selfHeal 之类）。
 */
function applyDesired(patch = {}, top = {}) {
  const fp = (file, key, value) => ({ private: fingerprintOf(KEY, file, key, value) });
  const files = {
    'engine.env': {
      FLEET_WORK_DIR: { value: '/var/lib/fleet-work', 说明: '工作树的根' },
      FLEET_MACHINE_NAME: '法国',
      FLEET_CANARY_REPO: fp('engine.env', 'FLEET_CANARY_REPO', SECRET2),
    },
    'api.env': { FEISHU_APP_SECRET: fp('api.env', 'FEISHU_APP_SECRET', SECRET), FLEET_ENV: 'production' },
    'release.env': {
      FLEET_SERVICES: 'fleet-api',
      FLEET_DOMAIN: fp('release.env', 'FLEET_DOMAIN', DOMAIN),
      FLEET_HK_PARTS: 'gateway',
    },
    'france.env': {},
  };
  for (const [file, keys] of Object.entries(patch)) {
    for (const [k, v] of Object.entries(keys)) {
      if (v === null) delete files[file][k];
      else files[file][k] = v;
    }
  }
  return JSON.stringify({
    formatVersion: 1,
    selfHeal: false,
    fingerprint: { algorithm: FINGERPRINT_ALGORITHM, keyId: keyIdOf(KEY) },
    files,
    ...top,
  });
}
/** 和 applyDesired() 一致的线上三份。 */
const LIVE = {
  'engine.env': `# 人写的注释\nFLEET_WORK_DIR=/var/lib/fleet-work\nFLEET_MACHINE_NAME=法国\nFLEET_CANARY_REPO=${SECRET2}\n`,
  'api.env': `FEISHU_APP_SECRET=${SECRET}\nFLEET_ENV=production\n`,
  'release.env': `FLEET_SERVICES=fleet-api\nFLEET_DOMAIN=${DOMAIN}\nFLEET_HK_PARTS=gateway\n`,
};
/** 上次照这份期望写过的记录（记的是它的公开值）。 */
const appliedOf = (desired) => ({
  files: planApply({ want: parseDesired(desired), live: LIVE, stamp: 'x' }).files,
  log: [],
});

test('照期望写：只写这一版的期望和上次写的不一样的键，人手改的不改回（selfHeal 关着），私有值一个都不写', () => {
  const applied = appliedOf(applyDesired());
  const want = parseDesired(applyDesired({ 'release.env': { FLEET_SERVICES: 'fleet-engine fleet-api' } }));
  const live = {
    ...LIVE,
    'engine.env': LIVE['engine.env'].replace('FLEET_MACHINE_NAME=法国', 'FLEET_MACHINE_NAME=手改的'),
  };
  const plan = planApply({ want, applied, live, stamp: 'x' });
  assert.equal(plan.baseline, 'applied');
  assert.deepEqual(plan.set, ['release.env:FLEET_SERVICES']);
  assert.deepEqual(plan.drift, ['engine.env:FLEET_MACHINE_NAME'], '人手改的只记下来，不改回');
  assert.deepEqual(plan.healed, []);
  assert.equal(plan.texts['engine.env'], live['engine.env'], 'engine.env 一个字都没动（人手改的留着）');
  assert.equal(plan.texts['api.env'], live['api.env'], '私有值不写');
  assert.equal(
    plan.texts['release.env'],
    `FLEET_SERVICES=fleet-engine fleet-api\nFLEET_DOMAIN=${DOMAIN}\nFLEET_HK_PARTS=gateway\n`,
    '原地换掉那一行，别的行（私有的域名）不动',
  );
  assert.deepEqual(
    plan.files['release.env'],
    { FLEET_SERVICES: 'fleet-engine fleet-api', FLEET_HK_PARTS: 'gateway' },
    '记下的只有公开值',
  );
});

test('照期望写：期望里新加的键补在末尾带说明（说明里的换行不会变成一条赋值），没了的键删掉，改成私有值的不写也不删', () => {
  const applied = appliedOf(
    applyDesired({
      'release.env': { FLEET_OLD: 'old' },
      'api.env': { FLEET_PUBLIC_URL: 'https://a.invalid' },
    }),
  );
  const want = parseDesired(
    applyDesired({
      'engine.env': { FLEET_NEW: { value: 'v1', 说明: '新加的一项\nFLEET_EVIL=1' } },
      'api.env': { FLEET_PUBLIC_URL: { private: null } },
    }),
  );
  const live = {
    ...LIVE,
    'api.env': `${LIVE['api.env']}FLEET_PUBLIC_URL=https://a.invalid\n`,
    'release.env': `${LIVE['release.env']}FLEET_OLD=old\n`,
  };
  const plan = planApply({ want, applied, live, stamp: '照 x 写上' });
  assert.deepEqual(plan.set, ['engine.env:FLEET_NEW']);
  assert.deepEqual(plan.removed, ['release.env:FLEET_OLD']);
  assert.ok(
    plan.texts['engine.env'].endsWith('# 新加的一项 FLEET_EVIL=1（照 x 写上）\nFLEET_NEW=v1\n'),
    plan.texts['engine.env'],
  );
  assert.ok(
    !parseEnv(plan.texts['engine.env']).entries.some((e) => e.key === 'FLEET_EVIL'),
    '说明里的换行没变成一条赋值',
  );
  assert.equal(plan.texts['release.env'], LIVE['release.env'], '没了的键整行删掉');
  assert.equal(plan.texts['api.env'], live['api.env'], '改成私有值的：值不写、也不删');
  assert.ok(!Object.hasOwn(plan.files['api.env'], 'FLEET_PUBLIC_URL'), '记录里不再有它');
});

test('照期望写：第一次没有记录——有在用的版本拿它的期望当上次写的（只写这一版改了的），没有就只记基线、不写', () => {
  const want = parseDesired(applyDesired({ 'release.env': { FLEET_HK_PARTS: 'gateway web' } }));
  const live = { ...LIVE, 'engine.env': LIVE['engine.env'].replace('法国', '手改的') };
  const first = planApply({ want, live, stamp: 'x' });
  assert.equal(first.baseline, 'new');
  assert.deepEqual([first.set, first.removed, first.healed], [[], [], []]);
  for (const f of APPLY_FILES) assert.equal(first.texts[f], live[f], `${f}：只记基线，一个字不写`);
  assert.equal(first.files['release.env'].FLEET_HK_PARTS, 'gateway web', '基线记的是这一版的期望');
  const withCurrent = planApply({ want, cur: parseDesired(applyDesired()), live, stamp: 'x' });
  assert.equal(withCurrent.baseline, 'current');
  assert.deepEqual(withCurrent.set, ['release.env:FLEET_HK_PARTS'], '只写在用那一版到这一版改了的');
  assert.deepEqual(withCurrent.drift, ['engine.env:FLEET_MACHINE_NAME'], '人手改的照旧不改回');
});

test('照期望写：selfHeal 开着才把人手改的改回去；要写的键写了几行、线上文件认不出就不写', () => {
  const applied = appliedOf(applyDesired());
  const live = {
    ...LIVE,
    'engine.env': LIVE['engine.env'].replace('FLEET_MACHINE_NAME=法国', 'FLEET_MACHINE_NAME = "手改的"'),
  };
  const heal = planApply({
    want: parseDesired(applyDesired({}, { selfHeal: true })),
    applied,
    live,
    stamp: 'x',
  });
  assert.deepEqual(heal.healed, ['engine.env:FLEET_MACHINE_NAME']);
  assert.deepEqual(heal.set, []);
  assert.match(heal.texts['engine.env'], /^FLEET_MACHINE_NAME=法国$/m);
  assert.match(heal.texts['engine.env'], /^# 人写的注释$/m, '没写的行（注释、私有值）原样');
  // 写了两行：selfHeal 关着只记偏离、不碰；要写（期望变了、或 selfHeal 开着）就一个字都不写
  const dup = { ...LIVE, 'release.env': `${LIVE['release.env']}FLEET_SERVICES=fleet-api\n` };
  const quiet = planApply({ want: parseDesired(applyDesired()), applied, live: dup, stamp: 'x' });
  assert.deepEqual(quiet.drift, ['release.env:FLEET_SERVICES']);
  assert.equal(quiet.texts['release.env'], dup['release.env']);
  for (const [what, desired] of [
    ['期望变了', applyDesired({ 'release.env': { FLEET_SERVICES: 'fleet-engine fleet-api' } })],
    ['selfHeal 开着', applyDesired({}, { selfHeal: true })],
  ]) {
    assert.throws(
      () => planApply({ want: parseDesired(desired), applied, live: dup, stamp: 'x' }),
      (e) => e instanceof ConfigError && /FLEET_SERVICES 写了 2 行/.test(e.message),
      what,
    );
  }
  assert.throws(
    () =>
      planApply({
        want: parseDesired(applyDesired()),
        applied,
        live: { ...LIVE, 'api.env': 'FEISHU_APP_SECRET="没配上\n' },
        stamp: 'x',
      }),
    (e) => e instanceof ConfigError && /api\.env 认不出/.test(e.message),
  );
});

/** 一套临时的发布目录和 /etc/fleet-dao：put(提交号, 期望原文[, 位置]) 放一版，run(提交号, 事件, 参数, 写法) 跑一次 apply。 */
function applySandbox(live = LIVE) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-apply-'));
  const releases = join(dir, 'releases');
  const etc = join(dir, 'etc');
  mkdirSync(etc, { recursive: true });
  mkdirSync(releases, { recursive: true });
  for (const [f, text] of Object.entries(live)) writeFileSync(join(etc, f), text);
  const state = join(releases, '.config-applied.json');
  const profile = join(etc, 'profile');
  const readOr = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '（没有）');
  return {
    dir,
    releases,
    etc,
    state,
    profile,
    put(sha, text, rel = DESIRED_FILE) {
      const parts = rel.split('/');
      mkdirSync(join(releases, sha, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(releases, sha, ...parts), text);
    },
    read: (f) => readOr(join(etc, f)),
    /** 三份文件和记录现在的样子：断言「一个字没动」用。 */
    snapshot: () => [...APPLY_FILES.map((f) => readOr(join(etc, f))), readOr(state)],
    run(commit, how = 'release', extra = {}, writeFile = undefined) {
      const lines = [];
      const code = applyConfig(
        { releases, etc, state, profile, commit, how, ...extra },
        { out: (s) => lines.push(s), ...(writeFile ? { writeFile } : {}) },
      );
      return { code, lines, text: lines.join('\n') };
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('apply：发一版、换一版、同一版再发、退回——只写期望变了的，退回照旧版的期望写回去，记录留着每次写了什么', () => {
  const s = applySandbox();
  try {
    s.put(SHA_A, applyDesired());
    s.put(SHA_B, applyDesired({ 'release.env': { FLEET_HK_PARTS: 'gateway web' } }));
    let r = s.run(SHA_A);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /^changed 第一次照期望写：.*只记基线/m);
    for (const f of APPLY_FILES) assert.equal(s.read(f), LIVE[f], `${f} 没动`);
    writeFileSync(
      join(s.etc, 'engine.env'),
      LIVE['engine.env'].replace('FLEET_MACHINE_NAME=法国', 'FLEET_MACHINE_NAME=手改的'),
    );
    r = s.run(SHA_B);
    assert.equal(r.code, 0, r.text);
    assert.match(
      r.text,
      /^changed release\.env 的 FLEET_HK_PARTS：照 bbbbbbbbbbbb 的期望写成「gateway web」$/m,
    );
    assert.match(r.text, /^note 人手改过、和期望不一致的 1 项不改回.*engine\.env:FLEET_MACHINE_NAME/m);
    assert.ok(!r.text.includes('手改的'), '人手改成的值不打印');
    assert.match(s.read('release.env'), /^FLEET_HK_PARTS=gateway web$/m);
    assert.match(s.read('engine.env'), /^FLEET_MACHINE_NAME=手改的$/m, '人手改的不改回');
    const engineAfter = s.read('engine.env');
    const before = s.snapshot();
    r = s.run(SHA_B);
    assert.match(r.text, /^ok 配置：bbbbbbbbbbbb 的期望和上次写的一样，不用写$/m, '同一版再发：不写');
    assert.ok(!r.lines.some((l) => l.startsWith('changed ')), '同一版再发：一处都没改');
    assert.deepEqual(s.snapshot(), before, '同一版再发：文件、记录都没动');
    r = s.run(SHA_A, 'rollback');
    assert.equal(r.code, 0, r.text);
    assert.match(s.read('release.env'), /^FLEET_HK_PARTS=gateway$/m, '退回：照旧版的期望写回去');
    assert.equal(s.read('engine.env'), engineAfter, '退回也不改回人手改的');
    const st = parseApplied(readFileSync(s.state, 'utf8'));
    assert.deepEqual(
      st.log.map((e) => [e.commit.slice(0, 1), e.how, e.baseline, e.set]),
      [
        ['a', 'release', 'new', []],
        ['b', 'release', 'applied', ['release.env:FLEET_HK_PARTS']],
        ['a', 'rollback', 'applied', ['release.env:FLEET_HK_PARTS']],
      ],
    );
    assert.ok(!readFileSync(s.state, 'utf8').includes('手改的'), '记录里没有线上的值');
  } finally {
    s.done();
  }
});

test('apply：selfHeal 开着把人手改的改回去并留痕（输出、记录里都有），线上原来的值不打印', () => {
  const s = applySandbox({
    ...LIVE,
    'engine.env': LIVE['engine.env'].replace('FLEET_MACHINE_NAME=法国', 'FLEET_MACHINE_NAME=手改的'),
  });
  try {
    s.put(SHA_A, applyDesired({}, { selfHeal: true }));
    writeFileSync(
      s.state,
      `${JSON.stringify({ schema: 1, files: appliedOf(applyDesired()).files, log: [] })}\n`,
    );
    const r = s.run(SHA_A);
    assert.equal(r.code, 0, r.text);
    assert.match(
      r.text,
      /^changed engine\.env 的 FLEET_MACHINE_NAME：人手改过，期望里 selfHeal 开着，照期望改回「法国」/m,
    );
    assert.ok(!r.text.includes('手改的'));
    assert.match(s.read('engine.env'), /^FLEET_MACHINE_NAME=法国$/m);
    const raw = readFileSync(s.state, 'utf8');
    assert.deepEqual(
      parseApplied(raw).log.at(-1).healed,
      ['engine.env:FLEET_MACHINE_NAME'],
      '记录里留痕：哪一次改回了哪一项',
    );
    assert.ok(!raw.includes('手改的'), '记录里也没有线上原来的值');
  } finally {
    s.done();
  }
});

test('apply 写不成就一个字都不写：期望认不出、线上文件认不出或不在、要写的键写了几行、记录认不出、档位认不出', () => {
  const cases = [
    ['期望不是 JSON', (s) => s.put(SHA_B, '{'), /bbbbbbbbbbbb 的期望认不出.*不是 JSON/],
    [
      '期望格式不认识',
      (s) => s.put(SHA_B, applyDesired({}, { formatVersion: 9 })),
      /期望认不出.*formatVersion/,
    ],
    [
      '线上文件认不出（引号没配上）',
      (s) => {
        s.put(SHA_B, applyDesired({ 'release.env': { FLEET_HK_PARTS: 'gateway web' } }));
        writeFileSync(join(s.etc, 'api.env'), 'FEISHU_APP_SECRET="没配上\n');
      },
      /api\.env 认不出/,
    ],
    [
      '线上文件不在',
      (s) => {
        s.put(SHA_B, applyDesired());
        rmSync(join(s.etc, 'api.env'));
      },
      /api\.env 读不到/,
    ],
    [
      '要写的键写了几行',
      (s) => {
        s.put(SHA_B, applyDesired({ 'release.env': { FLEET_HK_PARTS: 'gateway web' } }));
        writeFileSync(join(s.etc, 'release.env'), `${LIVE['release.env']}FLEET_HK_PARTS=demo\n`);
      },
      /FLEET_HK_PARTS 写了 2 行/,
    ],
    [
      '记录认不出',
      (s) => {
        s.put(SHA_B, applyDesired());
        writeFileSync(s.state, '{"schema":7}');
      },
      /上次照期望写的记录认不出.*schema/,
    ],
    [
      '档位认不出',
      (s) => {
        s.put(SHA_B, applyDesired());
        writeFileSync(s.profile, 'paris\n');
      },
      /档位文件 .* 认不出.*paris/,
    ],
  ];
  for (const [what, breakIt, why] of cases) {
    const s = applySandbox();
    try {
      s.put(SHA_A, applyDesired());
      assert.equal(s.run(SHA_A).code, 0, what);
      breakIt(s);
      const before = s.snapshot();
      const r = s.run(SHA_B);
      assert.equal(r.code, 1, `${what}：退出 1（${r.text}）`);
      assert.match(r.text, why, what);
      assert.ok(
        r.lines.some((l) => l.startsWith('red ')),
        `${what}：说了 red`,
      );
      assert.ok(!r.lines.some((l) => l.startsWith('changed ')), `${what}：没有一处改动`);
      assert.deepEqual(s.snapshot(), before, `${what}：三份文件和记录一个字都没动`);
    } finally {
      s.done();
    }
  }
});

test('apply：写完读回不一致、写到一半写不进、记录写不进——写过的改回原样，记录不动，退出 1；改回也没成照实说要人看', () => {
  const plain = (path, text) => writeFileSync(path, text);
  const failing = (needle) => (path, text) => {
    if (path.endsWith(needle)) throw Object.assign(new Error('磁盘满了'), { code: 'ENOSPC' });
    plain(path, text);
  };
  const want = applyDesired({
    'engine.env': { FLEET_MACHINE_NAME: '巴黎' },
    'release.env': { FLEET_HK_PARTS: 'gateway web' },
  });
  for (const [what, writeFile, why] of [
    [
      '写进去的读回来不对',
      (path, text) =>
        plain(path, path.endsWith('release.env') ? text.replace('gateway web', 'gateway demo') : text),
      /写完读回不一致：release\.env 改完照 systemd 读回来不对：FLEET_HK_PARTS 不是该有的样子：写过的 engine\.env、release\.env 已改回原样/,
    ],
    [
      '写第二份时写不进',
      failing('release.env'),
      /写 release\.env 没成（ENOSPC）：写过的 engine\.env 已改回原样/,
    ],
    [
      '记录写不进',
      failing('.config-applied.json'),
      /记录 .* 写不进（ENOSPC）：写过的 engine\.env、release\.env 已改回原样/,
    ],
  ]) {
    const s = applySandbox();
    try {
      s.put(SHA_A, applyDesired());
      assert.equal(s.run(SHA_A).code, 0);
      s.put(SHA_B, want);
      const before = s.snapshot();
      const r = s.run(SHA_B, 'release', {}, writeFile);
      assert.equal(r.code, 1, `${what}：${r.text}`);
      assert.match(r.text, why, what);
      assert.deepEqual(s.snapshot(), before, `${what}：写过的改回原样、记录没动`);
    } finally {
      s.done();
    }
  }
  // 头一份写上了，之后什么都写不进（连改回也不行）：不说「已改回」，说要人看
  const s = applySandbox();
  try {
    s.put(SHA_A, applyDesired());
    assert.equal(s.run(SHA_A).code, 0);
    s.put(SHA_B, want);
    let n = 0;
    const r = s.run(SHA_B, 'release', {}, (path, text) => {
      n += 1;
      if (n > 1) throw Object.assign(new Error('只读了'), { code: 'EROFS' });
      plain(path, text);
    });
    assert.equal(r.code, 1);
    assert.match(r.text, /改回原样也没成（engine\.env 还是写过的样子）：要人看/);
  } finally {
    s.done();
  }
});

test('apply --plan 只把写成什么样放进目录（线上、记录都不动），--expect 和核过的不一样就不写', () => {
  const s = applySandbox();
  try {
    s.put(SHA_A, applyDesired());
    assert.equal(s.run(SHA_A).code, 0);
    s.put(SHA_B, applyDesired({ 'release.env': { FLEET_HK_PARTS: 'gateway web' } }));
    const plan = join(s.dir, 'plan');
    mkdirSync(plan);
    const before = s.snapshot();
    let r = s.run(SHA_B, 'release', { plan });
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(
      r.lines.filter((l) => !l.startsWith('note ')),
      [],
      '--plan 不说写了什么（还没写）',
    );
    assert.deepEqual(s.snapshot(), before, '--plan：线上、记录都没动');
    assert.match(readFileSync(join(plan, 'release.env'), 'utf8'), /^FLEET_HK_PARTS=gateway web$/m);
    assert.equal(readFileSync(join(plan, 'api.env'), 'utf8'), LIVE['api.env'], '不用改的那份原样放进去');
    // 核过以后线上又被人改了：重新算出来的和核过的不一样，不写
    writeFileSync(join(s.etc, 'api.env'), `${LIVE['api.env']}FLEET_HAND_ADDED=1\n`);
    const changed = s.snapshot();
    r = s.run(SHA_B, 'release', { expect: plan });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /^red 核过以后 api\.env 又变了/m);
    assert.deepEqual(s.snapshot(), changed);
    // 重新核一遍再写：写上
    assert.equal(s.run(SHA_B, 'release', { plan }).code, 0);
    r = s.run(SHA_B, 'release', { expect: plan });
    assert.equal(r.code, 0, r.text);
    assert.match(s.read('release.env'), /^FLEET_HK_PARTS=gateway web$/m);
    assert.match(s.read('api.env'), /^FLEET_HAND_ADDED=1$/m, '人加的那一行不碰');
  } finally {
    s.done();
  }
});

test('apply：这一版里没有期望（#323 之前的版本）不写、退出 0；期望按档位挑——本机档用 deploy/local 那份', () => {
  const s = applySandbox();
  try {
    mkdirSync(join(s.releases, SHA_A), { recursive: true });
    let r = s.run(SHA_A);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /^ok aaaaaaaaaaaa 里没有 deploy\/france\/desired-config\.json/m);
    assert.match(r.text, /^note 没有档位文件 .*：按法国档/m);
    assert.ok(!existsSync(s.state), '没有期望：记录也不建');
    writeFileSync(s.profile, 'local\n');
    s.put(SHA_B, applyDesired());
    r = s.run(SHA_B);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /里没有 deploy\/local\/desired-config\.json/, '本机档不拿法国那份写');
    s.put(SHA_B, applyDesired({ 'engine.env': { FLEET_MACHINE_NAME: '本机' } }), PROFILE_DESIRED.local);
    r = s.run(SHA_B);
    assert.equal(r.code, 0, r.text);
    const st = JSON.parse(readFileSync(s.state, 'utf8'));
    assert.equal(st.profile, 'local');
    assert.equal(st.desired, 'deploy/local/desired-config.json');
    assert.equal(st.files['engine.env'].FLEET_MACHINE_NAME, '本机', '记下的是本机档那份期望');
  } finally {
    s.done();
  }
});

test('apply：第一次没有记录、有在用的版本——拿它的期望当上次写的，只写这一版改了的', (t) => {
  const s = applySandbox();
  try {
    s.put(SHA_A, applyDesired());
    s.put(SHA_B, applyDesired({ 'release.env': { FLEET_HK_PARTS: 'gateway web' } }));
    try {
      symlinkSync(SHA_A, join(s.releases, 'current'));
    } catch {
      t.skip('这台建不了符号链接（Windows 要管理员）：这一条在 CI（Linux）上跑');
      return;
    }
    const r = s.run(SHA_B);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /^note 第一次照期望写：拿在用的 aaaaaaaaaaaa 的期望当「上次写的」/m);
    assert.match(s.read('release.env'), /^FLEET_HK_PARTS=gateway web$/m);
  } finally {
    s.done();
  }
});

test('命令行 apply：参数不对 64；提交号、事件认不出退出 1、说 red', async () => {
  const run = async (...argv) => {
    const lines = [];
    const code = await cli(argv, { out: (s) => lines.push(s), err: (s) => lines.push(s) });
    return { code, text: lines.join('\n') };
  };
  assert.equal((await run('apply', '--plan', 'a', '--expect', 'b')).code, 64);
  assert.equal((await run('apply', 'extra')).code, 64);
  let r = await run('apply', '--commit', 'nothex', '--how', 'release');
  assert.equal(r.code, 1);
  assert.match(r.text, /^red .*提交号认不出/m);
  r = await run('apply', '--commit', SHA_A, '--how', 'deploy');
  assert.equal(r.code, 1);
  assert.match(r.text, /^red --how 只认/m);
});

test('render：照仓里两份真的期望建新机器的三份文件——公开的照期望写，私有的只留空位，键一个不多一个不少，release.sh 读得懂', () => {
  for (const path of [FRANCE_DESIRED_FILE, LOCAL_DESIRED_FILE]) {
    const want = parseDesired(readFileSync(path, 'utf8'));
    for (const file of APPLY_FILES) {
      const text = renderEnv(want, file, 'x');
      const entries = parseEnv(text).entries;
      const declared = want.files[file];
      assert.deepEqual(
        entries.map((e) => e.key),
        declared.map((d) => d.key),
        `${file}：键和期望一样、一样一行`,
      );
      for (const d of declared) {
        const got = entries.find((e) => e.key === d.key).value;
        assert.equal(got, d.kind === 'public' ? d.value : '', `${file} 的 ${d.key}：私有值只留空位`);
      }
      // release.sh 的 load_env 只认注释、空行和 KEY=值
      for (const line of text.split('\n'))
        assert.match(line, /^(#.*|[A-Z][A-Z0-9_]*=.*|)$/, `${file}：${line}`);
    }
  }
  // 说明里带换行：注释里换成空格，不会多出一条赋值；私有值空着，不生造
  const want = parseDesired(
    applyDesired({ 'engine.env': { FLEET_X: { value: 'v', 说明: '第一行\nFLEET_EVIL=1' } } }),
  );
  const text = renderEnv(want, 'engine.env', 'x');
  assert.ok(!parseEnv(text).entries.some((e) => e.key === 'FLEET_EVIL'));
  assert.match(text, /^FLEET_CANARY_REPO=$/m);
  assert.ok(!text.includes(SECRET2));
});

test('命令行 render：打印照期望建的文件；不认识的文件、期望读不到明说没做成', async () => {
  const run = async (...argv) => {
    const out = [];
    const err = [];
    const code = await cli(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  let r = await run('render', 'api.env');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^FLEET_ENV=production$/m);
  assert.match(r.out, /照仓里的期望 deploy\/france\/desired-config\.json 建的/);
  r = await run('render', 'api.env', '--desired', LOCAL_DESIRED_FILE);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^FLEET_PUBLIC_URL=https:\/\/fleet-local\.invalid$/m);
  assert.match(r.out, /照仓里的期望 deploy\/local\/desired-config\.json 建的/);
  r = await run('render', 'france.env');
  assert.equal(r.code, 2);
  assert.match(r.err, /不认识的文件 france\.env/);
  r = await run('render', 'engine.env', '--desired', join(tmpdir(), 'no-such-desired.json'));
  assert.equal(r.code, 2);
  assert.match(r.err, /读不到期望/);
});

test('档位：文件不在按法国；写了 local 用本机档那份；认不出、不是普通文件都不猜；对账读法国上的期望也跟着档位走', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-profile-'));
  try {
    const p = join(dir, 'profile');
    const got = readProfile(p);
    assert.equal(got.profile, 'france');
    assert.equal(got.rel, DESIRED_FILE);
    assert.match(got.note, /没有档位文件/);
    writeFileSync(p, 'local\n');
    assert.deepEqual(readProfile(p), {
      profile: 'local',
      rel: 'deploy/local/desired-config.json',
      note: null,
    });
    writeFileSync(p, 'france');
    assert.equal(readProfile(p).profile, 'france');
    writeFileSync(p, 'local\n\n');
    assert.equal(readProfile(p).profile, 'local', '末尾几个换行都不算（和 bash 的 $(<文件) 一样）');
    for (const bad of ['', 'Local\n', ' local\n', 'local\r\n', 'paris\n']) {
      writeFileSync(p, bad);
      assert.throws(
        () => readProfile(p),
        (e) => e instanceof ConfigError && /认不出/.test(e.message),
        JSON.stringify(bad),
      );
    }
    mkdirSync(join(dir, 'a-dir'));
    assert.throws(() => readProfile(join(dir, 'a-dir')), ConfigError, '不是普通文件');
    const etc = join(dir, 'etc');
    mkdirSync(etc);
    writeFileSync(join(etc, 'profile'), 'local\n');
    let live = readLive({ releases: join(dir, 'releases'), etc, key: join(dir, 'key') });
    assert.equal(live.desiredPath, PROFILE_DESIRED.local, '本机档：不一致时指本机档那份');
    writeFileSync(join(etc, 'profile'), 'paris\n');
    live = readLive({ releases: join(dir, 'releases'), etc, key: join(dir, 'key') });
    assert.match(live.desired.error, /档位文件 .* 认不出/);
    assert.equal(judgeConfig(live).result, 'unchecked', '档位认不出：对账记没查成，不当成一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
