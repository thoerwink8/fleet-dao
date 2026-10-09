// 把命令行里的密钥值打码（agents-sync 和调工具前钩子 pretool.mjs 一起装进 ~/.fleet-dao/hooks/）。
//
// 这是给「命令的输出」准备的，不是给「命令本身」准备的：命令行把口令当参数交给别的进程之后，口令就落在那个进程的
// /proc/<pid>/cmdline 和 Windows 的 Win32_Process.CommandLine 里（进程的整个命令行是公开的，谁都能读）；
// 打印进程命令行（ps -ef、ps aux、/proc/*/cmdline、wmic process、Get-CimInstance Win32_Process …）就等于把它们原样打进对话。
// 出过两次（docs/ops.md 第九节「值不过屏幕」）：
//  ① 2026-09-30 读 C:/Users/Administrator/.mirasim/mcp-runtime/claude-*.json——飞书的 app secret 写在文件的参数里，
//     当时那套遮值只认 40 个字符以上的串，32 个字符的密钥就这么过去了；
//  ② 2026-10-02 跑一条列进程命令行的 PowerShell（Get-CimInstance Win32_Process … CommandLine）看 MCP 服务起了没，
//     lark-mcp 那行命令里的 -s <secret> 整段打了进来。
// 所以打印进程命令行时，输出接一条管道过这里：agents/hooks/redact-secrets.mjs（pretool.mjs 会拦着不接的不给过）。
//
// 只打码、不判真假：拿不准就遮，遮多了最多是看不见一个日志路径，遮少了就是密钥进对话。
// 打码留下的样子是键名照旧、值变成 ***（引号原样留着），方便一眼看出这里被遮了。
// 这是安全网、不是保险箱：认不出的写法（变量展开出来的、编码过的、拼成一长串看不出是值的）照样漏。
// 失败的口径在 redact-secrets.mjs 那边：读不了、认不出就返回明确的失败，不拿空当当没事。

/**
 * 长写法的参数名里一定有这几个词之一才算（--secret、--db-password、--feishu-app-secret、--auth-token……）。
 * 名字里带这些词的参数一律遮：遮错一个（把 --token-timeout、--secretly 这类同前缀的值也遮了）的代价是
 * 屏幕上少几个字，漏遮一个的代价是密钥进对话。`--key`、`--key-file` 不在这里面（--key 在 curl、openssl 里
 * 指的是别的东西，遮了会把平常命令弄乱；名字里带 key 的字段由 JSON 那一条管）。
 */
const FLAG_SECRET_WORD = /(?:secret|token|password|passwd|passphrase|credential|bearer|api-?key)/i;

/**
 * 单字母写法：`-s`、`-p` 后面接的东西一律遮，除了 plainly 不是密钥的那几种形状（见 isPlainShortValue）：
 * -s 正是 2026-10-02 那次的样子（lark-mcp -s <secret>）。别的单字母参数（-f、-n、-e 之类）一个不碰。
 */
const SHORT_FLAGS = ['s', 'p'];

/**
 * 单字母参数的值里「明摆着不是密钥」的几种：pid、信号名、路径、主机名、时间戳、变量引用。
 * 判准是「这一整段没有任何像密钥的字符」——一个字母数字混排的短串（-p hunter2、-s SECRET32CHARS）不在这里面，
 * 一律遮。反过来只认这几种死形状，判错的代价是多遮一段路径（屏幕上难看一点），不是漏一个密钥。
 */
const PLAIN_SHORT_VALUE = [
  /^\d+$/, // ps -p 1234、date -s 1700000000
  /^[A-Z]{2,}$/, // 信号名：timeout -s KILL、kill -s TERM
  /^[-+]?\d+(?:\.\d+)?%$/, // date -s -1% 之类的相对写法
  /^(?:[~/]|[A-Za-z]:[\\/])[^\s]*$/, // 路径：-s /etc/fstab、-p ~/x、-p C:\x、-p ./x
  /^[a-z][a-z0-9._-]*@[a-z0-9.-]+$/i, // user@host
  /^\$[\w{()}:.-]+$|^%(?:\w+)%$/, // $HOME、${HOME}、%USERPROFILE%
];
const isPlainShortValue = (v) => v !== '' && PLAIN_SHORT_VALUE.some((re) => re.test(v));

