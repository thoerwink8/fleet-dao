// 每一类违规都放样本进去，确认当场拦下；形状像、但不算的也逐个核对。
// 违规样本在运行时拼起来（值用固定种子的伪随机串）：源码里不出现整段，全仓检查就不会扫到这个文件自己。
import { describe, expect, it } from 'vitest';
import {
  findHits,
  isFakeValue,
  isPlaceholderId,
  isPublicIPv4,
  isPublicIPv6,
  RULES,
  type RuleId,
} from '../src/rules.ts';
import { pseudoNumber, pseudoRandom, pseudoUuid } from './helpers.ts';

const R = (n: number, seed: number) => pseudoRandom(n, seed);
const B64 = (n: number, seed: number) =>
  pseudoRandom(n, seed, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
const HEX = (n: number, seed: number) => pseudoRandom(n, seed, '0123456789abcdef');
const ORG = pseudoNumber(4, 7);

const planted: [RuleId, string][] = [
  ['email', `mail me: ${[R(8, 2).toLowerCase(), 'mail.co'].join('@')}`],
  ['ipv4', `ssh root@${[51, 38, 4, 17].join('.')}`],
  ['ipv6', `ssh root@${['2a01', '4f8', 'c17', HEX(4, 3)].join(':')}::1`],
  ['private-key', `${['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ')}\n${B64(64, 4)}\n`],
  ['private-key', `"${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\\n${B64(64, 5)}\\n"`],
  ['private-key', `${['PuTTY-User-Key-File-3', ' ssh-ed25519'].join(':')}\nPrivate-Lines: 1\n${B64(44, 6)}`],
  ['private-key', ['AGE-SECRET-KEY-1', pseudoRandom(58, 8, 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L')].join('')],
  ['token', `export GH_TOKEN=${['ghp', R(36, 9)].join('_')}`],
  ['token', `pat ${['github', 'pat', `${R(22, 10)}_${R(59, 11)}`].join('_')}`],
  ['token', `key ${['sk', 'ant', 'api03', R(93, 12)].join('-')}`],
  ['token', `key ${['sk', 'proj', R(48, 13)].join('-')}`],
  ['token', `grok ${['xai', R(40, 14)].join('-')}`],
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
  ['secret-assign', `app_secret：${R(32, 44)}`],
  ['secret-assign', `| 数据库密码 | ${R(24, 45)} |`],
  ['url-password', `DATABASE_URL=${['postgres://fleet', `${R(20, 25)}@db:5432/fleet`].join(':')}`],
  ['webhook', `${['https://open.feishu.cn/open-apis/bot/v2/hook', pseudoUuid(26)].join('/')}`],
  [
    'webhook',
    `${['https://hooks.slack.com/services', `T${R(8, 27).toUpperCase()}`, `B${R(8, 28).toUpperCase()}`, R(24, 29)].join('/')}`,
  ],
  ['home-user', `"auto":"${['', 'home', 'zhangsan', '.claude', 'projects'].join('/')}"`],
  ['home-user', `"cwd":"${['', 'home', 'zhangsan', 'work'].join('\\/')}"`],
  ['home-user', ['C:', 'Users', 'zhangsan', 'AppData'].join('\\')],
  ['home-user', `file:///${['C:', 'Users', 'zhangsan', 'x'].join('/')}`],
  ['home-user', `sftp://box${['', 'home', 'zhangsan', 'x'].join('/')}`],
  ['home-user', ['D:', 'zhangsan', 'windsurf-dao'].join('/')],
  ['request-id', `（请求 ID: ${['req', R(24, 30)].join('_')}）`],
  ['account-id', `reclaude org use ${ORG}`],
  ['account-id', `reclaude org switch ${ORG}`],
  ['account-id', `切到 ${ORG} 号组织`],
  ['account-id', `{"orgId": ${ORG}}`],
  // 键名前面用下划线连着前缀（\b 会漏）、驼峰带前缀、命令行参数。
  ['account-id', `ANTHROPIC_ORG_ID=${ORG}`],
  ['account-id', `export CLAUDE_ORG=${ORG}`],
  ['account-id', `{"anthropicOrgId": ${ORG}}`],
  ['account-id', `reclaude --org ${ORG} -p hi`],
  ['account-id', `claude --organization-id=${pseudoUuid(46)}`],
  ['account-id', `FLEET_USER_ID=${pseudoNumber(6, 47)}`],
  ['account-id', `{"organization_uuid": "${pseudoUuid(31)}"}`],
  ['account-id', `组织编号：${ORG}`],
  ['account-id', `from ${['ou', HEX(32, 32)].join('_')}`],
  // 飞书应用编号是 16 位十六进制，平均只有 10 种字符：只有 8 种的真编号也要拦（旧的「少于 10 种算编的」放过两成多）。
  ['account-id', `app_id: ${['cli', pseudoRandom(16, 48, '3a7f09c1')].join('_')}`],
  ['account-id', `${['https://avatars.githubusercontent.com/u', pseudoNumber(8, 33)].join('/')}?v=4`],
  ['account-id', `"client_id": "${['Iv23li', R(14, 34)].join('')}"`],
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
    const text = ['第一行', '第二行', `第三行 ${[51, 38, 4, 17].join('.')}`].join('\n');
    expect(findHits(text).map((h) => [h.rule, h.line])).toEqual([['ipv4', 3]]);
  });
});

describe('形状像、但不算的', () => {
  it.each([
    ['GitHub 隐私邮箱', '12345+someone@users.noreply.github.com'],
    ['不回信的系统地址', 'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>'],
    ['git 远端', 'git clone git@github.com:thoerwink8/fleet-dao.git'],
    ['示例域名', 'someone@example.com · a@b.example.org · x@y.test · z@w.invalid · x@corp.example.com'],
    ['玩具地址和泛称', 'a@b.com_c@d.com · x.y+z@q-r.io · 9x@y.com · a@b.co · user@corp.io'],
    ['systemd 模板单元', 'postgresql@16-main.service · wg-quick@wg-fleet.service'],
    ['npm 包的版本号', '@esbuild-kit/core-utils@3.3.2 · agents-md@builtin · npm i foo@^4.2.1'],
    ['内网和回环', '10.0.0.1 · 172.16.5.4 · 192.168.1.1 · 127.0.0.1 · 0.0.0.0 · 169.254.1.1 · 100.64.0.1'],
    ['文档保留段', '192.0.2.10 · 198.51.100.7 · 203.0.113.9'],
    ['公共 DNS 与惯用示例地址', 'nameserver 1.1.1.1 · ping 8.8.8.8 · 223.5.5.5 · 1.2.3.4'],
    ['版本号不是 IP', 'Temporal 13.18 · 2.1.281.0 · 1.2.3.4.5 · 256.1.1.1 · v4.2.1.9 · 协议版本 5.6.7.8'],
    [
      '不是公网 IPv6',
      '2001:db8::1 · fe80::1 · ::1 · 23:59:59 · 2a01:4f8:: · 3fff:0:1::1 · aa:bb:cc:dd:ee:ff',
    ],
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
      '本仓的系统用户、CI、惯用假名',
      '/home/agent · /home/fleet · /home/fleet-agent-dedicated · /home/fleet-agent-*/x · /home/pilot/.local · /home/runner/work · /home/<服务用户> · /home/$u',
    ],
    [
      '假名字的家目录',
      "env.HOME = '/home/fake-session-user'; · /home/someone/.mirasim · C:\\Users\\Administrator\\x · /Users/alice/x",
    ],
    [
      '网址里的 /users/、/home/ 不是家目录',
      'https://api.github.com/users/github/repos · https://example.org/home/about',
    ],
    [
      '盘符下的系统和工程目录',
      'C:/Windows/System32 · C:/Program Files/x · D:/work/x · C:/tmp/y · D:/agent/z',
    ],
    [
      '组织后面跟人数、账号后面跟状态码',
      '这次组织 200 人参加演练 · 自有档无账号 400 · reclaude org use: · 组织编号在 reclaude 里选',
    ],
    [
      'org 是别的词的一部分、键名只是带着 org 的别的东西',
      'organ_id: 5566 · morgan=7788 · forge_no: 9911 · ORG_COUNT=12 · maxOrgs: 500 · sortOrder: 300 · --organic 4455',
    ],
    [
      '控制台键名、值是说明或变量',
      [
        '密码：至少 12 位，大小写加数字',
        'App Secret：见 1Password 里 fleet-dao 那一条',
        ['App Secret: $', '{{ secrets.FEISHU_APP_SECRET }}'].join(''),
        '密钥：/etc/fleet-dao/app-secret',
        'Primary Key: user_id_fk_12345',
      ].join('\n'),
    ],
    ['占位的编号', 'reclaude org use 1234 · "orgId": 9999 · ou_xxx · "client_id": "Iv1.CLIENT_ID"'],
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

  it('公网 IPv4（内网段的边界两侧都核）', () => {
    const ip = (...parts: number[]) => parts.join('.');
    const publicOnes = [ip(8, 8, 8, 8), ip(172, 32, 0, 1), ip(100, 128, 0, 1), ip(192, 169, 0, 1)];
    expect(publicOnes.map(isPublicIPv4)).toEqual([true, true, true, true]);
    const notPublic = ['172.31.255.255', '100.127.0.1', '224.0.0.1', '256.0.0.1', '1.2.3'];
    expect(notPublic.map(isPublicIPv4)).toEqual([false, false, false, false, false]);
  });

  it('公网 IPv6：全球单播的完整或压缩写法；文档段、链路本地、只有前缀的、不合法的不算', () => {
    // 拼起来写：完整的公网 IPv6 写在源码里，全仓检查会拦这个文件自己。
    const v6 = (...groups: string[]) => groups.join(':');
    const yes = [
      v6('2a01', '4f8', 'c17', '1a2b', '', '1'),
      v6('2606', '4700', '4700', '0', '0', '0', '0', '1111'),
      v6('2400', 'cb00', '2049', '1', '', 'a29f', '1804'),
    ];
    expect(yes.map(isPublicIPv6)).toEqual([true, true, true]);
    const no = ['2001:db8::1', 'fe80::1', '::1', '2a01:4f8::', '2a01:4f8:c17', '2a01::1::2', '3fff:0:1::1'];
    expect(no.map(isPublicIPv6)).toEqual([false, false, false, false, false, false, false]);
  });

  it('占位 UUID', () => {
    expect(isPlaceholderId('00000000-0000-4000-8000-00000000abcd')).toBe(true);
    expect(isPlaceholderId('a1000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isPlaceholderId(pseudoUuid(40))).toBe(false);
  });
});
