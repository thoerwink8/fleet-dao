// 法国 /etc/fleet-dao 下几份环境文件「应该是什么」（#323，OpenGitOps：期望声明进仓、有版本，线上持续对账）：
// 期望写在仓里的 deploy/france/desired-config.json；这里读期望、照 systemd 的读法读线上、比出哪一项不一致。
// 公开的值写原值；私有的值（域名、账号、编号、密钥）只写指纹——HMAC-SHA256，钥匙是法国本机随机生成的
// /etc/fleet-dao/config-fingerprint.key（没有钥匙猜不出低熵的值；做法和出处见 specs/323-配置进仓对账/方案.md）。
// 自动发布每一轮 import 它对账（lib.mjs 的 configStep）；france.sh 读回、人算指纹走下面的命令行。
// 改这里之前必须知道：
// - 读法照搬 systemd（和 deploy/lib/app-config.sh 的 env_parse 同一套）：deploy/test/config.test.mjs 用那边测试的同一批样本钉住两边一样。
// - 线上的值一律不进输出、报警、状态文件：只报文件、键名、期望里公开的值和「不一致」；私有值连期望也只有指纹。
// - 读不到、认不出一律「没查成」，不当成一致（AGENTS.md「底线」）。
// - 本文件跟着 lib.mjs 一起装到 /usr/local/lib/fleet-dao/auto-release/（france.sh 的 AUTO_RELEASE_FILES），只能 import node 自带的。
import { createHmac } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 期望文件在仓里的位置（每一版的目录里都有一份：对账拿在用的那一版的）。 */
export const DESIRED_FILE = 'deploy/france/desired-config.json';
export const DESIRED_FORMAT = 1;
export const ETC_DIR = '/etc/fleet-dao';
/** 指纹钥匙：64 位十六进制一行，root:root 600，france.sh 第一次跑时生成，跟着保险箱的 refresh.sh 进加密副本。 */
export const FINGERPRINT_KEY_FILE = `${ETC_DIR}/config-fingerprint.key`;
/** 指纹的算法和版本：输入绑上文件名和键名，同一个值在两个键上的指纹也不一样（不泄露「这两项一样」）。 */
export const FINGERPRINT_ALGORITHM = 'hmac-sha256/v1';
/** 期望里能写的几份文件（都在 /etc/fleet-dao 下）。france.env 归 france.sh 读、只对账。 */
export const CONFIG_FILES = ['engine.env', 'api.env', 'release.env', 'france.env'];
/** 人在法国上跑命令行用的这一份（部署检出里的）。 */
export const CONFIG_CLI = '/srv/fleet-dao/deploy/france/auto-release/config.mjs';
const RELEASES = '/srv/fleet-dao-releases';

const KEY_NAME = /^[A-Z_][A-Z0-9_]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

/** 读不到、认不出：调用方一律记「没查成」。 */
export class ConfigError extends Error {}

// ── 照 systemd 读环境文件 ──

