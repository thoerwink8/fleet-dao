#!/usr/bin/env node
// 清掉「reclaude 使用前那个 Claude 账号」留在本机 Claude 配置和 memory 里的 id。
//
// 旧账号 = ~/.claude.json（以及它的 backup）里 oauthAccount.emailAddress
// 与 ~/.reclaude/device.json 的 user_email 不是同一个。
// 现账号（两边邮箱相同）一个字段都不动。分不清新旧 = 没查成，一个字节不写。
//
// 不动：~/.reclaude/device.*、machineID、settings.json（里面没有这些 id 时连文件都不重写）、
// 会话 jsonl、daemon.log。输出只打条数和键名，不打印邮箱 / uuid / token。
//
// 另一件，和上面不是同一条理由：某个号被封了，创始人点名组织编号，只摘这个编号在
// `reclaude org list` 里那一行的邮箱。不因为是拼车或独享。没点名就不扫、不猜。
//
//   node deploy/reclaude-old-account-clean.mjs                 # 干跑旧账号
//   node deploy/reclaude-old-account-clean.mjs --apply         # 当前用户
//   node deploy/reclaude-old-account-clean.mjs --all-homes --apply
//   node deploy/reclaude-old-account-clean.mjs --org <编号>           # 干跑被封的号
//   node deploy/reclaude-old-account-clean.mjs --org <编号> --apply   # 摘掉这个号的邮箱
//     Linux 上以 root 跑 --all-homes，/etc/passwd 里每个有 .claude 或 .reclaude 的家都扫。
//     读不到 passwd = 退出码 2（其他用户没扫成，不是「都干净」）。
//
// 退出码：0 扫完（干净，或干跑看见了要摘的）/ 1 写失败 / 2 有家没查成。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIN_ID_LEN = 8;

export function classifyAccount({ deviceEmail, oauth }) {
  const hasOauth = oauth && typeof oauth === 'object';
  const email = hasOauth && typeof oauth.emailAddress === 'string' ? oauth.emailAddress.trim() : '';
  const current = typeof deviceEmail === 'string' ? deviceEmail.trim() : '';
  if (!hasOauth) return { kind: 'none' };
  if (!current)
    return { kind: 'unscanned', reason: 'reclaude 的 device.json 没有 user_email，分不清这是不是旧账号' };
  if (!email) return { kind: 'unscanned', reason: 'oauthAccount 没有 emailAddress，分不清这是不是旧账号' };
  if (email.toLowerCase() === current.toLowerCase()) return { kind: 'current' };
  return { kind: 'old' };
}

/** 只收高熵 id。显示名、创建时间不进这份清单——短字符串会误伤别的文件。 */
export function collectIds(json) {
  if (!json || typeof json !== 'object') return [];
  const oauth = json.oauthAccount || {};
  const raw = [oauth.emailAddress, oauth.accountUuid, oauth.organizationUuid, json.userID];
  const out = [];
  for (const s of raw) {
    if (typeof s !== 'string') continue;
    const t = s.trim();
    if (t.length < MIN_ID_LEN) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export function stripJson(value, ids) {
  const set = new Set(ids);
  const walk = (v) => {
    if (typeof v === 'string') return set.has(v) ? undefined : v;
    if (Array.isArray(v)) {
      const next = [];
      for (const item of v) {
        const w = walk(item);
        if (w !== undefined) next.push(w);
      }
      return next;
    }
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        const w = walk(val);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** dropIdentity：这份文件自己的 oauth 就是旧账号，连 oauthAccount / userID 一起摘掉。 */
export function stripClaudeConfig(json, { dropIdentity, dropUserID = false, ids }) {
  const next = JSON.parse(JSON.stringify(json));
  if (dropIdentity) delete next.oauthAccount;
  if (dropIdentity || dropUserID) delete next.userID;
  return stripJson(next, ids);
}

export function scrubText(text, ids) {
  let out = String(text);
  let hits = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || id.length < MIN_ID_LEN) continue;
    const parts = out.split(id);
    hits += parts.length - 1;
    out = parts.join('');
  }
  return { text: out, hits };
}

export function homesFromPasswd(text) {
  const homes = [];
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 6) continue;
    const home = parts[5];
    if (home && home.startsWith('/')) homes.push(home);
  }
  return [...new Set(homes)];
}