/** 打码之后留下的样子 */
const MASK = '***';

/**
 * 键名里带这些词、值又是字符串的，就是密钥字段：clientSecret、refresh_token、password……
 * 键名本身照打、值换成 ***。不碰光叫 key、name、id、value 的：`"key": "..."` 在配置里满处都是。
 */
const SECRET_KEYWORD = /(?:api|private|access|secret|signing|encryption|session|master|storage|host|ssh)/i;

/** 这个键名算不算密钥字段：带 secret/token/password 这类词的算；裸 key 看有没有 api / private / access 这类前缀 */
function isSecretKey(name) {
  if (/(?:secret|token|password|passwd|passphrase|credential|bearer)/i.test(name)) return true;
  return /key/i.test(name) && name.toLowerCase() !== 'key' && SECRET_KEYWORD.test(name);
}

/** 值从 at 开始：引号里的读到配对的引号（含引号），没引号的读到空白或 ; | & < > ` 为止（不含） */
function valueEnd(text, at) {
  if (at >= text.length) return at;
  const open = text[at];
  if (open === '\\') return at + 1 < text.length ? at + 2 : at + 1; // 转义过的单字符
  if (open !== '"' && open !== "'" && open !== '`') {
    let j = at;
    while (j < text.length && !/[\s|&;<>`]/.test(text[j])) j++;
    return j;
  }
  let j = at + 1;
  while (j < text.length) {
    if (text[j] === '\\') {
      j += 2;
      continue;
    }
    if (text[j] === open) return j + 1;
    j++;
  }
  return text.length; // 引号没收尾：遮到行尾（宁可多遮）
}

/** 值本体（不带引号） */
function bareValue(raw) {
  const s = String(raw);
  const q = s[0];
  return q === '"' || q === "'" || q === '`' ? s.slice(1, s.endsWith(q) ? -1 : undefined) : s;
}

/**
 * 一个参数键名：值写在哪、值前面留什么。返回 null = 这个键名后面没有值（不是这个参数，一个字别动）。
 * - `--secret=v`：值在 = 后面，屏幕上留 `--secret=`
 * - `--secret v` / `-s v`：值在后面那个词，屏幕上留原来的空格
 * - `--secret "a b"`：值是被引起来的整段，屏幕上留那个开引号
 * - `--secret --other` / `--password`：后面是另一个参数或者没有下文，等于没有值
 */
function valueAt(text, nameEnd) {
  const sep = text[nameEnd];
  if (sep === undefined) return null;
  if (sep !== ' ' && sep !== '\t' && sep !== '=' && sep !== "'" && sep !== '"') return null; // 键名后面直接接别的字符（--secretly、-o）：不是这个参数
  let at = nameEnd;
  let glue = '';
  if (sep === ' ' || sep === '\t') {
    while (text[at] === ' ' || text[at] === '\t') at++; // 空格一个不动
    glue = text.slice(nameEnd, at);
  } else if (sep === '=') {
    at++;
    glue = '=';
  }
  if (text[at] === undefined || /[\s|&;<>]$/.test(text[at])) return null;
  if ((text[at] === '-' && /[\s=]/.test(text[at + 1] ?? '')) || text[at] === '-') return null; // 值位上是另一个参数
  const end = valueEnd(text, at);
  const raw = text.slice(at, end);
  return raw === '' ? null : { raw, at, end, glue };
}

/** 一条命中：键名、值、值前面留着的那几个字符、值到哪结束。keep 是给长写法的过滤器（名字里要带那几个词） */
function hits(text, re, isShort, keep = () => true) {
  const out = [];
  for (const m of text.matchAll(re)) {
    if (!keep(m[0])) continue;
    const v = valueAt(text, m.index + m[0].length);
    if (v !== null) out.push({ ...v, from: m.index, name: m[0], isShort });
  }
  return out;
}

/**
 * 命令行里的长/短参数：键名原样留着，值换成 ***（分界符、空格一个不动）。
 * 长写法（--db-password 这种带前缀的也算）不分大小写；单字母写法分大小写——`-S`、`-P` 是别人的参数
 * （sort -S 缓冲大小、grep -P 正则），拿它当 -s、-p 遮掉是误伤。两条各扫各的，再按位置合起来。
 */
function maskFlags(text) {
  const long = /(?<![\w-])--[a-z0-9][a-z0-9-]*(?![A-Za-z0-9-])/gi;
  const short = new RegExp(String.raw`(?<![\w-])-(?:${SHORT_FLAGS.join('|')})(?![A-Za-z0-9-])`, 'g');
  const all = [
    ...hits(text, long, false, (name) => FLAG_SECRET_WORD.test(name)),
    ...hits(text, short, true),
  ].sort((a, b) => a.from - b.from);
  let out = '';
  let i = 0;
  for (const m of all) {
    if (m.from < i) continue; // 已经遮过的那段里头的，跳过
    const keep = m.isShort && isPlainShortValue(bareValue(m.raw));
    out += text.slice(i, m.from) + m.name + m.glue + (keep ? m.raw : MASK);
    i = m.end;
  }
  return out + text.slice(i);
}

/** JSON / 键值对里夹着的密钥字段（--secret VALUE 那套管不到）：键名照打，值换成 ***（引号原样留着） */
function maskJsonFields(text) {
  return text.replace(
    /(?<key>"[A-Za-z0-9_.-]*"[ \t]*:[ \t]*)"(?<value>(?:\\.|[^"\\\n])*)"/g,
    (match, key) => {
      const name = key.slice(1, key.indexOf('"', 1));
      if (!isSecretKey(name)) return match;
      return `${key}"${MASK}"`;
    },
  );
}