const WS = ' \t\n\r';
const NL = '\n\r';
const COMMENTED = /^[#; \t\n\v\f\r]*([A-Za-z_][A-Za-z0-9_]*)[ \t\n\v\f\r]*=/;
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 和 systemd 255 的 parse_env_file_internal（src/basic/env-file.c）同一种读法，逐条对着 deploy/lib/app-config.sh 的 env_parse：
 * 行首空白跳过；# 或 ; 开头的行是注释；没有 = 的行不算；键去掉尾部空白；值去掉开头的空白；不带引号的值去掉尾部空白，
 * 反斜杠留下后一个字符（行尾的反斜杠接下一行）；'…' 里原样；"…" 里 \" \\ \` \$ 去掉反斜杠、别的反斜杠照留；引号可以跨行，
 * 前后几段拼成一个值；键名不合法的整条不算。和 bash 的 $(<文件) 一样先去掉文件末尾的换行。
 * 返回生效的赋值（按出现的顺序，同一个键写几次就几条；start、end 是这条赋值在原文里占的那几行，改文件时用）和出现过但不生效的
 * 键名（注释掉的赋值、光写了键）。引号到文件末尾都没配上、最后一行以反斜杠结尾：抛 ConfigError（systemd 会把后面的整个文件
 * 算进值里，或者往文件末尾补的内容会被接进值里，都不是人要的样子）。
 */
export function parseEnv(text) {
  const content = String(text).replace(/\n+$/, '');
  const entries = [];
  const mentioned = [];
  let state = 'PRE_KEY';
  let key = '';
  let value = '';
  let comment = '';
  let kws = -1;
  let vws = -1;
  let start = 0;
  const trimKey = (k, at) => (at < 0 ? k : k.slice(0, at));
  const push = (end) => {
    const k = trimKey(key, kws);
    if (VALID_KEY.test(k)) entries.push({ key: k, value, start, end });
  };
  const bare = () => {
    const k = trimKey(key, kws);
    if (VALID_KEY.test(k)) mentioned.push(k);
  };
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    switch (state) {
      case 'PRE_KEY':
        if (c === '#' || c === ';') {
          state = 'COMMENT';
          comment = '';
        } else if (!WS.includes(c)) {
          state = 'KEY';
          key = c;
          kws = -1;
          start = content.lastIndexOf('\n', i - 1) + 1;
        }
        break;
      case 'KEY':
        if (NL.includes(c)) {
          bare();
          state = 'PRE_KEY';
        } else if (c === '=') {
          state = 'PRE_VALUE';
          value = '';
          vws = -1;
        } else {
          if (!WS.includes(c)) kws = -1;
          else if (kws < 0) kws = key.length;
          key += c;
        }
        break;
      case 'PRE_VALUE':
        if (NL.includes(c)) {
          push(i);
          state = 'PRE_KEY';
        } else if (c === "'") state = 'SINGLE_QUOTE';
        else if (c === '"') state = 'DOUBLE_QUOTE';
        else if (c === '\\') state = 'VALUE_ESCAPE';
        else if (!WS.includes(c)) {
          state = 'VALUE';
          value += c;
        }
        break;
      case 'VALUE':
        if (NL.includes(c)) {
          if (vws >= 0) value = value.slice(0, vws);
          push(i);
          state = 'PRE_KEY';
        } else if (c === '\\') {
          state = 'VALUE_ESCAPE';
          vws = -1;
        } else {
          if (!WS.includes(c)) vws = -1;
          else if (vws < 0) vws = value.length;
          value += c;
        }
        break;
      case 'VALUE_ESCAPE':
        state = 'VALUE';
        if (!NL.includes(c)) value += c;
        break;
      case 'SINGLE_QUOTE':
        if (c === "'") state = 'PRE_VALUE';
        else value += c;
        break;
      case 'DOUBLE_QUOTE':
        if (c === '"') state = 'PRE_VALUE';
        else if (c === '\\') state = 'DOUBLE_QUOTE_ESCAPE';
        else value += c;
        break;
      case 'DOUBLE_QUOTE_ESCAPE':
        state = 'DOUBLE_QUOTE';
        if (c === '"' || c === '\\' || c === '`' || c === '$') value += c;
        else if (c !== '\n') value += `\\${c}`;
        break;
      case 'COMMENT':
        // systemd 254 起注释行末尾的反斜杠不再接下一行：注释一律到行尾为止
        if (NL.includes(c)) {
          const m = COMMENTED.exec(comment);
          if (m) mentioned.push(m[1]);
          state = 'PRE_KEY';
        } else comment += c;
        break;
    }
  }
  const end = content.length;
  switch (state) {
    case 'KEY':
      bare();
      break;
    case 'PRE_VALUE':
      push(end);
      break;
    case 'VALUE':
      if (vws >= 0) value = value.slice(0, vws);
      push(end);
      break;
    case 'VALUE_ESCAPE':
      throw new ConfigError(
        `最后一行（${trimKey(key, kws)}）以反斜杠结尾、要接下一行：往文件末尾补的内容会被接进它的值，认不出`,
      );
    case 'SINGLE_QUOTE':
    case 'DOUBLE_QUOTE':
    case 'DOUBLE_QUOTE_ESCAPE':
      throw new ConfigError(
        `${trimKey(key, kws)} 的引号到文件末尾都没配上（systemd 会把后面整个文件都算进它的值），认不出`,
      );
    case 'COMMENT': {
      const m = COMMENTED.exec(comment);
      if (m) mentioned.push(m[1]);
      break;
    }
  }
  return { entries, mentioned };
}

