import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  bannedEmailFromOrgList,
  classifyAccount,
  cleanHome,
  collectIds,
  homesFromPasswd,
  scrubBannedEmail,
  scrubText,
  stripJson,
} from '../reclaude-old-account-clean.mjs';

const OLD_EMAIL = 'old-acct@example.com';
const NEW_EMAIL = 'current-acct@example.com';
const OLD_ACCOUNT = '11111111-1111-1111-1111-111111111111';
const OLD_ORG = '22222222-2222-2222-2222-222222222222';
const OLD_USER = 'a'.repeat(64);
const SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
  'reclaude-old-account-clean.mjs',
);

function homeWith({
  oauthEmail,
  deviceEmail = NEW_EMAIL,
  withCreds = true,
  memory = '',
  session = '',
  settings = '{"env":{"A":"1"}}\n',
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `oac-${process.pid}-`));
  fs.mkdirSync(path.join(home, '.reclaude'), { recursive: true });
  if (deviceEmail !== null) {
    fs.writeFileSync(
      path.join(home, '.reclaude', 'device.json'),
      JSON.stringify({ user_email: deviceEmail, device_id: 'keep-me' }),
    );
  }
  const claude = {
    oauthAccount: oauthEmail
      ? {
          emailAddress: oauthEmail,
          accountUuid: OLD_ACCOUNT,
          organizationUuid: OLD_ORG,
          displayName: 'a',
        }
      : undefined,
    userID: OLD_USER,
    machineID: 'machine-stay',
    cachedUsageUtilization: { accountUuid: OLD_ACCOUNT },
    keep: true,
  };
  if (!oauthEmail) delete claude.oauthAccount;
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(claude));
  fs.mkdirSync(path.join(home, '.claude', 'backups'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'backups', '.claude.json.backup.1'), JSON.stringify(claude));
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'demo', 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'projects', 'demo', 'memory', 'note.md'),
    memory || '普通笔记，没有旧 id\n',
  );
  fs.writeFileSync(
    path.join(home, '.claude', 'projects', 'demo', 'session.jsonl'),
    session || `log ${OLD_EMAIL}\n`,
  );
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), settings);
  if (withCreds) {
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'secret-token', refreshToken: 'secret-refresh' },
        mcpOAuth: { github: { token: 'gh' } },
      }),
    );
  }
  return home;
}

test('分类：邮箱不同才是旧账号；缺邮箱是没查成，不是没有', () => {
  assert.equal(classifyAccount({ deviceEmail: NEW_EMAIL, oauth: { emailAddress: OLD_EMAIL } }).kind, 'old');
  assert.equal(
    classifyAccount({ deviceEmail: NEW_EMAIL, oauth: { emailAddress: NEW_EMAIL } }).kind,
    'current',
  );
  assert.equal(classifyAccount({ deviceEmail: '', oauth: { emailAddress: OLD_EMAIL } }).kind, 'unscanned');
  assert.equal(classifyAccount({ deviceEmail: NEW_EMAIL, oauth: {} }).kind, 'unscanned');
  assert.equal(classifyAccount({ deviceEmail: NEW_EMAIL, oauth: null }).kind, 'none');
});

test('短显示名不进 id 清单', () => {
  const ids = collectIds({ oauthAccount: { emailAddress: OLD_EMAIL, displayName: 'a' }, userID: OLD_USER });
  assert.deepEqual(ids, [OLD_EMAIL, OLD_USER]);
  assert.equal(scrubText('status a line', ids).hits, 0);
  assert.equal(scrubText(`see ${OLD_EMAIL}`, ids).text, 'see ');
});

test('stripJson 只删相等的字符串，留下别的键', () => {
  const next = stripJson({ keep: true, cached: { accountUuid: OLD_ACCOUNT }, other: 'x' }, [OLD_ACCOUNT]);
  assert.deepEqual(next, { keep: true, cached: {}, other: 'x' });
});

