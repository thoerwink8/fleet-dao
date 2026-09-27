// 安全查看密钥文件的结构（agents-sync 和调工具前钩子 pretool.mjs 一起装进 ~/.fleet-dao/hooks/）：
// 每个字段只打名字、类型、长度，一个值都不打，也不按字段名猜哪些敏感——2026-09-27 那次就是按名字猜着遮值，漏了两个。
// 认 JSON、env（KEY=VALUE，只认文件名是 .env、*.env、.env.* 的：别的文件按 env 读，口令里的 = 前半截会被当成键名打出来）、
// PEM（只数有几块、各是什么）。读不了、认不出就明说、退出码 1，不打空。
// 用法：node secret-shape.mjs <文件>…（最后一段带 * ? 的自己展开：PowerShell 不替原生命令展开通配）
// 别的机器上的文件：cat secret-shape.mjs | ssh <机器> 'node --input-type=module - <文件>…'
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_LINES = 400;
const MAX_ITEMS = 20;
const MAX_DEPTH = 12;

/** JSON 键名只打像字段名的（字母、下划线、连字符）；带数字、点、空格、@ 的多半是数据（路径、编号、邮箱），只打第几个、多长 */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z_-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME = /(?:^\.env(?:\..+)?|\.env)$/i;
const PEM_LINE = /^-----(BEGIN|END) ([A-Z0-9 ]+)-----$/;

const chars = (s) => [...s].length;

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  return { string: '字符串', number: '数字', boolean: '布尔', object: '对象' }[typeof v] ?? typeof v;
}

/** JSON 值的结构：一行一个字段「路径：类型，长度 N」。数字、布尔、null 只打类型：长度也会漏值（true 4 个字、false 5 个） */
export function describeJson(root) {
  const out = [];
  let cut = false;
  const walk = (v, path, depth) => {
    if (out.length >= MAX_LINES) {
      cut = true;
      return;
    }
    const at = path || '（整份）';
    if (typeof v === 'string') out.push(`${at}：字符串，长度 ${chars(v)}`);
    else if (v === null || typeof v !== 'object') out.push(`${at}：${kindOf(v)}`);
    else if (Array.isArray(v)) {
      out.push(`${at}：数组，${v.length} 个元素`);
      if (v.length > 0 && depth >= MAX_DEPTH) out.push(`${at}[…]：更深的不列`);
      else {
        for (const [i, x] of v.slice(0, MAX_ITEMS).entries()) walk(x, `${path}[${i}]`, depth + 1);
        if (v.length > MAX_ITEMS) out.push(`${path}[${MAX_ITEMS}…]：还有 ${v.length - MAX_ITEMS} 个元素没列`);
      }
    } else {
      const keys = Object.keys(v);
      out.push(`${at}：对象，${keys.length} 个字段`);
      if (keys.length > 0 && depth >= MAX_DEPTH) out.push(`${at}.…：更深的不列`);
      else
        keys.forEach((k, i) => {
          const seg = PLAIN_KEY.test(k)
            ? `${path ? `${path}.` : ''}${k}`
            : `${path}[第 ${i + 1} 个键，键名 ${chars(k)} 个字，不打]`;
          walk(v[k], seg, depth + 1);
        });
    }
  };
  walk(root, '', 0);
  if (cut) out.push(`……超过 ${MAX_LINES} 行，后面的没列`);
  return out;
}

/** JSON.parse 的报错会带上原文片段（新版 V8：Unexpected token … "原文" is not valid JSON）：只取出位置，原文一个字不打 */
function jsonWhere(text, err) {
  const msg = String(err?.message ?? '');
  const lc = /line (\d+) column (\d+)/.exec(msg);
  if (lc) return `（第 ${lc[1]} 行第 ${lc[2]} 列附近）`;
  const pos = /position (\d+)/.exec(msg);
  if (!pos) return '';
  const before = text.slice(0, Number(pos[1]));
  const line = before.split('\n').length;
  return `（第 ${line} 行第 ${before.length - before.lastIndexOf('\n')} 列附近）`;
}

