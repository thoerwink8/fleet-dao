// 公开仓卫生规则：一段文本里有没有真密钥（凭据）。全仓检查（scan.ts）、推送前的闸（diff.ts）、各包的夹具测试
// 共用这一份。规则看形状加上下文：凭据看前缀或键名（令牌、私钥、口令、webhook 地址这类）。账号、组织编号、邮箱、
// IP、个人目录路径这类「标识」不算泄漏，不拦（创始人 2026-09-28 傍晚拍，specs/169-Fusion形态/需求.md：这类值进
// 公开仓不再拦，GitHub 自带的密钥扫描管真密钥）。
// 明显编出来的值（顺序、重复、带 fake / example 字样、只有头没有正文的私钥）放行；其余按白名单（allowlist.ts）放行。

export type RuleId =
  | 'private-key'
  | 'token'
  | 'jwt'
  | 'secret-assign'
  | 'url-password'
  | 'webhook'
  | 'request-id'
  | 'signature'
  | 'signature-header'
  | 'secret-file';

export interface Rule {
  id: RuleId;
  label: string;
  pattern: RegExp;
  /** 形状对上了但这一处不算：例如内网 IP、示例邮箱、明显是编出来的值。m 是整个匹配（带命名分组）。 */
  harmless?: (match: string, m: RegExpMatchArray) => boolean;
}

export interface Hit {
  rule: RuleId;
  label: string;
  /** 命中的原文。只给程序用（白名单比对），任何输出都不打它。 */
  match: string;
  /** 从 1 起；按文件名判的（secret-file）是 0。 */
  line: number;
}

// —— 编出来的值 ——

/** 值里带这些字样，就是编出来的（示例、占位、测试用）。 */
const FAKE_WORDS =
  /example|placeholder|changeme|change-me|dummy|redacted|fake|test|sample|replay|mock|nope|invalid|pretend|your|xxxx|todo/i;

