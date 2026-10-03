// 法国 /etc/fleet-dao 下几份环境文件「应该是什么」（#323，OpenGitOps：期望声明进仓、有版本，线上持续对账）：
// 期望写在仓里的 deploy/france/desired-config.json；这里读期望、照 systemd 的读法读线上、比出哪一项不一致。
// 公开的值写原值；私有的值（域名、账号、编号、密钥）只写指纹——HMAC-SHA256，钥匙是法国本机随机生成的
// /etc/fleet-dao/config-fingerprint.key（没有钥匙猜不出低熵的值；做法和出处见 specs/323-配置进仓对账/方案.md）。
// 自动发布每一轮 import 它对账（lib.mjs 的 configStep）；france.sh 读回、建新机器的环境文件（render），release.sh 切版本前
// 照期望写（apply），人算指纹，都走下面的命令行。
// 改这里之前必须知道：
// - 读法照搬 systemd（和 deploy/lib/app-config.sh 的 env_parse 同一套）：deploy/test/config.test.mjs 用那边测试的同一批样本钉住两边一样。
// - 线上的值一律不进输出、报警、状态文件：只报文件、键名、期望里公开的值和「不一致」；私有值连期望也只有指纹，发布时也不写。
// - 读不到、认不出一律「没查成」，不当成一致（AGENTS.md「底线」）；发布时照期望写，读不到、认不出、写完读回不对一律不写（写了的改回原样）。
// - 本文件跟着 lib.mjs 一起装到 /usr/local/lib/fleet-dao/auto-release/（france.sh 的 AUTO_RELEASE_FILES），只能 import node 自带的。
import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
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
/** diff-local 默认比的两份文件：跟着这个脚本在仓里的位置算，不用另外传路径（#451）。 */
export const FRANCE_DESIRED_FILE = fileURLToPath(new URL('../desired-config.json', import.meta.url));
export const LOCAL_DESIRED_FILE = fileURLToPath(new URL('../../local/desired-config.json', import.meta.url));
/**
 * 本机档和法国要钉住同一套大版本（#451，装机脚本的常量：Postgres、Temporal 服务端与命令行都由同一份
 * deploy/france.sh 装两个档位，理论上不会漂；这里让「两边一样」这件事能被读出来、被测试故意破坏）。
 * Node 只写大版本号：france.sh 的前提只要求 /usr/bin/node ≥ 这个数，不是钉死到点号版本。
 */
export const PINNED_VERSION_KEYS = ['postgresMajor', 'nodeMajor', 'temporalServer', 'temporalCli'];
/** 发布时照期望写的几份（单元读的环境文件）。france.env 归 france.sh 读，只对账、不在发布时写。 */
export const APPLY_FILES = ['engine.env', 'api.env', 'release.env'];
/** 上次照期望写了什么（每份文件里公开的键 → 值）：只有 release.sh 经命令行 apply 写，人别改；认不出就删掉它。 */
export const APPLIED_FILE = `${RELEASES}/.config-applied.json`;
export const APPLIED_FORMAT = 1;
/** 写记录里留最近几次：什么时候照期望改了哪几项、删了哪几项、改回过哪几项。 */
const APPLIED_LOG_KEEP = 20;
/** 这台是哪个档位：一行 france 或 local，france.sh 记（deploy/lib/profile.sh）。不在就是法国（和 FLEET_PROFILE 不给时一样）。 */
export const PROFILE_FILE = `${ETC_DIR}/profile`;
/** 档位 → 这个档位的期望在每一版目录里的位置（#451：本机档的差别只写在 deploy/local 那一份）。 */
export const PROFILE_DESIRED = { france: DESIRED_FILE, local: 'deploy/local/desired-config.json' };

const KEY_NAME = /^[A-Z_][A-Z0-9_]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{40}$/;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

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
 * versions 块（可选；不给就是 null，老的期望文件不用跟着改）：#451 本机档和法国互相比对时钉版本用，
 * 这份对账（judgeConfig）本身不读它——它比的是线上的环境文件，不是这几个装机脚本的常量。
 */
function parseVersions(raw, bad) {
  if (raw === undefined) return null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('versions 要是一个对象');
  for (const k of Object.keys(raw)) {
    if (k !== '说明' && !PINNED_VERSION_KEYS.includes(k)) bad(`versions 里不认识的一项「${k}」`);
  }
  const missing = PINNED_VERSION_KEYS.filter((k) => !Object.hasOwn(raw, k));
  if (missing.length > 0) bad(`versions 少了 ${missing.join('、')}`);
  const out = {};
  for (const k of PINNED_VERSION_KEYS) {
    if (typeof raw[k] !== 'string' || raw[k] === '') bad(`versions.${k} 要是非空字符串`);
    out[k] = raw[k];
  }
  return out;
}