function envValue(s) {
  const r = s.trim();
  if (r.startsWith('"') || r.startsWith("'")) {
    const q = r[0];
    let v = '';
    let j = 1;
    while (j < r.length && r[j] !== q) {
      if (q === '"' && r[j] === '\\' && j + 1 < r.length) {
        v += r[j + 1];
        j += 2;
      } else v += r[j++];
    }
    if (j >= r.length) return null;
    const tail = r.slice(j + 1).trim();
    return tail === '' || tail.startsWith('#') ? v : null;
  }
  const hash = r.search(/\s#/);
  return (hash >= 0 ? r.slice(0, hash) : r).trim();
}

/** env 文件：每个键一行「KEY：字符串，长度 N」。有一行认不出就整份不认，只报第几行，不打那一行 */
export function describeEnv(text) {
  const out = [];
  const bad = [];
  text.split('\n').forEach((raw, i) => {
    const t = raw.replace(/\r$/, '').trim();
    if (t === '' || t.startsWith('#') || t.startsWith(';')) return;
    const m = /^(?:export\s+)?([^=\s]+)\s*=(.*)$/.exec(t);
    const v = m && ENV_KEY.test(m[1] ?? '') ? envValue(m[2] ?? '') : null;
    if (v === null) bad.push(i + 1);
    else out.push(`${m[1]}：字符串，长度 ${chars(v)}`);
  });
  if (bad.length > 0) {
    const more = bad.length > 10 ? `，一共 ${bad.length} 行` : '';
    return { error: `第 ${bad.slice(0, 10).join('、')} 行认不出（不是 KEY=VALUE、# 注释或空行）${more}` };
  }
  return { lines: out.length > 0 ? out : ['（空：0 个字段）'] };
}

/** PEM：只数有几块、各是什么（证书还是私钥），正文不打 */
function describePem(text) {
  const counts = new Map();
  let open = null;
  for (const raw of text.split('\n')) {
    const m = PEM_LINE.exec(raw.trim());
    if (!m) continue;
    if (m[1] === 'BEGIN') {
      if (open !== null) return { error: `「${open}」那一块没收尾就开了下一块` };
      open = m[2];
    } else {
      if (open !== m[2]) return { error: '块的头尾对不上' };
      counts.set(open, (counts.get(open) ?? 0) + 1);
      open = null;
    }
  }
  if (open !== null) return { error: `「${open}」那一块没收尾` };
  if (counts.size === 0) return { error: '开头像 PEM，可一块都认不出' };
  return { lines: [...counts].map(([label, n]) => `${label}：${n} 块`) };
}

/** 一份文件的结构；认不出返回 { error }（只说为什么，不带原文） */
export function shapeOf(name, text) {
  if (text.includes('\u0000')) return { error: '是二进制文件，认不出（只认 JSON、env、PEM）' };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // 去掉 BOM
  const head = body.trimStart();
  if (/\.json$/i.test(name) || head.startsWith('{') || head.startsWith('[')) {
    try {
      return { kind: 'JSON', lines: describeJson(JSON.parse(body)) };
    } catch (err) {
      return { error: `不是合法的 JSON${jsonWhere(body, err)}` };
    }
  }
  if (ENV_NAME.test(basename(name))) return { kind: 'env', ...describeEnv(body) };
  if (head.startsWith('-----BEGIN ')) return { kind: 'PEM', ...describePem(body) };
  return {
    error:
      '认不出格式：只认 JSON、env（文件名是 .env、*.env、.env.*）、PEM；别的文件按 KEY=VALUE 读会把口令的前半截当键名打出来，不读。要看大小、权限用 stat',
  };
}

/** 展开 ~、$HOME、%USERPROFILE%，和最后一段里的 * ?（PowerShell 不替原生命令展开） */
export function expand(arg, home = homedir()) {
  const p = arg.replace(/^(?:~|\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE)(?=$|[\\/])/i, () => home);
  const dir = dirname(p);
  const pattern = basename(p);
  if (!/[*?]/.test(p)) return { files: [p] };
  if (/[*?]/.test(dir)) return { error: '通配只认最后一段（dir/*.json），前面几段要写死' };
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    return { error: `读不了目录 ${dir}（${err?.code ?? err}）` };
  }
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    process.platform === 'win32' ? 'i' : '',
  );
  const files = names
    .filter((n) => re.test(n))
    .sort()
    .map((n) => join(dir, n));
  return files.length > 0 ? { files } : { error: `${arg} 没有匹配的文件` };
}

/** 命令行：io.out / io.err 各收一行；返回退出码（0 全看成了，1 有看不成的，2 用法不对） */
export function main(argv, io) {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    io.err('用法：node secret-shape.mjs <文件>…（只打字段名、类型、长度，一个值都不打；认 JSON、env、PEM）');
    return 2;
  }
  let failed = false;
  const fail = (what, why) => {
    failed = true;
    io.err(`secret-shape：${what}：${why}`);
  };
  let first = true;
  for (const arg of argv) {
    const ex = expand(arg);
    if (ex.error) {
      fail(arg, ex.error);
      continue;
    }
    for (const file of ex.files) {
      let text;
      try {
        const st = statSync(file);
        if (st.isDirectory()) {
          fail(file, '是目录；要看里面有什么用 ls');
          continue;
        }
        if (st.size > MAX_BYTES) {
          fail(file, `太大（${st.size} 字节），不像配置文件，不读`);
          continue;
        }
        text = readFileSync(file, 'utf8');
      } catch (err) {
        fail(file, `读不了（${err?.code ?? err}）`);
        continue;
      }
      const shape = shapeOf(file, text);
      if (shape.error) {
        fail(file, shape.error);
        continue;
      }
      if (!first) io.out('');
      first = false;
      io.out(`== ${file}（${shape.kind}）==`);
      for (const line of shape.lines.length > 0 ? shape.lines : ['（一个字段都没有）']) io.out(line);
    }
  }
  return failed ? 1 : 0;
}

/** 直接跑（node 文件、或者经 ssh 从标准输入喂进去的 node -）才执行；被测试 import 时不跑 */
function isMain() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  const entry = process.argv[1];
  if (entry === '-') return true;
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const code = main(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = code;
}