function readJsonIfAny(p) {
  if (!fs.existsSync(p)) return { ok: true, missing: true, value: null };
  try {
    return { ok: true, missing: false, value: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    return { ok: false, missing: false, error: e.message };
  }
}

function deviceEmailOf(home) {
  const p = path.join(home, '.reclaude', 'device.json');
  const r = readJsonIfAny(p);
  if (!r.ok) return { ok: false, error: r.error, email: '' };
  if (r.missing) return { ok: true, missing: true, email: '' };
  const email = r.value && typeof r.value.user_email === 'string' ? r.value.user_email : '';
  return { ok: true, missing: false, email };
}

function backupPaths(home) {
  const dir = path.join(home, '.claude', 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith('.claude.json'))
    .map((n) => path.join(dir, n));
}

/** reclaude 升级时留的 claude.json 副本。不收进清理面的话，下次起会话会把旧账号写回去。 */
function reclaudeConfigCopies(home) {
  const root = path.join(home, '.reclaude', 'backups');
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) walk(p);
      else if (ent.name === 'claude.json') out.push(p);
    }
  };
  walk(root);
  return out;
}

function memoryPaths(home) {
  const projects = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projects)) return { ok: true, missing: true, files: [] };
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return e;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        let real;
        try {
          real = fs.realpathSync(p);
        } catch {
          continue;
        }
        let st;
        try {
          st = fs.statSync(real);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          const err = walk(real);
          if (err) return err;
        } else if (st.isFile() && st.size <= 2_000_000) files.push(real);
        continue;
      }
      if (ent.isDirectory()) {
        const err = walk(p);
        if (err) return err;
      } else if (ent.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(p).size;
        } catch {
          continue;
        }
        if (size <= 2_000_000) files.push(p);
      }
    }
    return null;
  };
  let saw = false;
  let readErr = null;
  let projectEntries;
  try {
    projectEntries = fs.readdirSync(projects, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: e.message, files: [] };
  }
  for (const ent of projectEntries) {
    const mem = path.join(projects, ent.name, 'memory');
    if (!fs.existsSync(mem)) continue;
    saw = true;
    readErr = walk(mem);
    if (readErr) return { ok: false, error: readErr.message, files };
  }
  return { ok: true, missing: !saw, files };
}

function writeJson(p, value) {
  const mode = fs.statSync(p).mode;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${p}.old-account-clean-tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, mode);
  } catch {
    /* windows 上 chmod 可忽略 */
  }
}

function homeHasClaude(home) {
  return (
    fs.existsSync(path.join(home, '.claude.json')) ||
    fs.existsSync(path.join(home, '.claude')) ||
    fs.existsSync(path.join(home, '.reclaude'))
  );
}

/**
 * 扫一个家。apply=false 只报告。返回的对象不含任何 id 原文。
 */