/**
 * 读期望文件、校验。认不出抛 ConfigError（写明哪里不对）；认得出返回
 * { formatVersion, selfHeal, fingerprint: { algorithm, keyId } | null, versions: {...} | null,
 *   files: { 文件: [{ key, kind: 'public' | 'private', value?, fp?, note? }] } }。
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
    if (!['说明', 'formatVersion', 'selfHeal', 'fingerprint', 'versions', 'files'].includes(k))
      bad(`不认识的一项「${k}」`);
  }
  const versions = parseVersions(raw.versions, bad);
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
  // 受管的几份文件一份都不能少：漏写一份，那份线上被怎么改都没人比，对账却照样报一致
  const lacking = CONFIG_FILES.filter((f) => !Object.hasOwn(files, f));
  if (lacking.length > 0)
    bad(`少了 ${lacking.join('、')}：受管的 ${CONFIG_FILES.join('、')} 都要写上（一项都不管的写 {}）`);
  if (privateCount > 0 && fingerprint === null) bad('有私有值就要写 fingerprint（算法和钥匙编号）');
  return { formatVersion: raw.formatVersion, selfHeal: raw.selfHeal, fingerprint, versions, files };
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
export function judgeConfig({ desired, files = {}, key, desiredPath }) {
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
    // desiredPath 没给（老调用方、测试）就照旧当法国：不传这个参数时行为不变
    const fix = `期望在仓里 ${desiredPath ?? DESIRED_FILE}（在用的那一版）：线上是手改的就改回去；真要改期望，改那份文件、合进主线`;
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

// ── 本机档和法国互相比（#451） ──

/**
 * 本机档（deploy/local/desired-config.json）和法国（deploy/france/desired-config.json）逐项比：两份都是仓里的
 * 静态文件，不看任何一台机器此刻的样子。france、local 是 parseDesired() 解析好的样子。
 * 规矩（本机档的差别只许写在 local 那一份里，#451）：
 *   - versions 钉死：两边必须逐字一样，写了「说明」也不例外（这一类不许有例外）。
 *   - 两个文件声明的键集合必须一样：一边有一边没有，就是没登记的差别（要写就两边都写，值可以不同）。
 *   - 两边都存在的键：都是私有值（各自的凭据，本来就不共用，比如 GitHub webhook 密钥）不算差别，不用登记；
 *     种类换了（private ↔ public）或都是公开值但值不一样，local 那一条必须有非空的「说明」，没有就是没登记的差别。
 * 返回 { result: 'ok' | 'drift' | 'unchecked', drift: [{ scope, file?, key, title, body }], unchecked: [...] }。
 */