// ── 期望 ──

/**
 * 公开的值要原样写得进环境文件、按 systemd 读回来一字不差，发布脚本的 load_env（bash）也读得对：不带引号、反斜杠、$、反引号、
 * 控制字符，头尾没有空白。
 */
function publicValueProblem(v) {
  const control = [...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (control || /["'\\$`]/.test(v)) return '不能有引号、反斜杠、$、反引号和控制字符';
  if (v !== v.trim()) return '头尾不能有空白';
  let back;
  try {
    back = parseEnv(`K=${v}\n`).entries;
  } catch (e) {
    return e.message;
  }
  if (back.length !== 1 || back[0].value !== v) return '写进环境文件读回来会变样';
  return null;
}

/**
 * 读期望文件、校验。认不出抛 ConfigError（写明哪里不对）；认得出返回
 * { formatVersion, selfHeal, fingerprint: { algorithm, keyId } | null, files: { 文件: [{ key, kind: 'public' | 'private', value?, fp?, note? }] } }。
 * 私有值的 fp 是 null = 仓里还没记它的指纹（对账记「没查成」，不当成一致）。
 */
export function parseDesired(text) {
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch (e) {
    throw new ConfigError(`期望文件不是 JSON（${e instanceof Error ? e.message : String(e)}）`);
  }
  const bad = (why) => {
    throw new ConfigError(`期望文件认不出：${why}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('整份要是一个对象');
  for (const k of Object.keys(raw)) {
    if (!['说明', 'formatVersion', 'selfHeal', 'fingerprint', 'files'].includes(k))
      bad(`不认识的一项「${k}」`);
  }
  if (raw.formatVersion !== DESIRED_FORMAT)
    bad(`formatVersion 是 ${JSON.stringify(raw.formatVersion)}，只认 ${DESIRED_FORMAT}`);
  if (typeof raw.selfHeal !== 'boolean') bad('selfHeal 要写 true 或 false（自动改回开不开）');
  let fingerprint = null;
  if (raw.fingerprint !== undefined) {
    const f = raw.fingerprint;
    if (typeof f !== 'object' || f === null || Array.isArray(f)) bad('fingerprint 要是一个对象');
    for (const k of Object.keys(f))
      if (!['algorithm', 'keyId'].includes(k)) bad(`fingerprint 里不认识的一项「${k}」`);
    if (f.algorithm !== FINGERPRINT_ALGORITHM)
      bad(`指纹算法是 ${JSON.stringify(f.algorithm)}，只认 ${FINGERPRINT_ALGORITHM}`);
    if (f.keyId !== null && !(typeof f.keyId === 'string' && HEX32.test(f.keyId)))
      bad('fingerprint.keyId 要是 32 位小写十六进制（还没记就写 null）');
    fingerprint = { algorithm: f.algorithm, keyId: f.keyId };
  }
  if (typeof raw.files !== 'object' || raw.files === null || Array.isArray(raw.files))
    bad('files 要是一个对象');
  const files = {};
  let privateCount = 0;
  for (const [file, keys] of Object.entries(raw.files)) {
    if (!CONFIG_FILES.includes(file))
      bad(`files 里不认识的文件「${file}」（认的：${CONFIG_FILES.join('、')}）`);
    if (typeof keys !== 'object' || keys === null || Array.isArray(keys))
      bad(`${file} 要是一个对象（键 → 期望）`);
    const list = [];
    for (const [key, spec] of Object.entries(keys)) {
      if (!KEY_NAME.test(key)) bad(`${file} 的键名「${key}」不合法（大写字母、数字、下划线）`);
      const where = `${file} 的 ${key}`;
      if (typeof spec === 'string') {
        const why = publicValueProblem(spec);
        if (why) bad(`${where}：${why}`);
        list.push({ key, kind: 'public', value: spec });
        continue;
      }
      if (typeof spec !== 'object' || spec === null || Array.isArray(spec))
        bad(`${where} 要写成值，或 { "value": … } / { "private": … }`);
      for (const k of Object.keys(spec))
        if (!['value', 'private', '说明'].includes(k)) bad(`${where} 里不认识的一项「${k}」`);
      if (spec.说明 !== undefined && typeof spec.说明 !== 'string') bad(`${where} 的说明要是字符串`);
      const note = spec.说明;
      const hasValue = Object.hasOwn(spec, 'value');
      const hasPrivate = Object.hasOwn(spec, 'private');
      if (hasValue === hasPrivate)
        bad(`${where} 要么写 value（公开的值），要么写 private（私有值的指纹），只写一样`);
      if (hasValue) {
        if (typeof spec.value !== 'string') bad(`${where} 的 value 要是字符串`);
        const why = publicValueProblem(spec.value);
        if (why) bad(`${where}：${why}`);
        list.push({ key, kind: 'public', value: spec.value, note });
      } else {
        if (spec.private !== null && !(typeof spec.private === 'string' && HEX64.test(spec.private)))
          bad(`${where} 的 private 要是 64 位小写十六进制的指纹（还没记就写 null）`);
        privateCount++;
        list.push({ key, kind: 'private', fp: spec.private, note });
      }
    }
    files[file] = list;
  }
  if (privateCount > 0 && fingerprint === null) bad('有私有值就要写 fingerprint（算法和钥匙编号）');
  return { formatVersion: raw.formatVersion, selfHeal: raw.selfHeal, fingerprint, files };
}

// ── 指纹 ──

/** 指纹钥匙文件的内容 → 钥匙。认不出抛 ConfigError（不带内容）。 */
export function parseFingerprintKey(text) {
  const s = String(text);
  if (!/^[0-9a-f]{64}\n?$/.test(s)) throw new ConfigError('指纹钥匙认不出（要 64 位小写十六进制一行）');
  return Buffer.from(s.slice(0, 64), 'hex');
}

/** 钥匙编号：对固定的一串算 HMAC 取前 32 位。编号能公开（期望文件里记着），推不出钥匙。 */
export function keyIdOf(key) {
  return createHmac('sha256', key).update('fleet-dao/config/key-id/v1').digest('hex').slice(0, 32);
}

/** 一个值的指纹：输入是「算法\0文件\0键\0值」，文件名、键名都绑进去。 */
export function fingerprintOf(key, file, name, value) {
  return createHmac('sha256', key)
    .update(`fleet-dao/config/${FINGERPRINT_ALGORITHM}\0${file}\0${name}\0`)
    .update(String(value), 'utf8')
    .digest('hex');
}

// ── 对账 ──

/**
 * 拿线上的几份环境文件跟期望比。都是读好的原文，这里不碰磁盘：
 *   desired：期望文件的原文 { text }，或读不到 { error }；
 *   files：{ 文件: { text } | { error } }，期望里写到的文件都要有；
 *   key：指纹钥匙文件的原文 { text }，或读不到 { error }。
 * 返回 { result: 'ok' | 'drift' | 'unchecked', drift: [...], unchecked: [...], selfHeal }：
 *   drift 每条 { id: '文件:键', file, key, kind, title, body }，kind 是 value（公开的值不对）、private（私有值和指纹对不上）、
 *   missing（没有生效的这一项：没写、被注释掉）、duplicate（写了几行）、undeclared（期望里没有这一项）；
 *   unchecked 每条一句话：这一项、这份文件或整份期望为什么没查成。
 * 文字里只有文件、键名、期望里公开的值；线上的值、私有值一律不写。
 */
export function judgeConfig({ desired, files = {}, key }) {
  const drift = [];
  const unchecked = [];
  if (!desired || 'error' in desired) {
    return {
      result: 'unchecked',
      drift,
      unchecked: [`读不到期望：${desired?.error ?? '没给'}`],
      selfHeal: false,
    };
  }
  let want;
  try {
    want = parseDesired(desired.text);
  } catch (e) {
    return {
      result: 'unchecked',
      drift,
      unchecked: [e instanceof Error ? e.message : String(e)],
      selfHeal: false,
    };
  }
  // 私有值要钥匙：钥匙读不到、认不出、不是期望文件记的那一把，私有值一条都不比，只记一句没查成（不展开成一堆不一致）
  let hmacKey = null;
  let keyProblem = null;
  const privates = Object.values(want.files)
    .flat()
    .filter((d) => d.kind === 'private' && d.fp !== null);
  if (privates.length > 0) {
    if (!key || 'error' in key) keyProblem = `指纹钥匙读不到（${key?.error ?? '没给'}）`;
    else {
      try {
        hmacKey = parseFingerprintKey(key.text);
      } catch (e) {
        keyProblem = e.message;
      }
      if (hmacKey && want.fingerprint.keyId === null) {
        keyProblem = '期望文件还没记指纹钥匙的编号（fingerprint.keyId）';
        hmacKey = null;
      } else if (hmacKey && keyIdOf(hmacKey) !== want.fingerprint.keyId) {
        keyProblem = `法国上的指纹钥匙（编号 ${keyIdOf(hmacKey)}）不是期望文件记的那一把（编号 ${want.fingerprint.keyId}）：换机后没从保险箱放回钥匙，或者钥匙换了、期望还没跟上`;
        hmacKey = null;
      }
    }
    if (keyProblem) unchecked.push(`私有值 ${privates.length} 项都没比：${keyProblem}`);
  }

  for (const [file, declared] of Object.entries(want.files)) {
    const live = files[file];
    if (!live || 'error' in live) {
      unchecked.push(`${file} 读不到（${live?.error ?? '没给'}），里面 ${declared.length} 项都没比`);
      continue;
    }
    let parsed;
    try {
      parsed = parseEnv(live.text);
    } catch (e) {
      unchecked.push(`${file} 认不出（${e.message}），里面 ${declared.length} 项都没比`);
      continue;
    }
    const byKey = new Map();
    for (const e of parsed.entries) {
      const list = byKey.get(e.key) ?? [];
      list.push(e.value);
      byKey.set(e.key, list);
    }
    const add = (k, kind, title, body) => drift.push({ id: `${file}:${k}`, file, key: k, kind, title, body });
    const fix = `期望在仓里 ${DESIRED_FILE}（在用的那一版）：线上是手改的就改回去；真要改期望，改那份文件、合进主线`;
    for (const d of declared) {
      const values = byKey.get(d.key) ?? [];
      const what = d.kind === 'private' ? '私有值' : `期望「${d.value}」`;
      if (values.length === 0) {
        add(
          d.key,
          'missing',
          `法国配置缺了一项：${file} 的 ${d.key}`,
          `${file} 里没有生效的 ${d.key}（没写，或被注释掉了），${what}。${fix}`,
        );
        continue;
      }
      if (values.length > 1) {
        add(
          d.key,
          'duplicate',
          `法国配置写重了：${file} 的 ${d.key}`,
          `${file} 里 ${d.key} 写了 ${values.length} 行（服务里生效的是最后一行，人改了前一行会以为改好了）：删成一行，${what}。`,
        );
        continue;
      }
      const v = values[0];
      if (d.kind === 'public') {
        if (v !== d.value) {
          add(
            d.key,
            'value',
            `法国配置和仓里的期望不一致：${file} 的 ${d.key}`,
            `${file} 的 ${d.key} ${what}，线上现在不是这个值（线上的值不打印）。${fix}。`,
          );
        }
        continue;
      }
      if (d.fp === null) {
        unchecked.push(`${file} 的 ${d.key} 是私有值，仓里还没记它的指纹`);
        continue;
      }
      if (!hmacKey) continue; // 钥匙的问题上面已经记了一句
      if (fingerprintOf(hmacKey, file, d.key, v) !== d.fp) {
        add(
          d.key,
          'private',
          `法国配置和仓里的期望不一致：${file} 的 ${d.key}`,
          `${file} 的 ${d.key} 是私有值，和仓里记的指纹对不上（值不打印）。线上是手改的就照保险箱里那份放回去；` +
            `真要换成新值：在法国以 root 跑 node ${CONFIG_CLI} fingerprint ${file} ${d.key}，` +
            `把打印出来的指纹写进 ${DESIRED_FILE}、合进主线。`,
        );
      }
    }
    const known = new Set(declared.map((d) => d.key));
    for (const [k, values] of byKey) {
      if (known.has(k)) continue;
      add(
        k,
        'undeclared',
        `法国配置多了一项：${file} 的 ${k}`,
        `${file} 里有 ${k}${values.length > 1 ? `（写了 ${values.length} 行）` : ''}，仓里的期望没有这一项（值不打印）。` +
          `要留着就把它写进 ${DESIRED_FILE}（私有的写指纹）、合进主线；不要就从 ${file} 里删掉。`,
      );
    }
  }
  const result = drift.length > 0 ? 'drift' : unchecked.length > 0 ? 'unchecked' : 'ok';
  return { result, drift, unchecked, selfHeal: want.selfHeal };
}

// ── 读法国上的原文（自动发布、france.sh 的读回、命令行共用） ──

/** 读一个文件：{ text }，或 { error }（不在、是符号链接、不是普通文件、读不了）。 */
export function readText(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    return { error: e.code === 'ENOENT' ? `没有 ${path}` : `读不了 ${path}（${e.code ?? e.message}）` };
  }
  if (st.isSymbolicLink()) return { error: `${path} 是符号链接` };
  if (!st.isFile()) return { error: `${path} 不是普通文件` };
  try {
    return { text: readFileSync(path, 'utf8') };
  } catch (e) {
    return { error: `读不了 ${path}（${e.code ?? e.message}）` };
  }
}

/**
 * 对账要读的几样：在用的那一版（current）里的期望、线上的几份环境文件、指纹钥匙。
 * paths 只有测试和命令行换：{ releases, etc, key, desired }；desired 给了就用它，不看 current。
 */
export function readLive(paths = {}) {
  const releases = paths.releases ?? RELEASES;
  const etc = paths.etc ?? ETC_DIR;
  let commit = null;
  let desired;
  if (paths.desired) desired = readText(paths.desired);
  else {
    try {
      commit = readlinkSync(`${releases}/current`);
    } catch (e) {
      commit = null;
      desired = {
        error: e.code === 'ENOENT' ? '还没发布过（current 不在）' : `读不了 ${releases}/current（${e.code}）`,
      };
    }
    if (commit !== null) {
      if (!/^[0-9a-f]{40}$/.test(commit))
        desired = { error: `${releases}/current 指着认不出的「${commit.slice(0, 60)}」` };
      else desired = readText(`${releases}/${commit}/${DESIRED_FILE}`);
    }
  }
  const files = Object.fromEntries(CONFIG_FILES.map((f) => [f, readText(`${etc}/${f}`)]));
  return { commit, desired, files, key: readText(paths.key ?? FINGERPRINT_KEY_FILE) };
}

// ── 命令行（法国，root） ──

const USAGE = `用法（法国，root；值一律不打印）：
  node config.mjs check [--desired <期望文件>] [--etc <目录>] [--key <钥匙文件>]
      拿线上的环境文件跟期望比（不给 --desired 就用在用的那一版里的）。一行一条：ok / red / pending 开头。
      退出码：0 一致；1 有不一致；2 没查成（读不到、认不出）；64 参数不对。
  node config.mjs fingerprint <文件> <键> [--stdin] [--etc <目录>] [--key <钥匙文件>]
      算这一项私有值的指纹（线上现在的值；带 --stdin 就算标准输入给的新值，去掉末尾一个换行），只打印指纹。
  node config.mjs fingerprint --all [--desired <期望文件>] [--etc <目录>] [--key <钥匙文件>]
      期望里每一项私有值，按线上现在的值算指纹，打印成能贴进期望文件的样子（外加钥匙编号）。
  node config.mjs key-id [--key <钥匙文件>]
      打印指纹钥匙的编号（期望文件的 fingerprint.keyId）。`;

function cliArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--desired' || a === '--etc' || a === '--key' || a === '--releases') {
      const v = argv[++i];
      if (!v) throw new ConfigError(`${a} 后面要跟路径`);
      o[a.slice(2)] = v;
    } else if (a === '--stdin' || a === '--all') o[a.slice(2)] = true;
    else if (a.startsWith('--')) throw new ConfigError(`不认识的参数 ${a}`);
    else o._.push(a);
  }
  return o;
}

function loadKey(path) {
  const got = readText(path ?? FINGERPRINT_KEY_FILE);
  if ('error' in got) throw new ConfigError(`指纹钥匙读不到：${got.error}`);
  return parseFingerprintKey(got.text);
}

/** 线上某份文件里这个键生效的值：没有、写了几行、读不到都抛（不拿空串顶）。 */
function liveValue(etc, file, key) {
  const got = readText(`${etc ?? ETC_DIR}/${file}`);
  if ('error' in got) throw new ConfigError(got.error);
  const hits = parseEnv(got.text).entries.filter((e) => e.key === key);
  if (hits.length === 0) throw new ConfigError(`${file} 里没有生效的 ${key}`);
  if (hits.length > 1) throw new ConfigError(`${file} 里 ${key} 写了 ${hits.length} 行：先删成一行`);
  return hits[0].value;
}

export async function cli(
  argv,
  io = { out: console.log, err: console.error, stdin: () => readFileSync(0, 'utf8') },
) {
  let o;
  try {
    o = cliArgs(argv);
  } catch (e) {
    io.err(`${e.message}\n${USAGE}`);
    return 64;
  }
  const [cmd, ...rest] = o._;
  try {
    if (cmd === 'check' && rest.length === 0) {
      const live = readLive({ desired: o.desired, etc: o.etc, key: o.key, releases: o.releases });
      const r = judgeConfig(live);
      const from =
        o.desired ??
        (live.commit ? `在用的 ${live.commit.slice(0, 12)} 里的 ${DESIRED_FILE}` : '在用的那一版');
      for (const d of r.drift) io.out(`red ${d.title}：${d.body}`);
      for (const u of r.unchecked) io.out(`pending 配置没查成：${u}`);
      if (r.result === 'ok') io.out(`ok 本机配置和期望（${from}）一致（值不打印）`);
      io.out(`ok 自动改回（selfHeal）：${r.selfHeal ? '开' : '关（只报警，不改回）'}`);
      return r.result === 'ok' ? 0 : r.result === 'drift' ? 1 : 2;
    }
    if (cmd === 'key-id' && rest.length === 0) {
      io.out(keyIdOf(loadKey(o.key)));
      return 0;
    }
    if (cmd === 'fingerprint' && o.all && rest.length === 0) {
      const live = readLive({ desired: o.desired, etc: o.etc, releases: o.releases });
      if ('error' in live.desired) throw new ConfigError(`读不到期望：${live.desired.error}`);
      const want = parseDesired(live.desired.text);
      const key = loadKey(o.key);
      const out = {};
      for (const [file, list] of Object.entries(want.files)) {
        for (const d of list) {
          if (d.kind !== 'private') continue;
          out[file] ??= {};
          out[file][d.key] = { private: fingerprintOf(key, file, d.key, liveValue(o.etc, file, d.key)) };
        }
      }
      io.out(
        JSON.stringify(
          { fingerprint: { algorithm: FINGERPRINT_ALGORITHM, keyId: keyIdOf(key) }, files: out },
          null,
          2,
        ),
      );
      return 0;
    }
    if (cmd === 'fingerprint' && !o.all && rest.length === 2) {
      const [file, name] = rest;
      if (!CONFIG_FILES.includes(file))
        throw new ConfigError(`不认识的文件 ${file}（认的：${CONFIG_FILES.join('、')}）`);
      if (!KEY_NAME.test(name)) throw new ConfigError(`键名 ${name} 不合法`);
      const key = loadKey(o.key);
      const value = o.stdin ? String(io.stdin()).replace(/\r?\n$/, '') : liveValue(o.etc, file, name);
      io.out(fingerprintOf(key, file, name, value));
      return 0;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(`没做成：${e.message}`);
      return 2;
    }
    throw e;
  }
  io.err(USAGE);
  return 64;
}

// 被 import 时不跑：只有直接 node config.mjs … 才是命令行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`没做成：${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 2;
    },
  );
}