export function cleanHome(home, { apply = false } = {}) {
  const report = {
    home,
    status: 'clean',
    reason: '',
    memory: 'not-scanned',
    files: [],
    wrote: false,
  };
  const reclaudeDir = path.join(home, '.reclaude');
  if (!fs.existsSync(reclaudeDir)) {
    report.status = 'skipped';
    report.reason = 'no-reclaude';
    report.memory = 'not-applicable';
    return report;
  }
  const device = deviceEmailOf(home);
  if (!device.ok) {
    report.status = 'unscanned';
    report.reason = `读不了 device.json：${device.error}`;
    report.memory = 'not-scanned';
    return report;
  }

  const livePath = path.join(home, '.claude.json');
  const live = readJsonIfAny(livePath);
  if (!live.ok) {
    report.status = 'unscanned';
    report.reason = `读不了 .claude.json：${live.error}`;
    report.memory = 'not-scanned';
    return report;
  }
  const backups = [];
  const reclaudeCopy = new Set(reclaudeConfigCopies(home));
  const copyPaths = [...backupPaths(home), ...reclaudeCopy];
  for (const p of copyPaths) {
    const r = readJsonIfAny(p);
    if (!r.ok) {
      report.status = 'unscanned';
      report.reason = `读不了备份 ${path.basename(p)}：${r.error}`;
      report.memory = 'not-scanned';
      return report;
    }
    if (!r.missing) backups.push({ path: p, json: r.value, reclaudeCopy: reclaudeCopy.has(p) });
  }

  const credPath = path.join(home, '.claude', '.credentials.json');
  const cred = readJsonIfAny(credPath);
  if (!cred.ok) {
    report.status = 'unscanned';
    report.reason = `读不了 .credentials.json：${cred.error}`;
    report.memory = 'not-scanned';
    return report;
  }

  const deviceEmail = device.email;
  const sources = [];
  if (!live.missing && live.value) sources.push(live.value);
  for (const b of backups) sources.push(b.json);

  let unscannedReason = '';
  const oldIds = [];
  let liveIsOld = false;
  for (const json of sources) {
    const kind = classifyAccount({ deviceEmail, oauth: json?.oauthAccount });
    if (kind.kind === 'unscanned' && !unscannedReason) unscannedReason = kind.reason;
    if (kind.kind === 'old') {
      for (const id of collectIds(json)) {
        if (!oldIds.includes(id)) oldIds.push(id);
      }
    }
  }
  if (!live.missing && live.value) {
    liveIsOld = classifyAccount({ deviceEmail, oauth: live.value.oauthAccount }).kind === 'old';
  }
  // 有一份 oauth 分不清新旧：整家不动。不许用「另一份备份看着像旧的」当删除扳机。
  if (unscannedReason) {
    report.status = 'unscanned';
    report.reason = unscannedReason;
    report.memory = 'not-scanned';
    return report;
  }

  const credHasOauth = !cred.missing && cred.value && Object.hasOwn(cred.value, 'claudeAiOauth');
  let dropCreds = false;
  if (credHasOauth && liveIsOld) dropCreds = true;
  else if (credHasOauth && live.missing && oldIds.length > 0) dropCreds = true;
  else if (credHasOauth && (live.missing || !live.value?.oauthAccount) && oldIds.length === 0) {
    report.status = 'unscanned';
    report.reason = '还有 claudeAiOauth，但没有 oauth 邮箱能对照，没删';
    report.memory = 'not-scanned';
    return report;
  }

  // reclaude 备份里的 userID 是这台机器当时的客户端 id，跟现在这份对不上也摘掉。
  // 只动备份，不动正在用的 ~/.claude.json（现账号的 userID 留在那里）。
  const leftoverSnapshotId = backups.some(
    (b) => b.reclaudeCopy && typeof b.json?.userID === 'string' && b.json.userID.trim().length >= MIN_ID_LEN,
  );
  if (oldIds.length === 0 && !dropCreds && !leftoverSnapshotId) {
    report.status = 'clean';
    report.reason = live.missing ? 'no-oauth' : 'same-account-or-absent';
    report.memory = 'no-id-source';
    return report;
  }

  report.status = 'dirty';
  report.reason = oldIds.length ? 'old-account' : 'snapshot-userid';
  const planned = [];

  const queueJson = (p, json, { dropIdentity, dropUserID }) => {
    if (!json || typeof json !== 'object') return;
    const next = stripClaudeConfig(json, { dropIdentity, dropUserID, ids: oldIds });
    if (JSON.stringify(next) === JSON.stringify(json)) return;
    const note = dropIdentity ? 'drop-oauth' : dropUserID ? 'drop-userid' : 'strip-ids';
    planned.push({ path: p, kind: 'json', next, note });
  };

  if (!live.missing && live.value)
    queueJson(livePath, live.value, { dropIdentity: liveIsOld, dropUserID: liveIsOld });
  for (const b of backups) {
    const drop = classifyAccount({ deviceEmail, oauth: b.json?.oauthAccount }).kind === 'old';
    queueJson(b.path, b.json, { dropIdentity: drop, dropUserID: drop || b.reclaudeCopy });
  }
  if (dropCreds) {
    const next = JSON.parse(JSON.stringify(cred.value));
    delete next.claudeAiOauth;
    planned.push({ path: credPath, kind: 'json', next, note: 'drop-claudeAiOauth' });
  }

  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const { hits } = scrubText(raw, oldIds);
    if (hits > 0) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        report.status = 'unscanned';
        report.reason = `settings.json 里有旧 id，但解析失败，没改：${e.message}`;
        report.memory = 'not-scanned';
        return report;
      }
      const next = stripJson(parsed, oldIds);
      planned.push({ path: settingsPath, kind: 'json', next, note: 'strip-ids' });
    }
  }

  if (oldIds.length === 0) {
    report.memory = 'no-id-source';
  } else {
    const mem = memoryPaths(home);
    if (!mem.ok) {
      report.status = 'unscanned';
      report.reason = `memory 没读成：${mem.error}`;
      report.memory = 'not-scanned';
      return report;
    }
    if (mem.missing) report.memory = 'no-memory-dir';
    else report.memory = 'none-found';
    for (const p of mem.files) {
      let raw;
      try {
        raw = fs.readFileSync(p, 'utf8');
      } catch (e) {
        report.status = 'unscanned';
        report.reason = `memory 文件读不了：${e.message}`;
        report.memory = 'not-scanned';
        return report;
      }
      const scrubbed = scrubText(raw, oldIds);
      if (scrubbed.hits > 0) {
        report.memory = 'scrubbed';
        planned.push({ path: p, kind: 'text', next: scrubbed.text, note: `scrub-${scrubbed.hits}` });
      }
    }
  }

  report.files = planned.map((item) => ({
    path: item.path,
    note: item.note,
  }));
  if (planned.length === 0) {
    report.status = 'clean';
    report.reason = 'ids-already-gone';
    return report;
  }
  if (!apply) return report;

  for (const item of planned) {
    if (item.kind === 'json') writeJson(item.path, item.next);
    else {
      const mode = fs.statSync(item.path).mode;
      const tmp = `${item.path}.old-account-clean-tmp`;
      fs.writeFileSync(tmp, item.next);
      fs.renameSync(tmp, item.path);
      try {
        fs.chmodSync(item.path, mode);
      } catch {
        /* 同上 */
      }
    }
  }
  report.wrote = true;
  return report;
}