export function diffProfiles(france, local) {
  const drift = [];
  if (!france?.versions || !local?.versions) {
    return {
      result: 'unchecked',
      drift,
      unchecked: ['两份期望里至少一份没写 versions（#451 要求两边都钉版本，才能比）'],
    };
  }
  for (const k of PINNED_VERSION_KEYS) {
    if (france.versions[k] !== local.versions[k]) {
      drift.push({
        scope: 'versions',
        key: k,
        title: `本机档和法国的版本没钉住一样：versions.${k}`,
        body: `法国是 ${JSON.stringify(france.versions[k])}，本机档是 ${JSON.stringify(local.versions[k])}：这一类版本两边必须逐字一样（#451），改 deploy/france.sh 的常量或 deploy/local/desired-config.json 的 versions 让两边一致，没有「说明」能例外这一条。`,
      });
    }
  }
  const files = new Set([...Object.keys(france.files ?? {}), ...Object.keys(local.files ?? {})]);
  for (const file of files) {
    const fKeys = new Map((france.files?.[file] ?? []).map((d) => [d.key, d]));
    const lKeys = new Map((local.files?.[file] ?? []).map((d) => [d.key, d]));
    const keys = new Set([...fKeys.keys(), ...lKeys.keys()]);
    for (const key of keys) {
      const f = fKeys.get(key);
      const l = lKeys.get(key);
      if (!f || !l) {
        drift.push({
          scope: 'files',
          file,
          key,
          title: `本机档和法国声明的键不一样：${file} 的 ${key}`,
          body: `${!f ? '法国' : '本机档'}的期望里没有这一项：本机档要声明和法国一样的键（值、种类可以不同，但要在 deploy/local/desired-config.json 里写「说明」讲清为什么，#451）。`,
        });
        continue;
      }
      if (f.kind === 'private' && l.kind === 'private') continue; // 各自的凭据，本来就不共用，不用登记
      const same = f.kind === l.kind && (f.kind !== 'public' || f.value === l.value);
      if (same) continue;
      if (!l.note?.trim()) {
        drift.push({
          scope: 'files',
          file,
          key,
          title: `本机档和法国不一样、但没登记为什么：${file} 的 ${key}`,
          body: `本机档这一项要在 deploy/local/desired-config.json 里写「说明」，讲清为什么和法国不一样——本机档的差别只许写在这一处（#451）。`,
        });
      }
    }
  }
  return { result: drift.length > 0 ? 'drift' : 'ok', drift, unchecked: [] };
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
 * 期望按这台的档位挑（档位文件在 etc 下，见 readProfile）：法国是 deploy/france/desired-config.json，本机档是
 * deploy/local/desired-config.json；档位认不出记没查成，不猜。
 * paths 只有测试和命令行换：{ releases, etc, key, desired, profile }；desired 给了就用它，不看 current、不看档位。
 */
export function readLive(paths = {}) {
  const releases = paths.releases ?? RELEASES;
  const etc = paths.etc ?? ETC_DIR;
  let commit = null;
  let desired;
  let rel = DESIRED_FILE;
  if (paths.desired) desired = readText(paths.desired);
  else {
    try {
      rel = readProfile(paths.profile ?? `${etc}/profile`).rel;
    } catch (e) {
      desired = { error: e.message };
    }
    try {
      commit = readlinkSync(`${releases}/current`);
    } catch (e) {
      commit = null;
      desired ??= {
        error: e.code === 'ENOENT' ? '还没发布过（current 不在）' : `读不了 ${releases}/current（${e.code}）`,
      };
    }
    if (commit !== null && desired === undefined) {
      if (!SHA.test(commit))
        desired = { error: `${releases}/current 指着认不出的「${commit.slice(0, 60)}」` };
      else desired = readText(`${releases}/${commit}/${rel}`);
    }
  }
  const files = Object.fromEntries(CONFIG_FILES.map((f) => [f, readText(`${etc}/${f}`)]));
  // 不一致时告诉人改哪份文件：给了 --desired 就是那个路径（本机档，#451）；不然指仓里这个档位的那份（要改期望，改的
  // 是仓里现在这份、合进主线，不是某个旧提交里读到的快照，所以不用 commit 拼路径）
  const desiredPath = paths.desired ?? rel;
  return { commit, desired, desiredPath, files, key: readText(paths.key ?? FINGERPRINT_KEY_FILE) };
}

/**
 * 这台的档位 → { profile, rel（这个档位的期望在每一版里的位置）, note }。文件不在算法国（note 写明是按默认算的，
 * 装档位文件之前的机器都是这样）；是符号链接、读不了、写的不是认识的档名，抛 ConfigError——不猜成法国：本机档拿
 * 法国的期望写配置，会把法国的值写进本机。
 */
export function readProfile(path = PROFILE_FILE) {
  try {
    lstatSync(path);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return {
        profile: 'france',
        rel: PROFILE_DESIRED.france,
        note: `没有档位文件 ${path}：按法国档（france.sh 下次跑会记上）`,
      };
    }
    throw new ConfigError(`读不了档位文件 ${path}（${e.code ?? e.message}）`);
  }
  const got = readText(path);
  if ('error' in got) throw new ConfigError(`档位文件读不到：${got.error}`);
  const name = got.text.replace(/\n$/, '');
  if (!Object.hasOwn(PROFILE_DESIRED, name)) {
    throw new ConfigError(
      `档位文件 ${path} 认不出（写的是「${name.slice(0, 40)}」，只认 ${Object.keys(PROFILE_DESIRED).join('、')}）`,
    );
  }
  return { profile: name, rel: PROFILE_DESIRED[name], note: null };
}

// ── 发布时照期望写（release.sh 切版本之前；#323 方案第四节） ──
// 照 Argo CD 不开自愈的做法：只写「这一版的期望和上次写的不一样」的公开键，人手改的偏离不改回（对账照旧只报警）；
// 期望里 selfHeal 开了才连人手改的一起改回。期望里没有了的键删掉；改成私有值的不动（私有值不写，只对账）；
// 期望里从来没有的键（人加的）不碰，对账报「多了一项」（Argo CD 的 prune 也是另一个开关）。

/** 期望里发布时要写的公开值：{ 文件: { 键: 值 } }，APPLY_FILES 每份都有（一项都不管的是 {}）。 */
function publicValues(want) {
  return Object.fromEntries(
    APPLY_FILES.map((f) => [
      f,
      Object.fromEntries(
        (want.files[f] ?? []).filter((d) => d.kind === 'public').map((d) => [d.key, d.value]),
      ),
    ]),
  );
}