/**
 * URL 查询参数里的令牌（#1148）：mirasim 启动时把 `http://localhost:4318/?token=<令牌>` 整条打进 journalctl，
 * 谁读日志谁就拿到能登录这台机器上 AI 会话的令牌。参数名（? 或 & 后面、= 前面）是下面这几类才遮：
 * 名字里带 token / secret / password / passwd / pwd / api_key / apikey 的（access_token、refresh_token、client_secret……），
 * 或者整个名字就是 key（`?key=` 只在 URL 查询里才认，别处的 key 满处都是）。名字不分大小写，_ 和 - 都认。
 * 值：8 位以上的字母数字加 . _ ~ + / = - %（% 是为了百分号编码过的令牌也一并遮掉），到第一个不属于这些的字符为止。
 * 8 位以下的值不遮（?key=en、?token=1 这类不是令牌，遮了只会把日志弄乱）。
 */
const URL_PARAM_NAME = `(?:[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key)[A-Za-z0-9_.-]*|key)`;
const URL_TOKEN_PARAM = new RegExp(`(?<head>[?&]${URL_PARAM_NAME}=)[A-Za-z0-9._~+/=%-]{8,}`, 'gi');

/** URL 查询参数里的令牌：参数名和 URL 其余部分照旧，值换成 *** */
function maskUrlTokens(text) {
  return text.replace(URL_TOKEN_PARAM, (_m, head) => `${head}${MASK}`);
}

/**
 * 把一段文字里的密钥值换成 ***。纯函数：同样的输入永远同样的输出，不改入参。
 * 遮的是：`-s VALUE`、`--secret VALUE`、`--secret=VALUE`、`-p VALUE`、`--token VALUE`、`--password VALUE`，
 * 名字带 secret/token/password/credential/key 的 JSON 字段（"clientSecret": "…"），
 * URL 查询里的 `?token=…`、`&access_token=…`、`&api_key=…`、`?key=…`、`secret`、`password`（见 URL_TOKEN_PARAM）。
 * 不遮：值像路径、pid、主机名的单字母参数（ps -p 1234），别的文字一个字不改。
 * 认不出的形状（参数名本身被百分号编码、令牌被换行拆开、不满 8 位的值）一个字不改——也就是说
 * 「没改」不等于「没有令牌」：hasSecretValue 只说「这里遮过」，不说「这里干净」。
 */
export function redactText(text) {
  const s = String(text);
  if (s === '') return s;
  return maskUrlTokens(maskJsonFields(maskFlags(s)));
}

/** 一行一行过（命令行的输出按行给的）：整段的换行怎么进怎么出 */
export function redactLines(text) {
  return String(text)
    .split('\n')
    .map((line) => redactText(line))
    .join('\n');
}

/** 一串文字里有没有认得出、能被打码的值（钩子和自检用）。false 只表示「没认出」，不表示「里面没有密钥」 */
export function hasSecretValue(text) {
  return redactText(text) !== String(text);
}
