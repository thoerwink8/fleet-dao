// 每一类违规都放样本进去，确认当场拦下；形状像、但不算的也逐个核对。
// 违规样本在运行时拼起来（值用固定种子的伪随机串）：源码里不出现整段，全仓检查就不会扫到这个文件自己。
import { describe, expect, it } from 'vitest';
import { findHits, isFakeValue, isPlaceholderId, RULES, type RuleId } from '../src/rules.ts';
import { pseudoNumber, pseudoRandom, pseudoUuid } from './helpers.ts';

const R = (n: number, seed: number) => pseudoRandom(n, seed);
const B64 = (n: number, seed: number) =>
  pseudoRandom(n, seed, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
const HEX = (n: number, seed: number) => pseudoRandom(n, seed, '0123456789abcdef');

const planted: [RuleId, string][] = [
  ['private-key', `${['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ')}\n${B64(64, 4)}\n`],
  ['private-key', `"${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\\n${B64(64, 5)}\\n"`],
  ['private-key', `${['PuTTY-User-Key-File-3', ' ssh-ed25519'].join(':')}\nPrivate-Lines: 1\n${B64(44, 6)}`],
  ['private-key', ['AGE-SECRET-KEY-1', pseudoRandom(58, 8, 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L')].join('')],
  ['token', `export GH_TOKEN=${['ghp', R(36, 9)].join('_')}`],
  ['token', `pat ${['github', 'pat', `${R(22, 10)}_${R(59, 11)}`].join('_')}`],
  ['token', `key ${['sk', 'ant', 'api03', R(93, 12)].join('-')}`],
  ['token', `key ${['sk', 'proj', R(48, 13)].join('-')}`],
  ['token', `grok ${['xai', R(40, 14)].join('-')}`],
  ['token', `export RECLAUDE_API_KEY=${['rck', R(43, 52)].join('_')}`],
  // 额度读取器收的最短 Key（packages/adapters/src/quota/readers/reclaude.ts 的 KEY_SHAPE），这里也要拦。
  ['token', `key ${['rck', R(20, 53)].join('_')}`],
  ['token', `aws ${['AKIA', pseudoRandom(16, 15, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')].join('')}`],
  ['token', `bot ${['7' + pseudoNumber(8, 16), `AA${R(33, 17)}`].join(':')}`],
  ['token', `Authorization: ${['Bearer', R(40, 18)].join(' ')}`],
  ['jwt', `bearer ${['eyJhbGciOiJSUzI1NiJ9', `eyJzdWIiOi${R(24, 19)}`].join('.')}`],
  ['secret-assign', `{"app_secret": "${R(32, 20)}"}`],
  ['secret-assign', `FEISHU_APP_SECRET=${R(32, 21)}`],
  ['secret-assign', `  db_password: ${R(16, 22)}`],
  ['secret-assign', `lark-cli config init --app-secret ${R(32, 23)}`],
  // 纯字母的随机串、开头碰巧是 / 的随机串，都还是密钥。
  [
    'secret-assign',
    `APP_SECRET=${pseudoRandom(32, 37, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')}`,
  ],
  ['secret-assign', `aws_secret_access_key = /${B64(39, 38)}`],
  ['secret-assign', `| app_secret | ${R(32, 24)} |`],
  // 控制台抄来的：空格隔开的英文键名、中文键名、全角冒号。
  ['secret-assign', `App Secret：${R(32, 41)}`],
  ['secret-assign', `飞书应用密钥: ${R(32, 42)}`],
  ['secret-assign', `**Verification Token**：${R(32, 43)}（别外传）`],
  ['secret-assign', `应用密钥是 ${R(32, 50)}`],
  ['secret-assign', `App Secret 为${R(32, 51)}，别外传`],
  ['secret-assign', `app_secret：${R(32, 44)}`],
  ['secret-assign', `| 数据库密码 | ${R(24, 45)} |`],
  ['url-password', `DATABASE_URL=${['postgres://fleet', `${R(20, 25)}@db:5432/fleet`].join(':')}`],
  ['webhook', `${['https://open.feishu.cn/open-apis/bot/v2/hook', pseudoUuid(26)].join('/')}`],
  [
    'webhook',
    `${['https://hooks.slack.com/services', `T${R(8, 27).toUpperCase()}`, `B${R(8, 28).toUpperCase()}`, R(24, 29)].join('/')}`,
  ],
  ['request-id', `（请求 ID: ${['req', R(24, 30)].join('_')}）`],
  ['signature', JSON.stringify({ type: 'thinking', signature: `ErEE${B64(40, 35)}` })],
  ['signature-header', ['X-Reclaude-Signature', R(24, 36)].join(': ')],
];

describe('每一类违规样本都拦得住', () => {
  it.each(planted)('%s：%s', (rule, sample) => {
    expect(findHits(sample).map((h) => h.rule)).toContain(rule);
  });

  it('每条规则都有样本撑着', () => {
    const covered = new Set(planted.map(([rule]) => rule));
    expect([...new Set(RULES.map((r) => r.id))].filter((id) => !covered.has(id))).toEqual([]);
  });

  it('命中带着行号', () => {
    const text = ['第一行', '第二行', `第三行 export GH_TOKEN=${['ghp', R(36, 54)].join('_')}`].join('\n');
    expect(findHits(text).map((h) => [h.rule, h.line])).toEqual([['token', 3]]);
  });
});

describe('形状像、但不算的', () => {
  it.each([
    [
      '只有头、正文是编的私钥',
      "pem: '-----BEGIN RSA PRIVATE KEY-----\\nnope\\n-----END RSA PRIVATE KEY-----'",
    ],
    ['PGP 提交签名', '"signature": "-----BEGIN PGP SIGNATURE-----\\n\\nwsFcBAABCAAQBQJ"'],
    ['打过码的 signature', '"signature":"<redacted>"'],
    [
      '顺序、重复、带假字样的令牌',
      'ghs_abcdefghijklmnop · ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx · ghs_replayreplayreplay · sk-proj-abcdefghijklmnopqrstuvwxyz · Bearer abcdefghijklmnopqrstuvwxyz',
    ],
    ['单词里的 sk-', 'task-abcdefghijklmnopqrstuvwxyz'],
    [
      'Temporal runId、提交号、镜像摘要',
      '"runId": "5b9e1c3a-0f47-4d2e-9a81-6c3f2e7d4b10" · 合并提交 f3168d89ac687221d08812e0c6d1b44e893dccd3',
    ],
    ['占位和常见假 UUID', 'id: 00000000-0000-0000-0000-000000000000 · 12345678-1234-1234-1234-123456789abc'],
    [
      '键名像密钥、值不像',
      [
        'tokenizer: "cl100k_base_v2_extended"',
        '"token": "cache_read_input_tokens"',
        'secret: "your-app-secret-here-1234"',
        'WEBHOOK_SECRET=/etc/fleet-dao/webhook-secret',
        'const accessToken = response.accessToken1234567890',
        '  secret: z.string().min(16),',
        'webhookSecret: "test-webhook-secret-0001"',
        "fleetToken: 'e2e-not-a-token'",
        ['const token = `e2e-$', '{randomUUID()}`;'].join(''),
        'max_tokens: 4096',
      ].join('\n'),
    ],
    [
      '连接串里的密码是变量、占位、开发默认值',
      `postgres://fleet:${'$'}{DB_PASSWORD}@db/fleet · postgres://fleet:<密码>@db · postgres://postgres:postgres@localhost`,
    ],
    [
      '控制台键名、值是说明或变量',
      [
        '密码：至少 12 位，大小写加数字',
        '密钥是在控制台生成的，见 1Password 里 fleet-dao 那一条 · 密码为必填项Required12345',
        'App Secret：见 1Password 里 fleet-dao 那一条',
        ['App Secret: $', '{{ secrets.FEISHU_APP_SECRET }}'].join(''),
        '密钥：/etc/fleet-dao/app-secret',
        'Primary Key: user_id_fk_12345',
      ].join('\n'),
    ],
    [
      'webhook 地址是占位',
      'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    ],
  ])('%s', (_name, text) => {
    expect(findHits(text).map((h) => `${h.rule}@${h.line}`)).toEqual([]);
  });
});

describe('判定用的小函数', () => {
  it('编出来的值：顺序、重复、字符种类少、带假字样；真随机串不算', () => {
    for (const fake of [
      'abcdefghijklmnop',
      'replayreplayreplay',
      'x'.repeat(36),
      'nope',
      'my-fake-token-value',
      'deadbeefdeadbeef',
    ]) {
      expect([fake, isFakeValue(fake)]).toEqual([fake, true]);
    }
    for (const seed of [1, 2, 3, 4, 5]) expect(isFakeValue(R(32, seed))).toBe(false);
  });

  it('单调按字符种类比：随机的 16 位十六进制、12 位数字不算编的', () => {
    const seeds = Array.from({ length: 300 }, (_, i) => i + 1);
    expect(seeds.filter((s) => isFakeValue(HEX(16, s)))).toEqual([]);
    expect(seeds.filter((s) => isFakeValue(pseudoNumber(12, s)))).toEqual([]);
    // 种类真少的照样算编的。
    expect(['aaaabbbbccccdddd', '1113332221113332', 'abcabcabcabcabcx'].map(isFakeValue)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('同一类规则的几种写法对上同一处，只报一条', () => {
    // 带引号的写法和空格隔开的键名写法都对得上这一行。
    expect(findHits(`App Secret: '${R(32, 49)}'`).map((h) => h.rule)).toEqual(['secret-assign']);
  });

  it('占位 UUID', () => {
    expect(isPlaceholderId('00000000-0000-4000-8000-00000000abcd')).toBe(true);
    expect(isPlaceholderId('a1000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isPlaceholderId(pseudoUuid(40))).toBe(false);
  });
});