/** 一份环境文件里每个键生效的赋值（同一个键写几行就几个值，按出现的顺序）。 */
function valuesByKey(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.key, [...(m.get(e.key) ?? []), e.value]);
  return m;
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** 写进注释的一句话：控制字符（换行之类）换成空格——注释里断了行，后半句就成了一条赋值。 */
const oneLine = (s) =>
  [...String(s)]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch))
    .join('')
    .trim();

/**
 * 改完的原文照 systemd 读回来对不对：expect 里的键（这次写的、删的）生效的值要正好是给的那几个，别的键一个都不许变、
 * 也不许多出来。不对抛 ConfigError（只说键名，不带值：线上原来的值可能是人放的私有值）。
 */
export function checkRewrite(file, beforeText, afterText, expect) {
  const before = valuesByKey(parseEnv(beforeText).entries);
  let after;
  try {
    after = valuesByKey(parseEnv(afterText).entries);
  } catch (e) {
    throw new ConfigError(`${file} 改完照 systemd 读回来认不出（${e.message}）`);
  }
  const wrong = [];
  for (const [k, vals] of expect) if (!sameList(after.get(k) ?? [], vals)) wrong.push(k);
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    if (!expect.has(k) && !sameList(after.get(k) ?? [], before.get(k) ?? [])) wrong.push(k);
  }
  if (wrong.length > 0)
    throw new ConfigError(`${file} 改完照 systemd 读回来不对：${wrong.join('、')} 不是该有的样子`);
}

/** 按 parseEnv 给的位置改原文：text 是 null 的整条删掉（连同它后面那个换行），appends 接在文件末尾。 */
function rewrite(text, edits, appends) {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    if (e.text !== null) {
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
      continue;
    }
    let end = e.end;
    if (out[end] === '\r') end++;
    if (out[end] === '\n') end++;
    out = out.slice(0, e.start) + out.slice(end);
  }
  if (appends.length > 0) {
    if (out !== '' && !out.endsWith('\n')) out += '\n';
    out += `${appends.join('\n')}\n`;
  }
  return out;
}

/**
 * 算这一版照期望要怎么写，不碰磁盘。
 *   want：这一版的期望（parseDesired 的结果）；applied：上次写的记录（parseApplied 的结果，第一次是 null）；
 *   cur：在用那一版的期望（只在第一次、没有记录时当「上次写的」；没有、读不出是 null）；
 *   live：{ 文件: 原文 }，APPLY_FILES 每份都要有；stamp：补进文件末尾的那一行注释里写的来历。
 * 返回 { baseline, texts, expect, set, removed, healed, kept, drift, files }：
 *   baseline 是拿什么当「上次写的」——applied（有记录）、current（第一次，拿在用那一版的期望，只写这一版改了的）、
 *   new（第一次、也没有在用的：只记基线，selfHeal 关着就一个字都不写）；texts 是三份文件改完的原文（不用改的原样），
 *   expect 是每份文件这次动了的键 → 改完该有的值（读回核对用）；set 是期望变了、照着写的，removed 是期望里没有了、
 *   删掉的，healed 是 selfHeal 开着、把人手改的改回去的，kept 是期望变了、线上已经是这个值的，drift 是 selfHeal 关着、
 *   人手改过没改回的（一项一个「文件:键」）；files 是写完要记下的「上次写的」（这一版的公开值）。
 * 写不成抛 ConfigError，一个字都不写：线上文件认不出、要写的键在文件里写了几行（不猜该改哪一行）、改完自己读回不对。
 */
export function planApply({ want, applied = null, cur = null, live, stamp }) {
  const D = publicValues(want);
  const baseline = applied ? 'applied' : cur ? 'current' : 'new';
  const A = applied ? applied.files : cur ? publicValues(cur) : D;
  const plan = {
    baseline,
    texts: {},
    expect: {},
    set: [],
    removed: [],
    healed: [],
    kept: [],
    drift: [],
    files: D,
  };
  for (const file of APPLY_FILES) {
    const text = live[file];
    if (typeof text !== 'string') throw new ConfigError(`${file} 没读到`);
    let parsed;
    try {
      parsed = parseEnv(text);
    } catch (e) {
      throw new ConfigError(`${file} 认不出（${e.message}）`);
    }
    const hits = new Map();
    for (const e of parsed.entries) hits.set(e.key, [...(hits.get(e.key) ?? []), e]);
    const declared = new Map((want.files[file] ?? []).map((d) => [d.key, d]));
    const last = A[file] ?? {};
    const edits = [];
    const appends = [];
    const expect = new Map();
    for (const [key, value] of Object.entries(D[file])) {
      const found = hits.get(key) ?? [];
      const id = `${file}:${key}`;
      const changed = last[key] !== value;
      const matches = found.length === 1 && found[0].value === value;
      if (!changed && (matches || !want.selfHeal)) {
        if (!matches) plan.drift.push(id);
        continue;
      }
      if (found.length > 1) {
        throw new ConfigError(
          `${file} 里 ${key} 写了 ${found.length} 行（服务里生效的是最后一行），不猜该改哪一行：删成一行再发布`,
        );
      }
      if (matches) {
        plan.kept.push(id);
        continue;
      }
      (changed ? plan.set : plan.healed).push(id);
      expect.set(key, [value]);
      if (found.length === 1) {
        edits.push({ start: found[0].start, end: found[0].end, text: `${key}=${value}` });
      } else {
        const note = declared.get(key)?.note;
        appends.push(`# ${note ? `${oneLine(note)}（${stamp}）` : stamp}`, `${key}=${value}`);
      }
    }
    for (const key of Object.keys(last)) {
      // 还是公开的上面管了；改成私有值的不是发布该写的，也不删
      if (declared.has(key)) continue;
      const found = hits.get(key) ?? [];
      if (found.length === 0) continue;
      plan.removed.push(`${file}:${key}`);
      expect.set(key, []);
      for (const e of found) edits.push({ start: e.start, end: e.end, text: null });
    }
    const next = rewrite(text, edits, appends);
    checkRewrite(file, text, next, expect);
    plan.texts[file] = next;
    plan.expect[file] = expect;
  }
  return plan;
}