export function listTargetHomes({ allHomes, homes, passwdText, homedir = os.homedir() }) {
  if (!allHomes) {
    const list = homes && homes.length ? homes : [homedir];
    return { ok: true, homes: list, limited: false };
  }
  if (process.platform === 'win32') {
    return {
      ok: true,
      homes: [homedir],
      limited: true,
      limitReason: 'windows-no-passwd',
    };
  }
  if (typeof passwdText !== 'string') {
    return { ok: false, homes: [], reason: '读不到 /etc/passwd，其他用户的家没扫成' };
  }
  const found = [];
  for (const home of homesFromPasswd(passwdText)) {
    if (!fs.existsSync(home)) continue;
    if (homeHasClaude(home)) found.push(home);
  }
  if (!found.includes(homedir) && homeHasClaude(homedir)) found.push(homedir);
  return { ok: true, homes: found, limited: false };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_MAX_BYTES = 200_000_000;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 被封的号只认点名的组织编号。从 `reclaude org list` 那一行取唯一的邮箱。
 * 不看 team / personal，编号对不上、一行里没有或多于一个邮箱，都是没查成。
 * 返回值里的 email 只给摘除用，调用方不许打印。
 */
export function bannedEmailFromOrgList(text, orgId) {
  const id = String(orgId ?? '').trim();
  if (!/^\d+$/.test(id)) return { ok: false, reason: '没有指定被封的组织编号，不扫' };
  const matched = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*\*?\s*(\d+)\t(.*)$/.exec(line);
    if (!m || m[1] !== id) continue;
    const emails = m[2]
      .split('\t')
      .map((c) => c.trim())
      .filter((c) => EMAIL_RE.test(c) && c.length >= MIN_ID_LEN);
    matched.push(emails);
  }
  if (matched.length === 0)
    return { ok: false, reason: 'org list 里没有这个组织编号，对不上邮箱，一个字节不写' };
  if (matched.length > 1) return { ok: false, reason: 'org list 里这个编号出现了不止一行，不猜' };
  const emails = matched[0];
  if (emails.length !== 1) {
    return {
      ok: false,
      reason:
        emails.length === 0 ? '这个组织那一行没有邮箱，一个字节不写' : '这个组织那一行有不止一个邮箱，不猜',
    };
  }
  return { ok: true, email: emails[0] };
}

/** 摘掉这一整串邮箱（大小写不敏感）。原来能解析的 JSON 行，摘完必须还能解析。 */
export function scrubBannedEmail(text, email) {
  const re = new RegExp(escapeRegExp(email), 'gi');
  const lines = String(text).split('\n');
  let hits = 0;
  const out = [];
  for (const line of lines) {
    re.lastIndex = 0;
    const n = line.match(re)?.length ?? 0;
    if (n === 0) {
      out.push(line);
      continue;
    }
    hits += n;
    re.lastIndex = 0;
    const replaced = line.replace(re, '');
    let wasJson = false;
    try {
      JSON.parse(line);
      wasJson = true;
    } catch {
      wasJson = false;
    }
    if (wasJson) {
      try {
        JSON.parse(replaced);
      } catch {
        return { text, hits, broken: true };
      }
    }
    out.push(replaced);
  }
  return { text: out.join('\n'), hits, broken: false };
}