test('旧账号：清 oauth / userID / 凭据 / 备份 / memory，不动 settings、会话、device', () => {
  const home = homeWith({
    oauthEmail: OLD_EMAIL,
    memory: `邮箱 ${OLD_EMAIL} 组织 ${OLD_ORG}\n下一行还在\n`,
  });
  const settingsBefore = fs.readFileSync(path.join(home, '.claude', 'settings.json'));
  const deviceBefore = fs.readFileSync(path.join(home, '.reclaude', 'device.json'));
  const sessionBefore = fs.readFileSync(path.join(home, '.claude', 'projects', 'demo', 'session.jsonl'));

  const dry = cleanHome(home, { apply: false });
  assert.equal(dry.status, 'dirty');
  assert.equal(dry.wrote, false);
  assert.equal(dry.memory, 'scrubbed');
  assert.ok(fs.readFileSync(path.join(home, '.claude.json'), 'utf8').includes(OLD_EMAIL));

  const applied = cleanHome(home, { apply: true });
  assert.equal(applied.status, 'dirty');
  assert.equal(applied.wrote, true);

  const live = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.equal(live.oauthAccount, undefined);
  assert.equal(live.userID, undefined);
  assert.equal(live.machineID, 'machine-stay');
  assert.equal(live.keep, true);
  assert.equal(live.cachedUsageUtilization.accountUuid, undefined);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8').includes(OLD_EMAIL), false);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8').includes(OLD_USER), false);

  const backup = JSON.parse(
    fs.readFileSync(path.join(home, '.claude', 'backups', '.claude.json.backup.1'), 'utf8'),
  );
  assert.equal(backup.oauthAccount, undefined);
  assert.equal(backup.userID, undefined);

  const cred = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'));
  assert.equal(cred.claudeAiOauth, undefined);
  assert.equal(cred.mcpOAuth.github.token, 'gh');

  const note = fs.readFileSync(path.join(home, '.claude', 'projects', 'demo', 'memory', 'note.md'), 'utf8');
  assert.equal(note.includes(OLD_EMAIL), false);
  assert.equal(note.includes(OLD_ORG), false);
  assert.match(note, /下一行还在/);

  assert.deepEqual(fs.readFileSync(path.join(home, '.claude', 'settings.json')), settingsBefore);
  assert.deepEqual(fs.readFileSync(path.join(home, '.reclaude', 'device.json')), deviceBefore);
  assert.deepEqual(
    fs.readFileSync(path.join(home, '.claude', 'projects', 'demo', 'session.jsonl')),
    sessionBefore,
  );

  const again = cleanHome(home, { apply: true });
  assert.equal(again.status, 'clean');
  assert.equal(again.memory, 'no-id-source');
});

test('reclaude 备份里的 claude.json 也清，device.json 不动', () => {
  const home = homeWith({ oauthEmail: OLD_EMAIL, memory: '无\n' });
  const copyDir = path.join(home, '.reclaude', 'backups', '2026-09-23T000000Z');
  fs.mkdirSync(copyDir, { recursive: true });
  fs.writeFileSync(path.join(copyDir, 'claude.json'), fs.readFileSync(path.join(home, '.claude.json')));
  fs.writeFileSync(
    path.join(home, '.reclaude', 'device.json'),
    JSON.stringify({ user_email: NEW_EMAIL, device_id: 'keep-me' }),
  );
  const deviceBefore = fs.readFileSync(path.join(home, '.reclaude', 'device.json'));
  const applied = cleanHome(home, { apply: true });
  assert.equal(applied.wrote, true);
  const copy = JSON.parse(fs.readFileSync(path.join(copyDir, 'claude.json'), 'utf8'));
  assert.equal(copy.oauthAccount, undefined);
  assert.equal(copy.userID, undefined);
  assert.deepEqual(fs.readFileSync(path.join(home, '.reclaude', 'device.json')), deviceBefore);
});

test('reclaude 备份里对不上的 userID 也摘，现账号的 userID 不动', () => {
  const home = homeWith({ oauthEmail: null, withCreds: false });
  const livePath = path.join(home, '.claude.json');
  const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  delete live.oauthAccount;
  const currentUser = 'c'.repeat(64);
  live.userID = currentUser;
  fs.writeFileSync(livePath, JSON.stringify(live));
  fs.rmSync(path.join(home, '.claude', 'backups', '.claude.json.backup.1'));
  const copyDir = path.join(home, '.reclaude', 'backups', 'early');
  fs.mkdirSync(copyDir, { recursive: true });
  fs.writeFileSync(path.join(copyDir, 'claude.json'), JSON.stringify({ userID: 'd'.repeat(64), keep: 1 }));
  const applied = cleanHome(home, { apply: true });
  assert.equal(applied.status, 'dirty');
  assert.equal(applied.reason, 'snapshot-userid');
  assert.equal(applied.memory, 'no-id-source');
  const copy = JSON.parse(fs.readFileSync(path.join(copyDir, 'claude.json'), 'utf8'));
  assert.equal(copy.userID, undefined);
  assert.equal(copy.keep, 1);
  const after = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  assert.equal(after.userID, currentUser);
});