/** 上次照期望写的记录。认不出抛 ConfigError：不猜，删掉它，下次发布重新记基线。 */
export function parseApplied(text) {
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch (e) {
    throw new ConfigError(`上次照期望写的记录不是 JSON（${e instanceof Error ? e.message : String(e)}）`);
  }
  const bad = (why) => {
    throw new ConfigError(`上次照期望写的记录认不出：${why}`);
  };
  if (!isObj(raw)) bad('整份要是一个对象');
  if (raw.schema !== APPLIED_FORMAT) bad(`schema 是 ${JSON.stringify(raw.schema)}，只认 ${APPLIED_FORMAT}`);
  if (!isObj(raw.files)) bad('files 要是一个对象');
  for (const f of Object.keys(raw.files)) if (!APPLY_FILES.includes(f)) bad(`files 里不认识的文件「${f}」`);
  const files = {};
  for (const f of APPLY_FILES) {
    if (!isObj(raw.files[f])) bad(`files 里少了 ${f}`);
    files[f] = {};
    for (const [k, v] of Object.entries(raw.files[f])) {
      if (!KEY_NAME.test(k) || typeof v !== 'string') bad(`${f} 里的「${k.slice(0, 60)}」认不出`);
      files[f][k] = v;
    }
  }
  if (!Array.isArray(raw.log)) bad('log 要是一个数组');
  return { files, log: raw.log };
}