function walkFiles(dir, pred, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return e;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      const err = walkFiles(p, pred, out);
      if (err) return err;
    } else if (pred(ent.name, p)) out.push(p);
  }
  return null;
}

function bannedTargetFiles(home) {
  const files = [];
  const claudeJson = path.join(home, '.claude.json');
  if (fs.existsSync(claudeJson)) files.push(claudeJson);
  const backupDir = path.join(home, '.claude', 'backups');
  if (fs.existsSync(backupDir)) {
    let names;
    try {
      names = fs.readdirSync(backupDir);
    } catch (e) {
      return { ok: false, error: e.message, files };
    }
    for (const name of names) {
      if (name.startsWith('.claude.json')) files.push(path.join(backupDir, name));
    }
  }
  const settings = path.join(home, '.claude', 'settings.json');
  if (fs.existsSync(settings)) files.push(settings);
  const projects = path.join(home, '.claude', 'projects');
  if (fs.existsSync(projects)) {
    const err = walkFiles(
      projects,
      (name, p) => name.endsWith('.jsonl') || p.split(path.sep).includes('memory'),
      files,
    );
    if (err) return { ok: false, error: err.message, files };
  }
  return { ok: true, files };
}

/**
 * 只摘被封组织的邮箱。现账号的另一串邮箱、device.json、凭据、daemon.log 不动。
 * 被封邮箱如果就是当前登录那一串，不改 ~/.claude.json（改了也会被 reclaude 填回去）。
 */
export function scrubBannedAccount(home, { email, apply = false, liveEmail = '' } = {}) {
  const report = {
    home,
    status: 'clean',
    reason: '',
    sessions: 'none-found',
    files: [],
    wrote: false,
    liveSame: false,
  };
  if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length < MIN_ID_LEN) {
    report.status = 'unscanned';
    report.reason = '没有可用的被封邮箱';
    report.sessions = 'not-scanned';
    return report;
  }
  const live = typeof liveEmail === 'string' ? liveEmail.trim().toLowerCase() : '';
  report.liveSame = Boolean(live) && live === email.trim().toLowerCase();
  const listed = bannedTargetFiles(home);
  if (!listed.ok) {
    report.status = 'unscanned';
    report.reason = `有文件没读成：${listed.error}`;
    report.sessions = 'not-scanned';
    return report;
  }
  const planned = [];
  let sawSession = false;
  for (const file of listed.files) {
    if (report.liveSame && path.basename(file) === '.claude.json') continue;
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      report.status = 'unscanned';
      report.reason = `文件没读成：${e.message}`;
      report.sessions = 'not-scanned';
      return report;
    }
    if (!st.isFile()) continue;
    const isSession = file.endsWith('.jsonl');
    if (isSession) sawSession = true;
    const cap = isSession ? SESSION_MAX_BYTES : 2_000_000;
    if (st.size > cap) {
      report.status = 'unscanned';
      report.reason = isSession ? '有会话文件大过上限，没查完' : '有配置或 memory 大过上限，没查完';
      report.sessions = 'not-scanned';
      return report;
    }
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      report.status = 'unscanned';
      report.reason = `文件没读成：${e.message}`;
      report.sessions = 'not-scanned';
      return report;
    }
    const scrubbed = scrubBannedEmail(raw, email);
    if (scrubbed.broken) {
      report.status = 'unscanned';
      report.reason = '摘掉邮箱后 JSON 解析不了，一个字节不写';
      report.sessions = 'not-scanned';
      return report;
    }
    if (scrubbed.hits > 0)
      planned.push({ path: file, next: scrubbed.text, note: `scrub-email-${scrubbed.hits}` });
  }
  if (!sawSession && !listed.files.some((f) => f.endsWith('.jsonl'))) report.sessions = 'no-session-dir';
  if (planned.length === 0) return report;
  report.status = 'dirty';
  report.reason = 'banned-email';
  report.sessions = planned.some((item) => item.path.endsWith('.jsonl')) ? 'scrubbed' : 'none-found';
  report.files = planned.map((item) => ({ path: item.path, note: item.note }));
  if (!apply) return report;
  for (const item of planned) {
    const mode = fs.statSync(item.path).mode;
    const tmp = `${item.path}.banned-email-tmp`;
    fs.writeFileSync(tmp, item.next);
    fs.renameSync(tmp, item.path);
    try {
      fs.chmodSync(item.path, mode);
    } catch {
      /* windows 上 chmod 可忽略 */
    }
  }
  report.wrote = true;
  return report;
}