test('现账号：oauth 与凭据原样留下，备份里的旧邮箱仍清', () => {
  const home = homeWith({ oauthEmail: NEW_EMAIL, memory: `旧的 ${OLD_EMAIL} 还在笔记里\n` });
  const currentUser = 'b'.repeat(64);
  const currentAccount = '33333333-3333-3333-3333-333333333333';
  const livePath = path.join(home, '.claude.json');
  const live0 = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  live0.userID = currentUser;
  live0.oauthAccount.accountUuid = currentAccount;
  fs.writeFileSync(livePath, JSON.stringify(live0));
  const backupPath = path.join(home, '.claude', 'backups', '.claude.json.backup.1');
  fs.writeFileSync(
    backupPath,
    JSON.stringify({
      oauthAccount: {
        emailAddress: OLD_EMAIL,
        accountUuid: OLD_ACCOUNT,
        organizationUuid: OLD_ORG,
        displayName: 'a',
      },
      userID: OLD_USER,
      keepBackup: 1,
    }),
  );
  const credBefore = fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8');

  const applied = cleanHome(home, { apply: true });
  assert.equal(applied.wrote, true);
  const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  assert.equal(live.oauthAccount.emailAddress, NEW_EMAIL);
  assert.equal(live.oauthAccount.accountUuid, currentAccount);
  assert.equal(live.userID, currentUser);
  assert.equal(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'), credBefore);
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(backup.oauthAccount, undefined);
  assert.equal(backup.keepBackup, 1);
  const note = fs.readFileSync(path.join(home, '.claude', 'projects', 'demo', 'memory', 'note.md'), 'utf8');
  assert.equal(note.includes(OLD_EMAIL), false);
});

test('没有 device 邮箱：一个字节不写，状态是没查成', () => {
  const home = homeWith({ oauthEmail: OLD_EMAIL, deviceEmail: null });
  fs.writeFileSync(path.join(home, '.reclaude', 'device.json'), JSON.stringify({ device_id: 'x' }));
  const before = fs.readFileSync(path.join(home, '.claude.json'));
  const r = cleanHome(home, { apply: true });
  assert.equal(r.status, 'unscanned');
  assert.equal(r.wrote, false);
  assert.deepEqual(fs.readFileSync(path.join(home, '.claude.json')), before);
});

test('没装 reclaude：跳过，不当成已经干净的旧账号清理', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `oac-none-${process.pid}-`));
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: OLD_EMAIL } }),
  );
  const r = cleanHome(home, { apply: true });
  assert.equal(r.status, 'skipped');
  assert.equal(r.reason, 'no-reclaude');
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8').includes(OLD_EMAIL), true);
});

test('只有 claudeAiOauth、没有邮箱对照：不删，没查成', () => {
  const home = homeWith({ oauthEmail: null, withCreds: true });
  const live = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  delete live.oauthAccount;
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(live));
  fs.rmSync(path.join(home, '.claude', 'backups', '.claude.json.backup.1'));
  const before = fs.readFileSync(path.join(home, '.claude', '.credentials.json'));
  const r = cleanHome(home, { apply: true });
  assert.equal(r.status, 'unscanned');
  assert.deepEqual(fs.readFileSync(path.join(home, '.claude', '.credentials.json')), before);
});

test('passwd 解析只取以 / 开头的家，去重', () => {
  const homes = homesFromPasswd(
    'root:x:0:0:root:/root:/bin/bash\norca:x:1000:1000::/home/orca:/bin/bash\norca:x:1000:1000::/home/orca:/bin/bash\nbad\n# c:x:1:1::/tmp:/bin/sh\n',
  );
  assert.deepEqual(homes, ['/root', '/home/orca']);
});

const BANNED = 'banned-user@example.com';
const OTHER = 'keep-me@example.com';

function orgListFile(home, body) {
  const file = path.join(home, 'org-list.txt');
  fs.writeFileSync(file, body);
  return file;
}

test('被封的号只认点名的编号，不看是不是拼车', () => {
  const text = `*80\tSolo\tpersonal\t${OTHER}\n324\tPool\tteam\t${BANNED}\n`;
  assert.equal(bannedEmailFromOrgList(text, '324').email, BANNED);
  assert.equal(bannedEmailFromOrgList(text, '80').email, OTHER);
  assert.equal(bannedEmailFromOrgList(text, '999').ok, false);
  assert.equal(bannedEmailFromOrgList('', '').ok, false);
  assert.equal(bannedEmailFromOrgList(`324\tPool\tteam\t${BANNED}\t${OTHER}\n`, '324').ok, false);
  assert.equal(bannedEmailFromOrgList('324\tPool\tteam\tno-mail\n', '324').ok, false);
});

test('【故意造出的失败】摘完 JSON 不合法就保持原文', () => {
  const got = scrubBannedEmail('{"a":[1]}\n', '[1]');
  assert.equal(got.broken, true);
  assert.equal(got.text, '{"a":[1]}\n');
});