/** 最长的一段「后一个字符正好是前一个的下一个」（abcdef、123456）。 */
function longestAscendingRun(s: string): number {
  let best = 1;
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    run = s.charCodeAt(i) - s.charCodeAt(i - 1) === 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * 同样的字符组成、同样长的随机串平均有几种不同字符（s 已转小写）。字符种类按出现了哪几类粗估：
 * 全是数字 10 种，全是十六进制 16 种，否则数字 10、字母 26、其余符号 10 加起来。
 */
function expectedDistinct(s: string): number {
  let kinds: number;
  if (/^[0-9]+$/.test(s)) kinds = 10;
  else if (/^[0-9a-f]+$/.test(s)) kinds = 16;
  else kinds = (/[0-9]/.test(s) ? 10 : 0) + (/[a-z]/.test(s) ? 26 : 0) + (/[^0-9a-z]/.test(s) ? 10 : 0);
  return kinds * (1 - (1 - 1 / kinds) ** s.length);
}

/**
 * 一眼是编出来的值：带占位字样；字符太单调（不同字符不到同样随机串平均的一半）；六个以上同一字符连着；
 * 字母表或数字顺序、键盘顺序；同一小段反复（replayreplay）。真随机的密钥几乎不可能这样。
 * 单调按字符种类比，不按固定个数：16 位十六进制（飞书 cli_ 应用编号）平均只有 10 种字符，按「少于 10 种」判会放过三成真编号。
 */
export function isFakeValue(value: string): boolean {
  const s = value.toLowerCase();
  if (s.length === 0 || FAKE_WORDS.test(s)) return true;
  if (new Set(s).size * 2 < expectedDistinct(s)) return true;
  if (/(.)\1{5,}/.test(s) || longestAscendingRun(s) >= 6 || /qwerty|asdfgh|zxcvbn/.test(s)) return true;
  for (let p = 1; p <= Math.min(12, s.length >> 1); p++) {
    let repeats = true;
    for (let i = p; i < s.length && repeats; i++) repeats = s[i] === s[i - p];
    if (repeats) return true;
  }
  return false;
}

/** 一眼是占位的 UUID：00000000-0000- 开头、最多 4 种字符、一半以上是 0。 */
export function isPlaceholderId(id: string): boolean {
  if (/^0{8}-0{4}-/.test(id)) return true;
  const digits = id.toLowerCase().replace(/-/g, '');
  if (new Set(digits).size <= 4) return true;
  return (digits.match(/0/g) ?? []).length * 2 >= digits.length;
}

/**
 * 键名像密钥的赋值里，值像不像真密钥：够长；不是路径 / 变量 / 网址 / 代码里的成员访问；
 * 有字母，并且有数字、或者大小写加符号都有（_ . - 是标识符里的连接符，不算符号）；不是编出来的。
 */
/** 像文件路径：/、./、~/ 开头，每一段都是全小写、全大写或很短的词（/etc/fleet-dao/webhook-secret）。随机串开头碰巧是 / 的不算。 */
function looksLikePath(v: string): boolean {
  const rest = /^(?:~|\.{1,2})?\/(.*)$/.exec(v)?.[1];
  if (rest === undefined) return false;
  return rest
    .split('/')
    .filter(Boolean)
    .every((seg) => /^[a-z0-9_.-]+$/.test(seg) || /^[A-Z0-9_.-]+$/.test(seg) || seg.length <= 4);
}

function looksLikeRealSecret(raw: string): boolean {
  const v = raw.replace(/^["'`]|["'`]$/g, '');
  if (v.length < 12) return false;
  if (/^[$%{<\\]|^[a-z][a-z0-9+.-]*:\/\//i.test(v) || looksLikePath(v)) return false;
  // 代码：模板插值、调用、括号、成员访问（process.env.X）。
  if (/\$\{|[(){}[\]<>,;]/.test(v) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return false;
  // 人起的名字：三段以上的小写短词用 - _ . 连起来（e2e-not-a-token、cache_read_input_tokens）。
  const words = v.split(/[-_.]/);
  if (
    words.length >= 3 &&
    words.every((w) => /^[a-z0-9]{0,10}$/.test(w) && (w.match(/\d/g) ?? []).length <= 1)
  )
    return false;
  const mixed = /[a-z]/.test(v) && /[A-Z]/.test(v) && /[^A-Za-z0-9_.-]/.test(v);
  // 纯字母的随机串：大小写各占四分之一以上（驼峰写法的名字大写少得多）。
  const upper = (v.match(/[A-Z]/g) ?? []).length;
  const lower = (v.match(/[a-z]/g) ?? []).length;
  const randomCase = v.length >= 16 && upper * 4 >= v.length && lower * 4 >= v.length;
  if (!/[A-Za-z]/.test(v) || !(/[0-9]/.test(v) || mixed || randomCase)) return false;
  return !isFakeValue(v);
}

// —— 私钥 ——

/** PEM 头后面第一段 base64 正文（跳过 Proc-Type 这类头字段；JSON 里的 \n 也当换行）。 */
const PEM_BODY =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\\[rn]|\s)*(?:(?:Proc-Type|DEK-Info|Version|Comment|Charset|Hash):[^\n\\]*(?:\\[rn]|\s)+)*(?<value>[A-Za-z0-9+/=]{40,})/g;

// —— 令牌 ——

const TOKEN_PREFIX =
  /^(?:gh[pousr]_|github_pat_|sk-ant-(?:[a-z]+\d+-)?|sk-(?:proj-|svcacct-|admin-)?|xai-|AKIA|xox[abprs]-|xapp-\d-|AIza|glpat-|npm_|tvly-|rck_|\d{6,10}:|Bearer\s+)/;

// —— 键名像密钥 ——

/** 键名的最后一段是这些词之一才算（tokenizer、max_tokens、passwordHash 不算）。 */
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*?(?:password|passwd|passphrase|pwd|secret|token|(?:api|app|access|private|secret|client|signing|encrypt(?:ion)?|master)[_.-]?key|credentials?)(?![A-Za-z0-9_])`;

/** 空格隔开的英文键名（控制台里抄来的 App Secret、Verification Token、Secret Access Key、AccessKey Secret）。 */
const SECRET_KEY_SPACED = String.raw`(?:(?:app|client|api|access|accesskey|secret|private|signing|encrypt(?:ion)?|master|bot|verification)[ \t]+){1,2}(?:secret|key|token)(?![A-Za-z0-9_])`;

/** 中文键名：密钥、秘钥、私钥、密码、口令、令牌（前面带什么都行：飞书应用密钥、数据库密码）。 */
const SECRET_KEY_CN = String.raw`(?:密钥|秘钥|私钥|密码|口令|令牌)`;

const secretAssign = (label: string, source: string, flags: string): Rule => ({
  id: 'secret-assign',
  label,
  pattern: new RegExp(source, flags),
  harmless: (_match, m) => !looksLikeRealSecret(m.groups?.value ?? ''),
});

export const RULES: readonly Rule[] = [
  {
    // 只认带正文的：只有头（测试里判 PEM 格式的）、正文是编出来的，都不算。
    id: 'private-key',
    label: '私钥',
    pattern: PEM_BODY,
    harmless: (_match, m) => isFakeValue(m.groups?.value ?? ''),
  },
  {
    id: 'private-key',
    label: '私钥',
    pattern:
      /PuTTY-User-Key-File-\d+:[\s\S]{0,2000}?Private-Lines:\s*\d+(?:\\[rn]|\s)+(?<value>[A-Za-z0-9+/=]{20,})/g,
    harmless: (_match, m) => isFakeValue(m.groups?.value ?? ''),
  },
  {
    id: 'private-key',
    label: '私钥',
    pattern: /\bAGE-SECRET-KEY-1(?<value>[0-9A-Z]{58})\b/g,
    harmless: (_match, m) => isFakeValue(m.groups?.value ?? ''),
  },
  {
    // 各家有固定前缀的令牌；Telegram 机器人令牌（编号:AA…）；Authorization 里的 Bearer 不透明令牌。
    id: 'token',
    label: '令牌',
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{22,}|sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|tvly-[A-Za-z0-9_-]{20,}|rck_[A-Za-z0-9_-]{20,}|\d{6,10}:AA[0-9A-Za-z_-]{30,}|Bearer\s+[A-Za-z0-9._~+/-]{20,}=*)/g,
    harmless: (token) => isFakeValue(token.replace(TOKEN_PREFIX, '')),
  },
  {
    id: 'jwt',
    label: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/g,
  },
  // 没有固定前缀的密钥（飞书 app secret、数据库密码、webhook 密钥……）：键名的最后一段像密钥，值又像随机串。
  // 五种写法：带引号的（JSON、YAML、代码）、行首不带引号的（env 大小写都算、YAML、ini）、命令行参数、Markdown 表格，
  // 以及控制台抄来的「App Secret：值」「应用密钥：值」（空格隔开的英文键名、中文键名，全角冒号也算）。
  secretAssign(
    '像密钥的赋值',
    String.raw`\b${SECRET_KEY}["']?\s*[:=：＝]\s*["'\x60](?<value>[^"'\x60\s]{12,})["'\x60]`,
    'gi',
  ),
  secretAssign(
    '像密钥的赋值',
    String.raw`^[ \t]*(?:export[ \t]+|set[ \t]+|-[ \t]+)?["']?${SECRET_KEY}["']?[ \t]*[:=：＝][ \t]*(?<value>[^\s"'\x60(){}\[\],;<>]{12,})[ \t]*(?:#.*)?$`,
    'gim',
  ),
  secretAssign(
    '像密钥的命令行参数',
    String.raw`(?:^|\s)--${SECRET_KEY}(?:=|[ \t]+)["']?(?<value>[^\s"'\x60]{12,})`,
    'gim',
  ),
  secretAssign(
    '表格里像密钥的值',
    String.raw`\|[ \t]*\x60?(?:${SECRET_KEY}|${SECRET_KEY_SPACED}|[^|\n]{0,20}?${SECRET_KEY_CN})\x60?[ \t]*\|[ \t]*\x60?(?<value>[^\s|\x60]{12,})\x60?[ \t]*\|`,
    'gi',
  ),
  // 「是」「为」连着的（应用密钥是 值）也算；值只收 ASCII：密钥不会带中文，中文说明（密钥是在控制台生成的）不算值。
  secretAssign(
    '像密钥的赋值',
    String.raw`(?:(?<![A-Za-z0-9_])${SECRET_KEY_SPACED}|${SECRET_KEY_CN})(?:\*\*|\x60)?(?:[ \t]*[:=：＝]|[ \t]*[是为])[ \t]*["'\x60“‘]?(?<value>[^\s"'\x60“”‘’（）()，。；、,;<>|*\u0080-￿]{12,})`,
    'gi',
  ),
  {
    // 连接串里带的密码：postgres://用户:<密码>@主机/库。密码是变量、占位、和用户名一样的开发默认值，不算。
    id: 'url-password',
    label: '网址里的密码',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/(?<user>[^/\s:@'"<>]+):(?<value>[^@\s/'"<>]+)@/gi,
    harmless: (_match, m) => {
      const password = m.groups?.value ?? '';
      return (
        password === m.groups?.user ||
        /^[$%{]/.test(password) ||
        /^(?:password|passwd|pass|secret|admin|root|postgres|changeme)$/i.test(password) ||
        FAKE_WORDS.test(password)
      );
    },
  },
  {
    // 发消息的 webhook 地址：地址本身就是凭据。
    id: 'webhook',
    label: 'webhook 地址',
    pattern:
      /\b(?:open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/(?<feishu>[0-9A-Za-z-]{16,})|hooks\.slack\.com\/(?:services|workflows|triggers)\/(?<slack>[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]{8,})|discord(?:app)?\.com\/api\/webhooks\/\d{6,}\/(?<discord>[A-Za-z0-9_-]{20,})|oapi\.dingtalk\.com\/robot\/send\?access_token=(?<dingtalk>[0-9a-f]{20,})|qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=(?<wecom>[0-9a-f-]{20,})|api\.telegram\.org\/bot(?<telegram>\d{6,}:[A-Za-z0-9_-]{20,}))/g,
    harmless: (_match, m) => {
      const id = Object.values(m.groups ?? {}).find((v) => v !== undefined) ?? '';
      return isFakeValue(id.replace(/[-/]/g, '')) || isPlaceholderId(id);
    },
  },
  {
    // 上游给每次请求起的编号：拿去问上游能对上账号。
    id: 'request-id',
    label: '请求编号',
    pattern: /\breq_[A-Za-z0-9]{8,}|\brequest[ _-]?id["']?\s*[:=：]\s*["']?[0-9a-f]{16,}/gi,
  },
  {
    // Claude 的 thinking signature 里编着账号级编号，必须打码。git 提交的 PGP / SSH 签名本来就公开，不算。
    id: 'signature',
    label: '没打码的 signature',
    pattern: /"signature"\s*:\s*"(?!<redacted>")(?<value>[^"]+)"/gi,
    harmless: (_match, m) => /^-----BEGIN (?:PGP|SSH) SIGNATURE-----/.test(m.groups?.value ?? ''),
  },
  {
    id: 'signature-header',
    label: '签名头',
    pattern: /\bx-[a-z-]*signature\b\s*[:=]\s*(?<value>[A-Za-z0-9+/=_-]{8,})/gi,
    harmless: (_match, m) => isFakeValue(m.groups?.value ?? ''),
  },
];

// —— 按文件名 ——

export interface SecretFileRule {
  /** 报出来的名字，例如 *.pass。 */
  name: string;
  /** 对相对仓库根的路径判（不分大小写）。 */
  pattern: RegExp;
  /** 这条规则一定要拦下的样例路径：测试逐条核它被拦、也被 .gitignore 的密钥名单那一段忽略。 */
  sample: string;
  harmless?: (path: string) => boolean;
}

/**
 * 按文件名就知道是密钥、密钥备份或保险箱钥匙的：.gitignore 里标记圈出来的那一段是同一张名单，
 * 这里管「被 git add -f 强行提交」的。二进制的（.p12、.kdbx、.age）也按名字拦，不看内容。
 */
export const SECRET_FILES: readonly SecretFileRule[] = [
  { name: '.secrets/', pattern: /(?:^|\/)\.secrets\//i, sample: '.secrets/vault.pass' },
  { name: '*.pass', pattern: /\.pass$/i, sample: 'deploy/db.pass' },
  { name: '*.key', pattern: /\.key$/i, sample: 'deploy/github-app.key' },
  { name: '*.pem', pattern: /\.pem$/i, sample: 'deploy/github-app.pem' },
  { name: 'vault-key.txt', pattern: /(?:^|\/)vault-key\.txt$/i, sample: 'backup/vault-key.txt' },
  { name: '*.age', pattern: /\.age$/i, sample: 'backup/etc-fleet-dao.tar.age' },
  { name: '*.p12 / *.pfx', pattern: /\.(?:p12|pfx)$/i, sample: 'deploy/cert.p12' },
  { name: '*.ppk', pattern: /\.ppk$/i, sample: 'deploy/putty.ppk' },
  { name: '*.kdbx', pattern: /\.kdbx$/i, sample: 'backup/vault.kdbx' },
  { name: '*.jks / *.keystore', pattern: /\.(?:jks|keystore)$/i, sample: 'deploy/app.keystore' },
  {
    name: 'SSH 私钥',
    pattern: /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i,
    sample: 'deploy/id_ed25519',
  },
  {
    name: '.env',
    pattern: /(?:^|\/)\.env(?:\.[^/]+)?$/i,
    sample: 'packages/api/.env.production',
    // 样例文件（.env.example 之类）本来就是给人抄的，里面的内容照样过内容规则。
    harmless: (path) => /\.env\.(?:example|sample|template)$/i.test(path),
  },
  { name: '.pgpass / .netrc', pattern: /(?:^|\/)\.(?:pgpass|netrc)$/i, sample: 'deploy/.pgpass' },
  { name: '.credentials.json', pattern: /(?:^|\/)\.credentials\.json$/i, sample: 'backup/.credentials.json' },
];

/** 这个路径按文件名看是不是密钥文件；是就给出一条命中（行号 0）。 */
export function findSecretFile(path: string): Hit | undefined {
  const rule = SECRET_FILES.find((r) => r.pattern.test(path) && !r.harmless?.(path));
  return rule && { rule: 'secret-file', label: '密钥文件', match: rule.name, line: 0 };
}

// —— 逐段扫 ——

/** 文本里第几个字符在第几行（从 1 起）。 */
export function lineLocator(text: string): (index: number) => number {
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** 一段文本里命中的所有规则（已去掉形状对上但无害的）。同一类规则的几种写法对上同一处（范围有重叠），只算一条。 */
export function findHits(text: string, rules: readonly Rule[] = RULES): Hit[] {
  const lineOf = lineLocator(text);
  const hits: Hit[] = [];
  const taken = new Map<RuleId, [number, number][]>();
  for (const rule of rules) {
    const spans = taken.get(rule.id) ?? [];
    taken.set(rule.id, spans);
    for (const m of text.matchAll(rule.pattern)) {
      if (rule.harmless?.(m[0], m)) continue;
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (spans.some(([s, e]) => start < e && s < end)) continue;
      spans.push([start, end]);
      hits.push({ rule: rule.id, label: rule.label, match: m[0], line: lineOf(start) });
    }
  }
  return hits;
}