function printBanned(report, { limited, limitReason } = {}) {
  const files = report.files?.length ?? 0;
  process.stdout.write(
    `home=${report.home} status=${report.status} reason=${report.reason || '-'} sessions=${report.sessions} liveSame=${report.liveSame ? 'yes' : 'no'} files=${files} wrote=${report.wrote ? 'yes' : 'no'}\n`,
  );
  for (const f of report.files || []) process.stdout.write(`  ${f.note} ${f.path}\n`);
  if (limited) process.stdout.write(`other-homes=not-scanned (${limitReason})\n`);
}

function orgListText(orgListFile) {
  if (orgListFile) {
    try {
      return { ok: true, text: fs.readFileSync(orgListFile, 'utf8') };
    } catch (e) {
      return { ok: false, reason: `org list 文件读不了：${e.message}` };
    }
  }
  const run = spawnSync('reclaude', ['org', 'list'], { encoding: 'utf8', timeout: 30000 });
  if (run.error || run.status !== 0) {
    return { ok: false, reason: `org list 没跑成：退出码 ${run.status ?? 'none'}` };
  }
  return { ok: true, text: run.stdout };
}

function liveOauthEmail(home) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    const email = value?.oauthAccount?.emailAddress;
    return typeof email === 'string' ? email : '';
  } catch {
    return '';
  }
}

function printReport(report, { limited, limitReason } = {}) {
  const files = report.files?.length ?? 0;
  process.stdout.write(
    `home=${report.home} status=${report.status} reason=${report.reason || '-'} memory=${report.memory} files=${files} wrote=${report.wrote ? 'yes' : 'no'}\n`,
  );
  for (const f of report.files || []) {
    process.stdout.write(`  ${f.note} ${f.path}\n`);
  }
  if (limited) {
    process.stdout.write(`other-homes=not-scanned (${limitReason})\n`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const allHomes = argv.includes('--all-homes');
  const homes = [];
  let orgId = '';
  let orgListFile = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home' && argv[i + 1]) homes.push(argv[++i]);
    else if (argv[i] === '--org' && argv[i + 1]) orgId = argv[++i];
    else if (argv[i] === '--org-list-file' && argv[i + 1]) orgListFile = argv[++i];
  }
  let passwdText;
  if (allHomes && process.platform !== 'win32') {
    try {
      passwdText = fs.readFileSync('/etc/passwd', 'utf8');
    } catch (e) {
      process.stderr.write(`读不到 /etc/passwd：${e.message}\n`);
      process.exit(2);
    }
  }
  const listed = listTargetHomes({ allHomes, homes, passwdText });
  if (!listed.ok) {
    process.stderr.write(`${listed.reason}\n`);
    process.exit(2);
  }
  if (listed.homes.length === 0) {
    process.stdout.write('homes=0 scanned=yes（没有任何有 .claude / .reclaude 的家）\n');
    process.exit(0);
  }
  let exit = 0;
  let bannedEmail = '';
  if (orgId) {
    const org = orgListText(orgListFile);
    if (!org.ok) {
      process.stderr.write(`${org.reason}\n`);
      process.exit(2);
    }
    const found = bannedEmailFromOrgList(org.text, orgId);
    if (!found.ok) {
      process.stderr.write(`${found.reason}\n`);
      process.exit(2);
    }
    bannedEmail = found.email;
  }
  listed.homes.forEach((home, i) => {
    const meta = i === 0 ? { limited: listed.limited, limitReason: listed.limitReason } : {};
    if (orgId) {
      let report;
      try {
        report = scrubBannedAccount(home, { email: bannedEmail, apply, liveEmail: liveOauthEmail(home) });
      } catch (e) {
        process.stderr.write(`home=${home} 写失败：${e.message}\n`);
        exit = 1;
        return;
      }
      printBanned(report, meta);
      if (report.status === 'unscanned' && exit === 0) exit = 2;
      return;
    }
    let report;
    try {
      report = cleanHome(home, { apply });
    } catch (e) {
      process.stderr.write(`home=${home} 写失败：${e.message}\n`);
      exit = 1;
      return;
    }
    printReport(report, meta);
    if (report.status === 'unscanned' && exit === 0) exit = 2;
  });
  process.exit(exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