/** 先落临时名、再换上（写到一半断了也不会留半个文件）；属主、权限照原来那份（like 是它的 stat，没有就是 root 644）。 */
function writeAtomic(path, text, like) {
  const tmp = `${dirname(path)}/.${basename(path)}.fleet-dao-new-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  try {
    // Windows 上没有属主（只在开发机上跑测试时走到）
    if (like && process.platform !== 'win32') chownSync(tmp, like.uid, like.gid);
    chmodSync(tmp, like ? like.mode & 0o7777 : 0o644);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件删不掉不影响结论：原文件没换
    }
    throw e;
  }
}

/** 文件在不在（读不了的算在：交给 readText 照实说为什么读不了）。 */
function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

/** current 指着的提交号；没有、认不出是 null（只在第一次照期望写时拿它当基线）。 */
function currentCommit(releases) {
  try {
    const s = readlinkSync(`${releases}/current`);
    return SHA.test(s) ? s : null;
  } catch {
    return null;
  }
}

const HOWS = ['release', 'rollback', 'auto-rollback'];

/**
 * 命令行 apply：release.sh 切版本之前调（发布、退回、自动退回都调）。按这台的档位读这一版的期望、上次写的记录、
 * 线上三份文件，照 planApply 算好再写。
 *   o.plan 给了一个目录：只把算好的三份写进那个目录（release.sh 用它自己读 release.env 的办法核一遍），线上一个字都不写；
 *   o.expect 给了那个目录：重新算出来的和核过的不一样就不写（核完线上又被改了）。
 * 写完照 systemd 读回核一遍，不对就把写过的几份改回原样；记录写不进也改回原样——这几种都算没写成。
 * 返回退出码：0 写好了、不用写、这一版没有期望；1 没写成（线上和原来一样，或已改回原样；改回也没成的照实说）。
 * io.out 一行一句：ok / changed / note / red 开头；io.writeFile 只有测试换（造「写后读回不一致」）。
 */
export function applyConfig(o, io = {}) {
  const out = io.out ?? console.log;
  const write = io.writeFile ?? writeAtomic;
  const red = (why) => {
    out(`red ${why}`);
    return 1;
  };
  if (!SHA.test(o.commit ?? ''))
    return red(`要写哪一版的期望：提交号认不出（${String(o.commit).slice(0, 60)}）`);
  if (!HOWS.includes(o.how)) return red(`--how 只认 ${HOWS.join('、')}（是 ${String(o.how).slice(0, 30)}）`);
  const commit = o.commit;
  const short = commit.slice(0, 12);
  const releases = o.releases ?? RELEASES;
  const etc = o.etc ?? ETC_DIR;
  const statePath = o.state ?? APPLIED_FILE;
  let profile;
  try {
    profile = readProfile(o.profile ?? PROFILE_FILE);
  } catch (e) {
    return red(`${e.message}：不知道照哪一份期望写，没写`);
  }
  if (profile.note) out(`note ${profile.note}`);
  const desiredPath = `${releases}/${commit}/${profile.rel}`;
  if (!exists(desiredPath)) {
    out(`ok ${short} 里没有 ${profile.rel}（这一版还不认配置期望）：不照期望写配置`);
    return 0;
  }
  const got = readText(desiredPath);
  if ('error' in got) return red(`这一版的期望读不到（${got.error}）：没写`);
  let want;
  try {
    want = parseDesired(got.text);
  } catch (e) {
    return red(`${short} 的期望认不出（${e.message}）：没写`);
  }
  let applied = null;
  if (exists(statePath)) {
    const s = readText(statePath);
    try {
      if ('error' in s) throw new ConfigError(`上次照期望写的记录读不到（${s.error}）`);
      applied = parseApplied(s.text);
    } catch (e) {
      return red(`${e.message}：没写（确认没在别处用它就删掉 ${statePath}，下次发布重新记基线）`);
    }
  }
  let cur = null;
  let curSha = null;
  if (!applied) {
    curSha = currentCommit(releases);
    const curPath = curSha ? `${releases}/${curSha}/${profile.rel}` : null;
    if (curPath && exists(curPath)) {
      const t = readText(curPath);
      try {
        if ('error' in t) throw new ConfigError(t.error);
        cur = parseDesired(t.text);
      } catch (e) {
        out(`note 在用的 ${curSha.slice(0, 12)} 的期望读不出（${e.message}）：这次只记基线`);
      }
    }
  }
  const live = {};
  const like = {};
  for (const f of APPLY_FILES) {
    const t = readText(`${etc}/${f}`);
    if ('error' in t) return red(`${f} 读不到（${t.error}）：没写`);
    live[f] = t.text;
    like[f] = statSync(`${etc}/${f}`);
  }
  let plan;
  try {
    plan = planApply({ want, applied, cur, live, stamp: `deploy/release.sh 照 ${short} 的期望写上` });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return red(`${e.message}：没写`);
  }
  if (o.plan) {
    for (const f of APPLY_FILES) writeFileSync(`${o.plan}/${f}`, plan.texts[f], { mode: 0o600 });
    return 0;
  }
  if (o.expect) {
    for (const f of APPLY_FILES) {
      const t = readText(`${o.expect}/${f}`);
      if ('error' in t || t.text !== plan.texts[f])
        return red(`核过以后 ${f} 又变了（或核过的那份读不到）：没写，再发一次`);
    }
  }
  const written = [];
  const undo = (why) => {
    const left = [];
    for (const f of written) {
      try {
        write(`${etc}/${f}`, live[f], like[f]);
      } catch {
        left.push(f);
      }
    }
    if (left.length > 0) return red(`${why}；改回原样也没成（${left.join('、')} 还是写过的样子）：要人看`);
    return red(`${why}：${written.length > 0 ? `写过的 ${written.join('、')} 已改回原样` : '一个字都没写'}`);
  };
  for (const f of APPLY_FILES) {
    if (plan.texts[f] === live[f]) continue;
    try {
      write(`${etc}/${f}`, plan.texts[f], like[f]);
    } catch (e) {
      return undo(`写 ${f} 没成（${e.code ?? e.message}）`);
    }
    written.push(f);
  }
  for (const f of written) {
    const t = readText(`${etc}/${f}`);
    try {
      if ('error' in t) throw new ConfigError(`${f} 写完读不回（${t.error}）`);
      checkRewrite(f, live[f], t.text, plan.expect[f]);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      return undo(`写完读回不一致：${e.message}`);
    }
  }
  const did = plan.set.length + plan.removed.length + plan.healed.length;
  const recordChanged = !applied || JSON.stringify(applied.files) !== JSON.stringify(plan.files);
  if (did > 0 || recordChanged) {
    const at = (o.now ?? new Date()).toISOString();
    const entry = {
      at,
      commit,
      how: o.how,
      baseline: plan.baseline,
      set: plan.set,
      removed: plan.removed,
      healed: plan.healed,
    };
    const next = {
      schema: APPLIED_FORMAT,
      说明: '发布时照期望写环境文件的记录（#323，deploy/france/auto-release/config.mjs 的 applyConfig）：files 是上次照期望写的公开值，release.sh 切版本时只写这一版的期望和它不一样的键；log 是最近几次写了什么。只有 release.sh 写，人别改；认不出就删掉，下次发布重新记基线。',
      profile: profile.profile,
      desired: profile.rel,
      commit,
      at,
      files: plan.files,
      log: [...(applied?.log ?? []), entry].slice(-APPLIED_LOG_KEEP),
    };
    try {
      write(statePath, `${JSON.stringify(next, null, 2)}\n`, null);
    } catch (e) {
      return undo(`照期望写的记录 ${statePath} 写不进（${e.code ?? e.message}）`);
    }
  }
  const wanted = (id) => {
    const [f, k] = id.split(':');
    return plan.files[f][k];
  };
  if (plan.baseline === 'current')
    out(`note 第一次照期望写：拿在用的 ${curSha.slice(0, 12)} 的期望当「上次写的」，只写 ${short} 改了的`);
  for (const id of plan.set)
    out(`changed ${id.replace(':', ' 的 ')}：照 ${short} 的期望写成「${wanted(id)}」`);
  for (const id of plan.removed)
    out(`changed ${id.replace(':', ' 的 ')}：${short} 的期望里没有了，删掉（值不打印）`);
  for (const id of plan.healed) {
    out(
      `changed ${id.replace(':', ' 的 ')}：人手改过，期望里 selfHeal 开着，照期望改回「${wanted(id)}」（线上原来的值不打印）`,
    );
  }
  for (const id of plan.kept)
    out(`ok ${id.replace(':', ' 的 ')}：期望改成了「${wanted(id)}」，线上已经是这个值`);
  if (plan.drift.length > 0) {
    out(
      `note 人手改过、和期望不一致的 ${plan.drift.length} 项不改回（期望里 selfHeal 关着，对账照旧报警）：${plan.drift.join('、')}`,
    );
  }
  if (did === 0) {
    if (plan.baseline === 'new') {
      const n = Object.values(plan.files).reduce((s, m) => s + Object.keys(m).length, 0);
      out(
        `changed 第一次照期望写：没有上次写的记录、也没有在用的版本，只记基线（${n} 项公开值，${statePath}），不写`,
      );
    } else if (recordChanged)
      out(`changed 照期望写的记录跟着 ${short} 的期望更新（${statePath}），环境文件不用改`);
    else out(`ok 配置：${short} 的期望和上次写的一样，不用写`);
  }
  return 0;
}

/**
 * 新机器上照期望建一份环境文件（france.sh 用，文件已经在就不建，之后归发布时照期望写）：公开的写期望的值，私有的只留
 * 空位（KEY=，人放；值不进仓，也不生造），每一项前面一行注释写它的「说明」。返回整份内容（末尾带换行）。
 */
export function renderEnv(want, file, source) {
  const lines = [
    `# /etc/fleet-dao/${file}：deploy/france.sh 照仓里的期望 ${source} 建的。每一项「应该是什么」以期望为准：`,
    '# 要改先改期望、合进主线，发布时照期望写（只写期望变了的键）；空着的是私有值，由人放，值不进仓。',
  ];
  for (const d of want.files[file] ?? []) {
    const note = d.note ? oneLine(d.note) : '';
    if (d.kind === 'private') {
      lines.push(
        `# ${note || '私有值'}（空着由人放，值不进仓；放好后在法国以 root 算指纹写进期望，docs/ops.md 第九节「配置进仓对账」）`,
        `${d.key}=`,
      );
    } else {
      if (note) lines.push(`# ${note}`);
      lines.push(`${d.key}=${d.value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ── 命令行（法国，root） ──

const USAGE = `用法（法国，root；值一律不打印）：
  node config.mjs check [--desired <期望文件>] [--etc <目录>] [--key <钥匙文件>] [--profile <档位文件>]
      拿线上的环境文件跟期望比（不给 --desired 就用在用的那一版里、这台档位的那份）。一行一条：ok / red / pending 开头。
      退出码：0 一致；1 有不一致；2 没查成（读不到、认不出）；64 参数不对。
  node config.mjs fingerprint <文件> <键> [--stdin] [--etc <目录>] [--key <钥匙文件>]
      算这一项私有值的指纹（线上现在的值；带 --stdin 就算标准输入给的新值，去掉末尾一个换行），只打印指纹。
  node config.mjs fingerprint --all [--desired <期望文件>] [--etc <目录>] [--key <钥匙文件>]
      期望里每一项私有值，按线上现在的值算指纹，打印成能贴进期望文件的样子（外加钥匙编号）。
  node config.mjs key-id [--key <钥匙文件>]
      打印指纹钥匙的编号（期望文件的 fingerprint.keyId）。
  node config.mjs diff-local [--france <期望文件>] [--local <期望文件>]
      本机档和法国的期望逐项比（#451）：不给路径就用仓里的 deploy/france/desired-config.json、
      deploy/local/desired-config.json。退出码：0 差别都登记过了；1 有没登记的差别；2 没查成；64 参数不对。
  node config.mjs apply --commit <提交号> --how release|rollback|auto-rollback [--releases <目录>] [--etc <目录>]
                        [--state <记录文件>] [--profile <档位文件>] [--plan <目录> | --expect <目录>]
      切到这一版之前照它的期望写 engine.env、api.env、release.env 里公开的值（deploy/release.sh 调，人不用）：只写这一版的
      期望和上次写的不一样的键，人手改的不改回（期望里 selfHeal 开了才改回）。--plan 只把写成什么样放进那个目录、线上不动；
      --expect 那个目录里核过的和重新算的不一样就不写。一行一条：ok / changed / note / red 开头。
      退出码：0 写好了（或不用写、这一版没有期望）；1 没写成（一个字没写，或写过的已改回原样）；64 参数不对。
  node config.mjs render engine.env|api.env|release.env [--desired <期望文件>]
      照期望打印一份新的环境文件（france.sh 建新机器时用）：公开的写值，私有的只留空位，每一项带说明。
      不给 --desired 就用仓里的 deploy/france/desired-config.json。`;

function cliArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (
      a === '--desired' ||
      a === '--etc' ||
      a === '--key' ||
      a === '--releases' ||
      a === '--france' ||
      a === '--local' ||
      a === '--commit' ||
      a === '--how' ||
      a === '--state' ||
      a === '--profile' ||
      a === '--plan' ||
      a === '--expect'
    ) {
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
    if (cmd === 'apply' && rest.length === 0) {
      if (o.plan && o.expect) {
        io.err(`--plan 和 --expect 只给一个\n${USAGE}`);
        return 64;
      }
      return applyConfig(
        {
          releases: o.releases,
          commit: o.commit,
          how: o.how,
          etc: o.etc,
          state: o.state,
          profile: o.profile,
          plan: o.plan,
          expect: o.expect,
        },
        { out: io.out },
      );
    }
    if (cmd === 'render' && rest.length === 1) {
      const [file] = rest;
      if (!APPLY_FILES.includes(file))
        throw new ConfigError(`不认识的文件 ${file}（只建 ${APPLY_FILES.join('、')}）`);
      const path = o.desired ?? FRANCE_DESIRED_FILE;
      const got = readText(path);
      if ('error' in got) throw new ConfigError(`读不到期望：${got.error}`);
      // 注释里写仓里的相对位置（哪个档位的那份），认不出就照给的路径写
      const source =
        Object.values(PROFILE_DESIRED).find((rel) => path.replaceAll('\\', '/').endsWith(`/${rel}`)) ?? path;
      io.out(renderEnv(parseDesired(got.text), file, source).replace(/\n$/, ''));
      return 0;
    }
    if (cmd === 'check' && rest.length === 0) {
      const live = readLive({
        desired: o.desired,
        etc: o.etc,
        key: o.key,
        releases: o.releases,
        profile: o.profile,
      });
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
    if (cmd === 'diff-local' && rest.length === 0) {
      const franceRaw = readText(o.france ?? FRANCE_DESIRED_FILE);
      if ('error' in franceRaw) throw new ConfigError(`读不到法国的期望：${franceRaw.error}`);
      const localRaw = readText(o.local ?? LOCAL_DESIRED_FILE);
      if ('error' in localRaw) throw new ConfigError(`读不到本机档的期望：${localRaw.error}`);
      const r = diffProfiles(parseDesired(franceRaw.text), parseDesired(localRaw.text));
      for (const d of r.drift) io.out(`red ${d.title}：${d.body}`);
      for (const u of r.unchecked) io.out(`pending 本机档和法国的期望没比成：${u}`);
      if (r.result === 'ok')
        io.out('ok 本机档和法国的期望（deploy/local、deploy/france 的 desired-config.json）：差别都登记过了');
      return r.result === 'ok' ? 0 : r.result === 'drift' ? 1 : 2;
    }
    if (cmd === 'fingerprint' && o.all && rest.length === 0) {
      const live = readLive({ desired: o.desired, etc: o.etc, releases: o.releases, profile: o.profile });
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