test('不带 --org 不动会话里的邮箱', () => {
  const home = homeWith({ oauthEmail: OLD_EMAIL });
  const session = path.join(home, '.claude', 'projects', 'demo', 'session.jsonl');
  fs.writeFileSync(session, `${JSON.stringify({ userEmail: BANNED })}\n`);
  const before = fs.readFileSync(session);
  const r = spawnSync(process.execPath, [SCRIPT, '--home', home, '--apply'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(fs.readFileSync(session), before);
});

test('点名被封的号：只摘这一串，settings 没有就不重写，现账号和 device 不动', () => {
  const home = homeWith({ oauthEmail: NEW_EMAIL });
  const session = path.join(home, '.claude', 'projects', 'demo', 'session.jsonl');
  const line = JSON.stringify({
    attachment: { context: { userEmail: `name ${BANNED} tail`, gitStatus: 'clean' } },
    rendered: [{ content: `said ${BANNED} and Banned-User@Example.com and ${NEW_EMAIL}` }],
  });
  fs.writeFileSync(session, `${line}\n`);
  const settings = path.join(home, '.claude', 'settings.json');
  const settingsBefore = fs.readFileSync(settings);
  const deviceBefore = fs.readFileSync(path.join(home, '.reclaude', 'device.json'));
  const orgFile = orgListFile(home, `*80\tSolo\tpersonal\t${NEW_EMAIL}\n324\tPool\tteam\t${BANNED}\n`);

  const dry = spawnSync(
    process.execPath,
    [SCRIPT, '--home', home, '--org', '324', '--org-list-file', orgFile],
    { encoding: 'utf8' },
  );
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /status=dirty/);
  assert.match(dry.stdout, /sessions=scrubbed/);
  assert.equal(dry.stdout.includes(BANNED), false);
  assert.equal(dry.stdout.includes(NEW_EMAIL), false);
  assert.equal(fs.readFileSync(session, 'utf8').includes(BANNED), true);

  const applied = spawnSync(
    process.execPath,
    [SCRIPT, '--home', home, '--org', '324', '--org-list-file', orgFile, '--apply'],
    { encoding: 'utf8' },
  );
  assert.equal(applied.status, 0, applied.stderr);
  const after = fs.readFileSync(session, 'utf8');
  assert.equal(after.toLowerCase().includes(BANNED), false);
  assert.equal(after.includes(NEW_EMAIL), true);
  assert.equal(after.includes('gitStatus'), true);
  assert.doesNotThrow(() => JSON.parse(after));
  assert.deepEqual(fs.readFileSync(settings), settingsBefore);
  assert.deepEqual(fs.readFileSync(path.join(home, '.reclaude', 'device.json')), deviceBefore);
  const live = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.equal(live.oauthAccount.emailAddress, NEW_EMAIL);

  const again = spawnSync(
    process.execPath,
    [SCRIPT, '--home', home, '--org', '324', '--org-list-file', orgFile],
    { encoding: 'utf8' },
  );
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /sessions=none-found/);
});

test('点名独享号同样摘，settings 里有这串才改', () => {
  const home = homeWith({ oauthEmail: NEW_EMAIL });
  const session = path.join(home, '.claude', 'projects', 'demo', 'session.jsonl');
  fs.writeFileSync(session, `${JSON.stringify({ userEmail: OTHER })}\n`);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, `${JSON.stringify({ note: `hello ${OTHER}`, keep: 1 })}\n`);
  const orgFile = orgListFile(home, `*80\tSolo\tpersonal\t${OTHER}\n324\tPool\tteam\t${BANNED}\n`);
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--home', home, '--org', '80', '--org-list-file', orgFile, '--apply'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  const afterSession = fs.readFileSync(session, 'utf8');
  assert.equal(afterSession.includes(OTHER), false);
  assert.doesNotThrow(() => JSON.parse(afterSession));
  const afterSettings = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(afterSettings.keep, 1);
  assert.equal(JSON.stringify(afterSettings).includes(OTHER), false);
});

test('【故意造出的失败】编号不在 org list 里：一个字节不写', () => {
  const home = homeWith({ oauthEmail: NEW_EMAIL });
  const session = path.join(home, '.claude', 'projects', 'demo', 'session.jsonl');
  fs.writeFileSync(session, `${JSON.stringify({ userEmail: BANNED })}\n`);
  const before = fs.readFileSync(session);
  const orgFile = orgListFile(home, `324\tPool\tteam\t${BANNED}\n`);
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--home', home, '--org', '999', '--org-list-file', orgFile, '--apply'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 2);
  assert.deepEqual(fs.readFileSync(session), before);
  assert.equal(r.stdout.includes(BANNED), false);
});

test('命令行输出不带邮箱和 token', () => {
  const home = homeWith({ oauthEmail: OLD_EMAIL, memory: `note ${OLD_EMAIL}\n` });
  const r = spawnSync(process.execPath, [SCRIPT, '--home', home], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.includes(OLD_EMAIL), false);
  assert.equal(r.stdout.includes(OLD_ACCOUNT), false);
  assert.equal(r.stdout.includes('secret-token'), false);
  assert.match(r.stdout, /status=dirty/);
});
