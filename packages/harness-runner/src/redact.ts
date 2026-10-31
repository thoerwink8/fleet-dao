// 脱敏（旧坑 H1：列进程带命令行把飞书密钥打进日志，出过两次）。日志、错误信息、子进程 stderr、工具输出、
// 事件表、补丁，凡是从运行层出去的文字都先过它。两道：已知密钥的原值，加常见令牌的样子。

const MASK = '***';

/** 认得出样子的令牌：GitHub、OpenAI 类 sk-、Slack、AWS、Bearer 头、私钥块。 */
const PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi;

/** 环境变量名像密钥的（TOKEN、SECRET、KEY、PASSWORD……）就把它的值当已知密钥。太短的不算，免得把常见词打码。 */
const SECRET_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|COOKIE|AUTH)/i;
const MIN_SECRET_CHARS = 8;

export function secretsFromEnv(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= MIN_SECRET_CHARS && SECRET_NAME.test(name)) out.push(value);
  }
  return out;
}

export type Redactor = (text: string) => string;

export function makeRedactor(secrets: Iterable<string>): Redactor {
  // 长的先换：一个密钥是另一个的前缀时，先换短的会留下尾巴
  const known = [...new Set([...secrets].filter((s) => s.length >= MIN_SECRET_CHARS))].sort(
    (a, b) => b.length - a.length,
  );
  return (text) => {
    let out = text;
    for (const s of known) out = out.split(s).join(MASK);
    for (const p of PATTERNS) out = out.replace(p, MASK);
    return out.replace(BEARER, `$1${MASK}`);
  };
}
