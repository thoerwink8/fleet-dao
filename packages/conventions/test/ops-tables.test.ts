// ops-tables 的测试（#140 第一片端口、第三片用户、第五片目录、第七片单元、第九片密钥名）：除两条读本仓 deploy/ 的用例外，全用内存假仓。

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_NAME_DIRS,
  BLOCK_NAME_PORTS,
  BLOCK_NAME_SECRETS,
  BLOCK_NAME_UNITS,
  checkDirsBlock,
  checkOpsBlocks,
  checkPortsBlock,
  checkSecretsBlock,
  checkUnitsBlock,
  checkUsersBlock,
  extractBlock,
  OPS_BLOCK_NAMES,
  opsDocPaths,
  readDirEntries,
  readSecretEntries,
  readUnitEntries,
  readUserEntries,
  renderDirsBlock,
  renderPortsBlock,
  renderSecretsBlock,
  renderUnitsBlock,
  renderUsersBlock,
  writeOpsBlocks,
} from '../src/ops-tables.ts';
import { fsRepo, type RepoView } from '../src/repo.ts';
import { memRepo } from './helpers.ts';

const FRANCE = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'PG_PORT=5432',
  'TEMPORAL_FRONTEND_PORT=7243',
  'API_PORT=8787',
  '# 注释里的 FAKE_PORT=9999 不算',
  'echo "字符串里的 ALSO_FAKE_PORT=8888 不算"',
  'LATER_PORT=7000',
].join('\n');

const HK = ['#!/usr/bin/env bash', 'WG_PORT=4500', ''].join('\n');

function repo(): RepoView {
  return memRepo({
    'deploy/france.sh': FRANCE,
    'deploy/hk.sh': HK,
    'docs/ops.md': ['# 运维', '', '做法写在 deploy/。', renderPortsBlock(repoWithoutDoc()), ''].join('\n'),
  });
}

function repoWithoutDoc(): RepoView {
  return memRepo({ 'deploy/france.sh': FRANCE, 'deploy/hk.sh': HK });
}

// 生成的区块长什么样（ france.sh 按行号、hk.sh 在 france.sh 后面）：
const EXPECTED_BLOCK = [
  '<!-- fleet:ports:start -->',
  '',
  '| 变量名 | 端口号 | 来源脚本 |',
  '|---|---|---|',
  '| PG_PORT | 5432 | deploy/france.sh |',
  '| TEMPORAL_FRONTEND_PORT | 7243 | deploy/france.sh |',
  '| API_PORT | 8787 | deploy/france.sh |',
  '| LATER_PORT | 7000 | deploy/france.sh |',
  '| WG_PORT | 4500 | deploy/hk.sh |',
  '',
  '<!-- fleet:ports:end -->',
].join('\n');

describe('renderPortsBlock', () => {
  it('两次调用逐字相同', () => {
    const r = repoWithoutDoc();
    expect(renderPortsBlock(r)).toBe(renderPortsBlock(r));
  });

  it('按来源脚本再按行号排，输出一张三列表', () => {
    expect(renderPortsBlock(repoWithoutDoc())).toBe(EXPECTED_BLOCK);
  });

  it('行首不是变量名的端口（注释、字符串里）不读进来', () => {
    const block = renderPortsBlock(repoWithoutDoc());
    expect(block).not.toContain('FAKE_PORT');
    expect(block).not.toContain('9999');
    expect(block).not.toContain('8888');
  });

  it('脚本里一个端口常量都没有，抛错（不是静默给空表）', () => {
    const r = memRepo({ 'deploy/france.sh': 'echo hi\n', 'deploy/hk.sh': HK });
    expect(() => renderPortsBlock(r)).toThrow('deploy/france.sh');
  });

  it('读不到脚本，抛错', () => {
    const r = memRepo({ 'deploy/france.sh': FRANCE });
    expect(() => renderPortsBlock(r)).toThrow('deploy/hk.sh');
  });
});

describe('extractBlock', () => {
  const doc = ['前文', '<!-- fleet:ports:start -->', '里面', '<!-- fleet:ports:end -->', '后文'].join('\n');

  it('取两个标记之间的内容，前后一个字不动', () => {
    expect(extractBlock(doc, BLOCK_NAME_PORTS)).toBe('\n里面\n');
  });

  it('缺开始标记，抛带原因的错', () => {
    const broken = ['里面', '<!-- fleet:ports:end -->'].join('\n');
    expect(() => extractBlock(broken, BLOCK_NAME_PORTS)).toThrow(/开始标记/);
  });

  it('缺结束标记，抛带原因的错', () => {
    const broken = ['<!-- fleet:ports:start -->', '里面'].join('\n');
    expect(() => extractBlock(broken, BLOCK_NAME_PORTS)).toThrow(/结束标记/);
  });

  it('开始标记出现两次，抛带原因的错', () => {
    const broken = [
      '<!-- fleet:ports:start -->',
      '<!-- fleet:ports:start -->',
      '<!-- fleet:ports:end -->',
    ].join('\n');
    expect(() => extractBlock(broken, BLOCK_NAME_PORTS)).toThrow(/开始标记.*2 次/);
  });

  it('结束标记出现两次，抛带原因的错', () => {
    const broken = [
      '<!-- fleet:ports:start -->',
      '<!-- fleet:ports:end -->',
      '<!-- fleet:ports:end -->',
    ].join('\n');
    expect(() => extractBlock(broken, BLOCK_NAME_PORTS)).toThrow(/结束标记.*2 次/);
  });

  it('先结束后开始，抛带原因的错', () => {
    const broken = ['<!-- fleet:ports:end -->', '<!-- fleet:ports:start -->'].join('\n');
    expect(() => extractBlock(broken, BLOCK_NAME_PORTS)).toThrow(/结束标记在开始标记之前/);
  });
});

describe('checkPortsBlock', () => {
  it('区块和生成的一致，返回空数组', () => {
    expect(checkPortsBlock(repo(), 'docs/ops.md')).toEqual([]);
  });

  it('端口常量改一个数，问题里点出是哪个变量；重新生成后返回空数组', () => {
    const r = repo();
    const drifted = memRepo({
      'deploy/france.sh': FRANCE.replace('API_PORT=8787', 'API_PORT=9000'),
      'deploy/hk.sh': HK,
      'docs/ops.md': r.read('docs/ops.md') ?? '',
    });
    const problems = checkPortsBlock(drifted, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.text).toContain('API_PORT');
    expect(problems[0]?.text).toContain('9000');
    expect(problems[0]?.text).toContain('8787');
    expect(problems[0]?.notQueried).toBe(false);
    const fixed = memRepo({
      'deploy/france.sh': FRANCE.replace('API_PORT=8787', 'API_PORT=9000'),
      'deploy/hk.sh': HK,
      'docs/ops.md': (r.read('docs/ops.md') ?? '').replace('| API_PORT | 8787 |', '| API_PORT | 9000 |'),
    });
    expect(checkPortsBlock(fixed, 'docs/ops.md')).toEqual([]);
  });

  it('脚本里多了个端口变量，问题里点出是哪个变量', () => {
    const r = repo();
    const grown = memRepo({
      'deploy/france.sh': `${FRANCE}\nNEW_PORT=1234`,
      'deploy/hk.sh': HK,
      'docs/ops.md': r.read('docs/ops.md') ?? '',
    });
    const problems = checkPortsBlock(grown, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.text).toContain('NEW_PORT');
    expect(problems[0]?.notQueried).toBe(false);
  });

  it('读不到文档，返回「没查成」问题', () => {
    const problems = checkPortsBlock(repoWithoutDoc(), 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('docs/ops.md');
  });

  it('读不到脚本，返回「没查成」问题', () => {
    const r = memRepo({ 'deploy/france.sh': FRANCE, 'docs/ops.md': 'x' });
    const problems = checkPortsBlock(r, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('deploy/hk.sh');
  });

  it('脚本里一个端口常量都没有，返回「没查成」问题，不是空数组', () => {
    const r = memRepo({
      'deploy/france.sh': 'echo hi\n',
      'deploy/hk.sh': HK,
      'docs/ops.md': 'x',
    });
    const problems = checkPortsBlock(r, 'docs/ops.md');
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.notQueried).toBe(true);
  });

  it('端口行都对但区块不是逐字一致（表头被改），返回问题、不当成通过', () => {
    const r = repo();
    const doc = r.read('docs/ops.md') ?? '';
    const reworded = memRepo({
      'deploy/france.sh': FRANCE,
      'deploy/hk.sh': HK,
      'docs/ops.md': doc.replace('| 变量名 | 端口号 | 来源脚本 |', '| Name | Port | Script |'),
    });
    const problems = checkPortsBlock(reworded, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('逐字一致');
  });

  it('端口行都对但行的顺序被手改，返回问题、不当成通过', () => {
    const r = repo();
    const doc = r.read('docs/ops.md') ?? '';
    const reordered = memRepo({
      'deploy/france.sh': FRANCE,
      'deploy/hk.sh': HK,
      'docs/ops.md': doc
        .replace('| PG_PORT | 5432 | deploy/france.sh |\n', '')
        .replace(
          '| WG_PORT | 4500 | deploy/hk.sh |',
          '| WG_PORT | 4500 | deploy/hk.sh |\n| PG_PORT | 5432 | deploy/france.sh |',
        ),
    });
    const problems = checkPortsBlock(reordered, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
  });

  it('区块标记被删，返回对不上的问题（不是没查成）', () => {
    const r = memRepo({
      'deploy/france.sh': FRANCE,
      'deploy/hk.sh': HK,
      'docs/ops.md': '# 运维\n没有区块\n',
    });
    const problems = checkPortsBlock(r, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('开始标记');
  });
});

// 用户表（#140 第三片）：四个脚本各一种写法。假仓里故意夹进不该读的行。
const FRANCE_U = ['SESSION_USERS=("$SESSION_USER")', 'PILOT_USER=pilot', 'PILOT_HOME=/home/pilot'].join('\n');
const HK_U = ['setup_identity() {', '  ensure_service_user fleet /home/fleet', '}'].join('\n');
const HUMAN_U = [
  'setup_identity() {',
  '  ensure_service_user fleet /home/fleet',
  '  for u in "$SESSION_USERS"; do',
  '    ensure_service_user "$u" "/home/$u"',
  '  done',
  '}',
].join('\n');
const SESSION_U = [
  '#!/usr/bin/env bash',
  '# 注释里的 SESSION_USER=ghost 不算',
  '  SESSION_USER=indented-not-read',
  'SESSION_USER=fleet-agent-carpool',
  'SESSION_USER_HOME_ROOT=/home',
].join('\n');
// human-tier.sh 里 zoo 写在 ant 前面：行号顺序和名字的字母顺序相反。
const HUMAN_SORT = [
  '  ensure_service_user zoo /home/zoo',
  '    ensure_service_user "$u" "/home/$u"',
  '  ensure_service_user ant /home/ant',
].join('\n');

function usersFiles(over: Record<string, string> = {}): Record<string, string> {
  return {
    'deploy/france.sh': FRANCE_U,
    'deploy/hk.sh': HK_U,
    'deploy/lib/human-tier.sh': HUMAN_U,
    'deploy/lib/session-user.sh': SESSION_U,
    ...over,
  };
}

function usersRepoWithoutDoc(): RepoView {
  return memRepo(usersFiles());
}

function usersRepo(): RepoView {
  return memRepo(
    usersFiles({
      'docs/ops.md': ['# 运维', '', '做法写在 deploy/。', renderUsersBlock(usersRepoWithoutDoc()), ''].join(
        '\n',
      ),
    }),
  );
}

const USERS_BLOCK = [
  '<!-- fleet:users:start -->',
  '',
  '| 用户 | 来源常量 | 来源脚本 |',
  '|---|---|---|',
  '| pilot | PILOT_USER | deploy/france.sh |',
  '| fleet | ensure_service_user | deploy/hk.sh |',
  '| fleet | ensure_service_user | deploy/lib/human-tier.sh |',
  '| fleet-agent-carpool | SESSION_USER | deploy/lib/session-user.sh |',
  '',
  '<!-- fleet:users:end -->',
].join('\n');

const USERS_SORTED_BLOCK = [
  '<!-- fleet:users:start -->',
  '',
  '| 用户 | 来源常量 | 来源脚本 |',
  '|---|---|---|',
  '| pilot | PILOT_USER | deploy/france.sh |',
  '| fleet | ensure_service_user | deploy/hk.sh |',
  '| zoo | ensure_service_user | deploy/lib/human-tier.sh |',
  '| ant | ensure_service_user | deploy/lib/human-tier.sh |',
  '| fleet-agent-carpool | SESSION_USER | deploy/lib/session-user.sh |',
  '',
  '<!-- fleet:users:end -->',
].join('\n');

describe('renderUsersBlock', () => {
  it('两次调用逐字相同', () => {
    const r = usersRepoWithoutDoc();
    expect(renderUsersBlock(r)).toBe(renderUsersBlock(r));
  });

  it('按来源脚本再按行号排，输出一张三列表', () => {
    const r = memRepo(usersFiles({ 'deploy/lib/human-tier.sh': HUMAN_SORT }));
    expect(renderUsersBlock(r)).toBe(USERS_SORTED_BLOCK);
    expect(renderUsersBlock(usersRepoWithoutDoc())).toBe(USERS_BLOCK);
  });

  it('ensure_service_user "$u" 这类变量名的调用不读进来', () => {
    const users = readUserEntries(usersRepoWithoutDoc()).map((e) => e.user);
    expect(users).not.toContain('u');
    expect(users).not.toContain('$u');
    expect(users).not.toContain('"$u"');
    expect(users).toEqual(['pilot', 'fleet', 'fleet', 'fleet-agent-carpool']);
  });

  it('注释里的 SESSION_USER= 不读进来（不在行首）', () => {
    const users = readUserEntries(usersRepoWithoutDoc()).map((e) => e.user);
    expect(users).not.toContain('ghost');
    expect(users).not.toContain('indented-not-read');
  });

  it('读不到脚本，抛带脚本名的错', () => {
    const missing = memRepo({
      'deploy/france.sh': FRANCE_U,
      'deploy/hk.sh': HK_U,
      'deploy/lib/human-tier.sh': HUMAN_U,
    });
    expect(() => readUserEntries(missing)).toThrow('读不到 deploy/lib/session-user.sh');
  });

  it('某个脚本一个用户都没读到，抛错', () => {
    const r = memRepo(
      usersFiles({
        'deploy/lib/human-tier.sh': 'ensure_service_user "$u" "/home/$u"\n',
      }),
    );
    expect(() => readUserEntries(r)).toThrow('deploy/lib/human-tier.sh 里一个用户都没读到');
  });
});

describe('checkUsersBlock', () => {
  it('区块和生成的一致，返回空数组', () => {
    expect(checkUsersBlock(usersRepo(), 'docs/ops.md')).toEqual([]);
  });

  it('SESSION_USER 的值改一下，问题里点出那一行；重新生成后返回空数组', () => {
    const r = usersRepo();
    const driftedScript = SESSION_U.replace('SESSION_USER=fleet-agent-carpool', 'SESSION_USER=renamed-user');
    const drifted = memRepo(
      usersFiles({
        'deploy/lib/session-user.sh': driftedScript,
        'docs/ops.md': r.read('docs/ops.md') ?? '',
      }),
    );
    const problems = checkUsersBlock(drifted, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.text).toContain('SESSION_USER');
    expect(problems[0]?.text).toContain('renamed-user');
    expect(problems[0]?.text).toContain('fleet-agent-carpool');
    expect(problems[0]?.text).toContain('deploy/lib/session-user.sh');
    expect(problems[0]?.notQueried).toBe(false);
    const regenerated = memRepo(usersFiles({ 'deploy/lib/session-user.sh': driftedScript }));
    const fixed = memRepo(
      usersFiles({
        'deploy/lib/session-user.sh': driftedScript,
        'docs/ops.md': ['# 运维', '', '做法写在 deploy/。', renderUsersBlock(regenerated), ''].join('\n'),
      }),
    );
    expect(checkUsersBlock(fixed, 'docs/ops.md')).toEqual([]);
  });

  it('读不到文档，返回「没查成」问题', () => {
    const problems = checkUsersBlock(usersRepoWithoutDoc(), 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('docs/ops.md');
  });

  it('读不到脚本，返回「没查成」问题', () => {
    const r = memRepo({
      'deploy/france.sh': FRANCE_U,
      'deploy/hk.sh': HK_U,
      'deploy/lib/human-tier.sh': HUMAN_U,
      'docs/ops.md': 'x',
    });
    const problems = checkUsersBlock(r, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('deploy/lib/session-user.sh');
  });

  it('某个脚本一个用户都没有，返回「没查成」问题，不是空数组', () => {
    const r = memRepo(
      usersFiles({
        'deploy/lib/human-tier.sh': 'echo hi\n',
        'docs/ops.md': 'x',
      }),
    );
    const problems = checkUsersBlock(r, 'docs/ops.md');
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('deploy/lib/human-tier.sh');
  });

  it('同一来源里删掉前面的用户，只报少了的那一个，后面仍在的不算变了', () => {
    const files = usersFiles({ 'deploy/lib/human-tier.sh': HUMAN_SORT });
    const doc = renderUsersBlock(memRepo(files)).replace(
      '| zoo | ensure_service_user | deploy/lib/human-tier.sh |\n',
      '',
    );
    const problems = checkUsersBlock(memRepo({ ...files, 'docs/ops.md': doc }), 'docs/ops.md');
    expect(problems).toEqual([
      {
        notQueried: false,
        text: '用户 zoo 少了：来源常量 ensure_service_user（deploy/lib/human-tier.sh），脚本里是 zoo，文档区块里没有。',
      },
    ]);
  });

  // 故意造出失败：文档里的用户名被手改，核对必须报不一致，不能当成没查成或通过。
  it('文档区块里手改一个用户名，返回非空且 notQueried 为 false', () => {
    const r = usersRepo();
    const edited = memRepo(
      usersFiles({
        'docs/ops.md': (r.read('docs/ops.md') ?? '').replace(
          '| pilot | PILOT_USER |',
          '| founder | PILOT_USER |',
        ),
      }),
    );
    const problems = checkUsersBlock(edited, 'docs/ops.md');
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.notQueried === false)).toBe(true);
    expect(problems.some((p) => p.text.includes('pilot') && p.text.includes('founder'))).toBe(true);
  });
});

// 目录表（#140 第五片）：三个脚本各至少一条 ensure_dir，测试只改自己关心的那个。
function dirsFiles(over: Record<string, string> = {}): Record<string, string> {
  return {
    'deploy/france.sh': 'RELEASES_DIR=/srv/fleet-dao-releases\nensure_dir /srv/a root:root 755\n',
    'deploy/hk.sh': 'ensure_dir /etc/fleet-dao root:fleet 750\n',
    'deploy/lib/human-tier.sh': 'ensure_dir /opt/fleet-dao root:root 755\n',
    ...over,
  };
}

/** shell 的 ${名字} 写法；拆开拼，免得被当成模板字符串占位符。 */
function braced(name: string): string {
  return `$\u007b${name}}`;
}

function dirsDoc(files: Record<string, string>): string {
  return ['# 运维', '', renderDirsBlock(memRepo(files)), ''].join('\n');
}

describe('readDirEntries / renderDirsBlock', () => {
  it('区块名字对外是 dirs', () => {
    expect(BLOCK_NAME_DIRS).toBe('dirs');
  });

  it('ensure_dir /etc/fleet-dao root:fleet 750 生成一行带来源脚本的表', () => {
    const block = renderDirsBlock(memRepo(dirsFiles()));
    expect(block).toContain('| /etc/fleet-dao | root:fleet | 750 | deploy/hk.sh |');
    expect(
      block.startsWith(
        '<!-- fleet:dirs:start -->\n\n| 路径 | 属主:组 | 权限 | 来源脚本 |\n|---|---|---|---|\n',
      ),
    ).toBe(true);
    expect(block.endsWith('\n\n<!-- fleet:dirs:end -->')).toBe(true);
  });

  it('行按路径、再按来源脚本排；两次调用逐字相同', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/france.sh': 'ensure_dir /z root:root 755\nensure_dir /etc/fleet-dao root:fleet 750\n',
      }),
    );
    const rows = renderDirsBlock(r)
      .split('\n')
      .filter((l) => l.startsWith('| /'));
    expect(rows).toEqual([
      '| /etc/fleet-dao | root:fleet | 750 | deploy/france.sh |',
      '| /etc/fleet-dao | root:fleet | 750 | deploy/hk.sh |',
      '| /opt/fleet-dao | root:root | 755 | deploy/lib/human-tier.sh |',
      '| /z | root:root | 755 | deploy/france.sh |',
    ]);
    expect(renderDirsBlock(r)).toBe(renderDirsBlock(r));
  });

  it('"$RELEASES_DIR" 有赋值时展开成字面路径，花括号和不带引号的写法也行', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/hk.sh':
          'ensure_dir "$RELEASES_DIR" root:root 755\nensure_dir ' +
          braced('RELEASES_DIR') +
          '/x root:root 755\n',
      }),
    );
    const paths = readDirEntries(r).map((e) => e.path);
    expect(paths).toContain('/srv/fleet-dao-releases');
    expect(paths).toContain('/srv/fleet-dao-releases/x');
  });

  it('缩进的赋值和链式赋值能展开：BASE=/srv/x、SUB=$BASE/y', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/hk.sh': '  BASE=/srv/x\nSUB=$BASE/y\n  ensure_dir "$SUB" root:root 755\n',
      }),
    );
    expect(readDirEntries(r).map((e) => e.path)).toContain('/srv/x/y');
  });

  it('赋值后面的注释不进值；值里的 $PG_MAJOR 递归展开', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/france.sh':
          'PG_MAJOR=16 # 注释\nPG_UNIT=postgresql@$PG_MAJOR-main.service\nensure_dir "/etc/systemd/system/$PG_UNIT.d" root:root 755\n',
      }),
    );
    expect(readDirEntries(r).map((e) => e.path)).toContain(
      '/etc/systemd/system/postgresql@16-main.service.d',
    );
  });

  it('同一脚本的赋值优先，其次 deploy/lib，再 france.sh、hk.sh', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/france.sh': 'D=/from-france\nensure_dir /srv/a root:root 755\n',
        'deploy/hk.sh': 'D=/from-hk\nensure_dir "$D" root:root 755\n',
        'deploy/lib/human-tier.sh': 'ensure_dir "$D" root:root 755\n',
        'deploy/lib/other.sh': 'D=/from-lib\n',
      }),
    );
    const byScript = Object.fromEntries(readDirEntries(r).map((e) => [e.script, e.path]));
    expect(byScript['deploy/hk.sh']).toBe('/from-hk');
    expect(byScript['deploy/lib/human-tier.sh']).toBe('/from-lib');
    const noLib = memRepo(
      dirsFiles({
        'deploy/france.sh': 'D=/from-france\nensure_dir /srv/a root:root 755\n',
        'deploy/hk.sh': 'ensure_dir /h root:root 755\n',
        'deploy/lib/human-tier.sh': 'ensure_dir "$D" root:root 755\n',
      }),
    );
    expect(readDirEntries(noLib).find((e) => e.script === 'deploy/lib/human-tier.sh')?.path).toBe(
      '/from-france',
    );
  });

  // 故意造出失败：变量展开不了，必须抛错，不能静默跳过这一行。
  it('变量找不到赋值，抛带脚本名和行号的错', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/hk.sh': 'echo hi\nensure_dir "$NOPE" root:root 755\n',
      }),
    );
    expect(() => readDirEntries(r)).toThrow('deploy/hk.sh:2');
    expect(() => readDirEntries(r)).toThrow('NOPE');
  });

  it('赋值值里有 $( 命令替换，抛带赋值所在脚本和行号的错', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/hk.sh': 'CMD_DIR=$(mktemp -d)\nensure_dir "$CMD_DIR" root:root 755\n',
      }),
    );
    expect(() => readDirEntries(r)).toThrow('deploy/hk.sh:1');
  });

  it('变量互相引用绕成圈，抛错', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/hk.sh': 'A=$B\nB=$A\nensure_dir "$A" root:root 755\n',
      }),
    );
    expect(() => readDirEntries(r)).toThrow('绕成了圈');
  });

  it('ensure_dir 不足三个参数，抛错', () => {
    const r = memRepo(dirsFiles({ 'deploy/hk.sh': 'ensure_dir /only-path\n' }));
    expect(() => readDirEntries(r)).toThrow('deploy/hk.sh:1');
  });

  it('读不到脚本抛错；某个脚本一个目录都没有也抛错', () => {
    const { 'deploy/hk.sh': _hk, ...noHk } = dirsFiles();
    expect(() => readDirEntries(memRepo(noHk))).toThrow('读不到 deploy/hk.sh');
    expect(() => readDirEntries(memRepo(dirsFiles({ 'deploy/hk.sh': 'echo hi\n' })))).toThrow(
      'deploy/hk.sh 里一个目录都没读到',
    );
  });

  it('注释里的 ensure_dir、不在行首的 ensure_dir 不读', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/hk.sh':
          'ensure_dir /real root:root 755\n# ensure_dir /commented root:root 755\necho ensure_dir /echoed root:root 755\nensure_dir() { :; }\n',
      }),
    );
    const paths = readDirEntries(r).map((e) => e.path);
    expect(paths).toContain('/real');
    expect(paths).not.toContain('/commented');
    expect(paths).not.toContain('/echoed');
  });

  it('循环变量：for u in 循环里的 "/home/$u" 不进表，没有赋值的 $NOPE 照样抛错', () => {
    const oneLiner = memRepo(
      dirsFiles({
        'deploy/hk.sh':
          'ensure_dir /fixed root:root 755\nfor u in a b; do ensure_dir "/home/$u" "$u:$u" 750; done\n',
      }),
    );
    expect(readDirEntries(oneLiner).map((e) => e.path)).toEqual(['/fixed', '/opt/fleet-dao', '/srv/a']);
    const loop = memRepo(
      dirsFiles({
        'deploy/lib/human-tier.sh':
          'ensure_dir /fixed root:root 755\nfor u in "' +
          braced('USERS[@]') +
          '"; do\n  ensure_dir "/home/$u" "$u:$u" 750\n  ensure_dir "/var/$NOPE" root:root 755\ndone\n',
      }),
    );
    expect(() => readDirEntries(loop)).toThrow('deploy/lib/human-tier.sh:4');
    const loopOnly = memRepo(
      dirsFiles({
        'deploy/lib/human-tier.sh':
          'ensure_dir /fixed root:root 755\nfor u in "' +
          braced('USERS[@]') +
          '"; do\n  ensure_dir "/home/$u" "$u:$u" 750\ndone\n',
      }),
    );
    const paths = readDirEntries(loopOnly).map((e) => e.path);
    expect(paths).toContain('/fixed');
    expect(paths.some((p) => p.includes('$') || p.startsWith('/home/'))).toBe(false);
  });

  it('只看路径判循环：路径固定、属主里有循环变量的行不被丢，展开不了就抛错；属主有赋值则进表', () => {
    const noAssign = memRepo(
      dirsFiles({
        'deploy/hk.sh': 'for u in a b; do\n  ensure_dir /shared "$u:$u" 750\ndone\n',
      }),
    );
    expect(() => readDirEntries(noAssign)).toThrow('deploy/hk.sh:2');
    const withAssign = memRepo(
      dirsFiles({
        'deploy/hk.sh': 'u=root\nfor u in a b; do\n  ensure_dir /shared "$u:$u" 750\ndone\n',
      }),
    );
    expect(readDirEntries(withAssign).find((e) => e.path === '/shared')?.owner).toBe('root:root');
  });

  it('真仓库的 deploy/ 读得出来：有 .train，没有带 $ 的路径', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const entries = readDirEntries(fsRepo(root));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('/srv/fleet-dao-releases/.train');
    expect(paths).toContain('/etc/systemd/system/postgresql@16-main.service.d');
    expect(paths.filter((p) => p.includes('$'))).toEqual([]);
    expect(entries.every((e) => !e.owner.includes('$') && /^[0-7]{3,4}$/.test(e.mode))).toBe(true);
  });
});

describe('checkDirsBlock', () => {
  it('区块和生成的一致，返回空数组', () => {
    const files = dirsFiles();
    const r = memRepo({ ...files, 'docs/ops.md': dirsDoc(files) });
    expect(checkDirsBlock(r, 'docs/ops.md')).toEqual([]);
  });

  it('读不到文档、变量展开不了，返回「没查成」', () => {
    const files = dirsFiles();
    expect(checkDirsBlock(memRepo(files), 'docs/ops.md')[0]?.notQueried).toBe(true);
    const broken = memRepo({
      ...files,
      'deploy/hk.sh': 'ensure_dir "$NOPE" root:root 755\n',
      'docs/ops.md': dirsDoc(files),
    });
    const problems = checkDirsBlock(broken, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('deploy/hk.sh:1');
  });

  it('文档区块缺失，报一条点出文档路径的问题', () => {
    const r = memRepo({ ...dirsFiles(), 'docs/ops.md': '# 运维\n' });
    const problems = checkDirsBlock(r, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('docs/ops.md');
    expect(problems[0]?.text).toContain('缺开始标记');
  });

  it('文档里多一行，报一条点出路径的问题', () => {
    const files = dirsFiles();
    const doc = dirsDoc(files).replace(
      '| /srv/a |',
      '| /extra/dir | root:root | 755 | deploy/hk.sh |\n| /srv/a |',
    );
    const problems = checkDirsBlock(memRepo({ ...files, 'docs/ops.md': doc }), 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('/extra/dir');
    expect(problems[0]?.text).toContain('多了');
  });

  it('文档里少一行，报一条点出路径的问题', () => {
    const files = dirsFiles();
    const doc = dirsDoc(files).replace(
      '| /opt/fleet-dao | root:root | 755 | deploy/lib/human-tier.sh |\n',
      '',
    );
    const problems = checkDirsBlock(memRepo({ ...files, 'docs/ops.md': doc }), 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.text).toContain('/opt/fleet-dao');
    expect(problems[0]?.text).toContain('少了');
  });

  it('文档里属主写错，报一条点出路径的问题；权限写错同理', () => {
    const files = dirsFiles();
    const owner = dirsDoc(files).replace('| /etc/fleet-dao | root:fleet |', '| /etc/fleet-dao | root:root |');
    const p1 = checkDirsBlock(memRepo({ ...files, 'docs/ops.md': owner }), 'docs/ops.md');
    expect(p1).toHaveLength(1);
    expect(p1[0]?.notQueried).toBe(false);
    expect(p1[0]?.text).toContain('/etc/fleet-dao');
    expect(p1[0]?.text).toContain('root:root');
    expect(p1[0]?.text).toContain('root:fleet');
    const mode = dirsDoc(files).replace('| root:fleet | 750 |', '| root:fleet | 700 |');
    const p2 = checkDirsBlock(memRepo({ ...files, 'docs/ops.md': mode }), 'docs/ops.md');
    expect(p2).toHaveLength(1);
    expect(p2[0]?.text).toContain('/etc/fleet-dao');
  });

  it('行都对但顺序被改，返回问题、不当成通过', () => {
    const files = dirsFiles();
    const lines = dirsDoc(files).split('\n');
    const a = lines.findIndex((l) => l.startsWith('| /etc/fleet-dao'));
    const b = lines.findIndex((l) => l.startsWith('| /opt/fleet-dao'));
    [lines[a], lines[b]] = [lines[b] ?? '', lines[a] ?? ''];
    const problems = checkDirsBlock(memRepo({ ...files, 'docs/ops.md': lines.join('\n') }), 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.text).toContain('逐字一致');
  });
});

// 单元表（#140 第七片）
function unitsFiles(over: Record<string, string> = {}): Record<string, string> {
  return {
    'deploy/hk/fleet-feishu.service':
      '[Unit]\nDescription=fleet-dao 飞书网关\n\n[Service]\nExecStart=/bin/true\n',
    'deploy/hk/hk.env.example': 'DESCRIPTION=不是单元\n',
    'deploy/france/fleet-api.socket': '[Unit]\nDescription=驾驶舱后端的监听套接字\n',
    'deploy/france/fleet-api.service': '[Unit]\nDescription=驾驶舱后端\n',
    'deploy/france/fleet-auto-release.timer': '[Unit]\nDescription=每 5 分钟读一轮主线\n',
    'deploy/france/fleet-mirasim-session.service':
      '[Unit]\nDescription=会话用户 @@SESSION_USER@@ 的 Mirasim 服务\n',
    'deploy/france/fleet-agents.slice': '[Unit]\nDescription=AI 会话资源池\n',
    'deploy/france/fleet-release-request.path': '[Unit]\nDescription=发布请求一到就接活\n',
    'deploy/france/france.env.example': 'Description=不是单元\n',
    'deploy/france/fleet-dao.nft': 'Description=不是单元\n',
    ...over,
  };
}

function unitsDoc(files: Record<string, string>): string {
  return ['# 运维', '', renderUnitsBlock(memRepo(files)), '', '后面的字。', ''].join('\n');
}

describe('单元表（第七片）', () => {
  it('deploy/hk/fleet-feishu.service 生成「香港」行，说明原样', () => {
    const block = renderUnitsBlock(memRepo(unitsFiles()));
    expect(block).toContain('| fleet-feishu.service | 香港 | fleet-dao 飞书网关 |');
    expect(BLOCK_NAME_UNITS).toBe('units');
  });

  it('.socket、.timer、.path、.slice 都进表，占位符不替换，非单元文件不进表', () => {
    const block = renderUnitsBlock(memRepo(unitsFiles()));
    expect(block).toContain('| fleet-api.socket | 法国 | 驾驶舱后端的监听套接字 |');
    expect(block).toContain('| fleet-auto-release.timer | 法国 | 每 5 分钟读一轮主线 |');
    expect(block).toContain('| fleet-release-request.path | 法国 | 发布请求一到就接活 |');
    expect(block).toContain('| fleet-agents.slice | 法国 | AI 会话资源池 |');
    expect(block).toContain(
      '| fleet-mirasim-session.service | 法国 | 会话用户 @@SESSION_USER@@ 的 Mirasim 服务 |',
    );
    expect(block).not.toContain('env.example');
    expect(block).not.toContain('.nft');
  });

  it('整个区块：标记、固定表头，行按机器（法国、香港）再按文件名排，两次生成逐字相同', () => {
    const r = memRepo(unitsFiles());
    expect(renderUnitsBlock(r)).toBe(renderUnitsBlock(r));
    expect(renderUnitsBlock(r)).toBe(
      [
        '<!-- fleet:units:start -->',
        '',
        '| 单元文件 | 机器 | 说明 |',
        '|---|---|---|',
        '| fleet-agents.slice | 法国 | AI 会话资源池 |',
        '| fleet-api.service | 法国 | 驾驶舱后端 |',
        '| fleet-api.socket | 法国 | 驾驶舱后端的监听套接字 |',
        '| fleet-auto-release.timer | 法国 | 每 5 分钟读一轮主线 |',
        '| fleet-mirasim-session.service | 法国 | 会话用户 @@SESSION_USER@@ 的 Mirasim 服务 |',
        '| fleet-release-request.path | 法国 | 发布请求一到就接活 |',
        '| fleet-feishu.service | 香港 | fleet-dao 飞书网关 |',
        '',
        '<!-- fleet:units:end -->',
      ].join('\n'),
    );
  });

  it('只有一个目录在、另一个列不出来，照样生成', () => {
    const r = memRepo({
      'deploy/hk/fleet-feishu.service': 'Description=fleet-dao 飞书网关\n',
    });
    expect(readUnitEntries(r)).toEqual([
      {
        file: 'fleet-feishu.service',
        machine: '香港',
        description: 'fleet-dao 飞书网关',
      },
    ]);
  });

  it('Description 值末尾的空格和制表符原样保留', () => {
    const r = memRepo({
      'deploy/hk/fleet-feishu.service': 'Description=飞书网关 \t\n',
    });
    expect(readUnitEntries(r)[0]?.description).toBe('飞书网关 \t');
  });

  it('故意失败：单元文件没有 Description 行，抛带文件名的错', () => {
    const r = memRepo(
      unitsFiles({
        'deploy/france/fleet-api.timer': '[Unit]\nAfter=network.target\n',
      }),
    );
    expect(() => renderUnitsBlock(r)).toThrow('deploy/france/fleet-api.timer');
    expect(() => readUnitEntries(r)).toThrow('Description=');
  });

  it('Description 值空着、或带 |，也原样返回，生成的区块和核对一致', () => {
    const files = unitsFiles({
      'deploy/hk/fleet-feishu.service': 'Description=a | b\n',
      'deploy/france/fleet-api.timer': 'Description=\n',
    });
    const entries = readUnitEntries(memRepo(files));
    expect(entries.find((e) => e.file === 'fleet-feishu.service')?.description).toBe('a | b');
    expect(entries.find((e) => e.file === 'fleet-api.timer')?.description).toBe('');
    expect(checkUnitsBlock(memRepo({ ...files, 'docs/ops.md': unitsDoc(files) }), 'docs/ops.md')).toEqual([]);
  });

  it('说明带 | 时，表格里写成 \\|，核对按同样写法比，写成没转义的会被报出来', () => {
    const files = unitsFiles({
      'deploy/hk/fleet-feishu.service': 'Description=a | b\n',
    });
    const block = renderUnitsBlock(memRepo(files));
    expect(block).toContain('| fleet-feishu.service | 香港 | a \\| b |');
    expect(block).not.toContain('| 香港 | a | b |');
    const raw = unitsDoc(files).replace('a \\| b', 'a | b');
    const problems = checkUnitsBlock(memRepo({ ...files, 'docs/ops.md': raw }), 'docs/ops.md');
    expect(problems.some((p) => p.text.includes('fleet-feishu.service'))).toBe(true);
  });

  it('故意失败：两个目录都列不出来、或下面一个单元文件都没有，抛错，不当成空表', () => {
    expect(() => readUnitEntries(memRepo({ 'README.md': 'x' }))).toThrow('列不出');
    expect(() => readUnitEntries(memRepo({ 'deploy/france/': '', 'deploy/hk/': '' }))).toThrow(
      '一个单元文件都没读到',
    );
  });

  it('文档和生成一致，没有问题', () => {
    const files = unitsFiles();
    expect(checkUnitsBlock(memRepo({ ...files, 'docs/ops.md': unitsDoc(files) }), 'docs/ops.md')).toEqual([]);
  });

  it('少一行、多一行、说明被手改，各报一条点出文件名的问题', () => {
    const files = unitsFiles();
    const check = (doc: string) => checkUnitsBlock(memRepo({ ...files, 'docs/ops.md': doc }), 'docs/ops.md');

    const missing = check(unitsDoc(files).replace('| fleet-api.service | 法国 | 驾驶舱后端 |\n', ''));
    expect(missing).toHaveLength(1);
    expect(missing[0]?.notQueried).toBe(false);
    expect(missing[0]?.text).toContain('fleet-api.service');
    expect(missing[0]?.text).toContain('少了');

    const extra = check(
      unitsDoc(files).replace(
        '| fleet-agents.slice',
        '| fleet-ghost.service | 法国 | 不存在 |\n| fleet-agents.slice',
      ),
    );
    expect(extra).toHaveLength(1);
    expect(extra[0]?.text).toContain('fleet-ghost.service');
    expect(extra[0]?.text).toContain('多了');

    const edited = check(unitsDoc(files).replace('fleet-dao 飞书网关', '手改的说明'));
    expect(edited).toHaveLength(1);
    expect(edited[0]?.text).toContain('fleet-feishu.service');
    expect(edited[0]?.text).toContain('手改的说明');
    expect(edited[0]?.text).toContain('fleet-dao 飞书网关');
  });

  it('行都对但顺序被改，返回问题、不当成通过', () => {
    const files = unitsFiles();
    const lines = unitsDoc(files).split('\n');
    const a = lines.findIndex((l) => l.startsWith('| fleet-api.service'));
    const b = lines.findIndex((l) => l.startsWith('| fleet-feishu.service'));
    [lines[a], lines[b]] = [lines[b] ?? '', lines[a] ?? ''];
    const problems = checkUnitsBlock(memRepo({ ...files, 'docs/ops.md': lines.join('\n') }), 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.text).toContain('逐字一致');
  });

  it('读不到文档、区块缺失、单元文件缺 Description，各返回问题，不当成通过', () => {
    const files = unitsFiles();
    const noDoc = checkUnitsBlock(memRepo(files), 'docs/ops.md');
    expect(noDoc).toHaveLength(1);
    expect(noDoc[0]?.notQueried).toBe(true);
    const noBlock = checkUnitsBlock(memRepo({ ...files, 'docs/ops.md': '# 运维\n' }), 'docs/ops.md');
    expect(noBlock).toHaveLength(1);
    expect(noBlock[0]?.notQueried).toBe(false);
    expect(noBlock[0]?.text).toContain('缺开始标记');
    const bad = checkUnitsBlock(
      memRepo({
        ...files,
        'deploy/hk/fleet-feishu.service': '[Unit]\n',
        'docs/ops.md': unitsDoc(files),
      }),
      'docs/ops.md',
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]?.notQueried).toBe(true);
    expect(bad[0]?.text).toContain('fleet-feishu.service');
  });

  it('本仓 deploy/ 能生成：每个单元都有说明', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const entries = readUnitEntries(fsRepo(root));
    expect(entries.map((e) => e.file)).toContain('fleet-feishu.service');
    expect(entries.map((e) => e.file)).toContain('fleet-api.socket');
    for (const e of entries) expect(e.description).not.toBe('');
  });

  // 第 8 片：docs/ops.md 里那一块是不是逐字照生成器写的，只有把真文档和生成器的输出当场比一遍才说得清
  // （核对函数据此返回空，CI 只改文档也拦得住手改）。
  it('本仓 docs/ops.md 的单元区块逐字等于 renderUnitsBlock 的输出', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const repo = fsRepo(root);
    const doc = repo.read('docs/ops.md');
    expect(doc).toBeDefined();
    const block = renderUnitsBlock(repo);
    expect(doc).toContain(block);
    // 表头加五条点名的数据行逐字在区块里（验收条第 1 条点名的单元：法国四条、香港一条）。
    for (const row of [
      '| 单元文件 | 机器 | 说明 |',
      '| fleet-engine.service | 法国 | fleet-dao 引擎工人（Temporal worker） |',
      '| fleet-api.socket | 法国 | fleet-dao 驾驶舱后端的监听套接字（驾驶舱接口 + fleet 命令接口） |',
      '| fleet-auto-release.timer | 法国 | fleet-dao 自动发布单元每 5 分钟读一轮主线（只读） |',
      '| fleet-agents.slice | 法国 | fleet-dao AI 会话资源池（总量上限，单会话各自的上限由引擎起会话时给） |',
      '| fleet-feishu.service | 香港 | fleet-dao 飞书网关 |',
    ]) {
      expect(block).toContain(row);
    }
    expect(checkUnitsBlock(repo, 'docs/ops.md')).toEqual([]);
  });
});

const FINGERPRINT = 'abc123def4567890feedface0000111122223333444455556666777788889999';
const PUBLIC_MARKER = 'PUBLIC-VALUE-MARKER-xyz';

function secretsConfig(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    说明: '假配置',
    formatVersion: 1,
    files: {
      'engine.env': {
        FLEET_ENGINE_PORTS: { value: PUBLIC_MARKER, 说明: '公开值' },
        TEMPORAL_NAMESPACE: 'fleet',
      },
      'api.env': {
        FLEET_PUBLIC_URL: { private: FINGERPRINT, 说明: '私有值' },
        FLEET_ENV: 'production',
        FLEET_MACHINE_NAME: { value: '法国' },
        FLEET_ADMIN_TOKEN: { private: null },
      },
      ...over,
    },
  });
}

function secretsFiles(config: string = secretsConfig()): Record<string, string> {
  return { 'deploy/france/desired-config.json': config };
}

function secretsDoc(files: Record<string, string>): string {
  return ['# 运维', '', renderSecretsBlock(memRepo(files)), ''].join('\n');
}

describe('密钥名表（第九片）', () => {
  it('带 private 的键生成「| 文件 | 键名 |」行，private 为 null 也算，行按文件名、键名排', () => {
    const block = renderSecretsBlock(memRepo(secretsFiles()));
    expect(BLOCK_NAME_SECRETS).toBe('secrets');
    expect(block).toContain('| api.env | FLEET_PUBLIC_URL |');
    expect(block).toBe(
      [
        '<!-- fleet:secrets:start -->',
        '',
        '| 文件 | 键名 |',
        '|---|---|',
        '| api.env | FLEET_ADMIN_TOKEN |',
        '| api.env | FLEET_PUBLIC_URL |',
        '',
        '<!-- fleet:secrets:end -->',
      ].join('\n'),
    );
    expect(renderSecretsBlock(memRepo(secretsFiles()))).toBe(block);
  });

  it('带 value 的公开键和字符串值的键不进表', () => {
    expect(readSecretEntries(memRepo(secretsFiles()))).toEqual([
      { file: 'api.env', key: 'FLEET_ADMIN_TOKEN' },
      { file: 'api.env', key: 'FLEET_PUBLIC_URL' },
    ]);
    const block = renderSecretsBlock(memRepo(secretsFiles()));
    for (const name of [
      'FLEET_ENGINE_PORTS',
      'TEMPORAL_NAMESPACE',
      'FLEET_ENV',
      'FLEET_MACHINE_NAME',
      'engine.env',
    ])
      expect(block).not.toContain(name);
  });

  it('渲染结果里没有 private 指纹，也没有任何 value 的内容', () => {
    const block = renderSecretsBlock(memRepo(secretsFiles()));
    expect(block).not.toContain(FINGERPRINT);
    expect(block).not.toContain('abc123');
    expect(block).not.toContain(PUBLIC_MARKER);
    expect(block).not.toContain('法国');
    expect(block).not.toContain('private');
  });

  it('故意失败：JSON 坏了抛带文件名的错，不返回空表', () => {
    const r = memRepo(secretsFiles('{ "files": '));
    expect(() => readSecretEntries(r)).toThrow('deploy/france/desired-config.json');
    expect(() => renderSecretsBlock(r)).toThrow('JSON');
  });

  it('故意失败：读不到文件、files 缺失、文件内容不是对象、一个密钥名都没有，各抛带文件名的错', () => {
    expect(() => readSecretEntries(memRepo({ 'README.md': 'x' }))).toThrow(
      '读不到 deploy/france/desired-config.json',
    );
    expect(() => readSecretEntries(memRepo(secretsFiles('{"formatVersion":1}')))).toThrow('files');
    expect(() => readSecretEntries(memRepo(secretsFiles('[]')))).toThrow('deploy/france/desired-config.json');
    expect(() => readSecretEntries(memRepo(secretsFiles(secretsConfig({ 'bad.env': 'oops' }))))).toThrow(
      'files.bad.env',
    );
    expect(() => readSecretEntries(memRepo(secretsFiles('{"files":{"a.env":{"X":{"value":"1"}}}}')))).toThrow(
      '一个密钥名',
    );
  });

  it('键名写法进不了表格时抛带文件名和键名的错', () => {
    const cfg = secretsConfig({ 'x.env': { 'BAD KEY': { private: 'p' } } });
    expect(() => readSecretEntries(memRepo(secretsFiles(cfg)))).toThrow('x.env.BAD KEY');
  });

  it('文档和生成一致，没有问题', () => {
    const files = secretsFiles();
    expect(checkSecretsBlock(memRepo({ ...files, 'docs/ops.md': secretsDoc(files) }), 'docs/ops.md')).toEqual(
      [],
    );
  });

  it('少一行、多一行，各报一条点出键名的问题', () => {
    const files = secretsFiles();
    const check = (doc: string) =>
      checkSecretsBlock(memRepo({ ...files, 'docs/ops.md': doc }), 'docs/ops.md');

    const missing = check(secretsDoc(files).replace('| api.env | FLEET_PUBLIC_URL |\n', ''));
    expect(missing).toHaveLength(1);
    expect(missing[0]?.notQueried).toBe(false);
    expect(missing[0]?.text).toContain('FLEET_PUBLIC_URL');
    expect(missing[0]?.text).toContain('少了');

    const extra = check(
      secretsDoc(files).replace(
        '| api.env | FLEET_ADMIN_TOKEN |',
        '| api.env | FLEET_GHOST_KEY |\n| api.env | FLEET_ADMIN_TOKEN |',
      ),
    );
    expect(extra).toHaveLength(1);
    expect(extra[0]?.notQueried).toBe(false);
    expect(extra[0]?.text).toContain('FLEET_GHOST_KEY');
    expect(extra[0]?.text).toContain('多了');
  });

  it('行都对但顺序被改，返回问题、不当成通过', () => {
    const files = secretsFiles();
    const lines = secretsDoc(files).split('\n');
    const a = lines.findIndex((l) => l.startsWith('| api.env | FLEET_ADMIN_TOKEN'));
    const b = lines.findIndex((l) => l.startsWith('| api.env | FLEET_PUBLIC_URL'));
    [lines[a], lines[b]] = [lines[b] ?? '', lines[a] ?? ''];
    const problems = checkSecretsBlock(memRepo({ ...files, 'docs/ops.md': lines.join('\n') }), 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.text).toContain('逐字一致');
  });

  it('读不到文档、区块缺失、配置坏了，各返回问题，不当成通过', () => {
    const files = secretsFiles();
    const noDoc = checkSecretsBlock(memRepo(files), 'docs/ops.md');
    expect(noDoc).toHaveLength(1);
    expect(noDoc[0]?.notQueried).toBe(true);
    const noBlock = checkSecretsBlock(memRepo({ ...files, 'docs/ops.md': '# 运维\n' }), 'docs/ops.md');
    expect(noBlock).toHaveLength(1);
    expect(noBlock[0]?.notQueried).toBe(false);
    expect(noBlock[0]?.text).toContain('缺开始标记');
    const bad = checkSecretsBlock(
      memRepo({
        ...secretsFiles('not json'),
        'docs/ops.md': secretsDoc(files),
      }),
      'docs/ops.md',
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]?.notQueried).toBe(true);
    expect(bad[0]?.text).toContain('deploy/france/desired-config.json');
  });

  it('本仓部署配置能生成：只出名字，不含任何长十六进制指纹', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const real = fsRepo(root);
    const names = readSecretEntries(real).map((e) => `${e.file}:${e.key}`);
    expect(names).toContain('api.env:FLEET_PUBLIC_URL');
    expect(renderSecretsBlock(real)).not.toMatch(/[0-9a-f]{32,}/);
  });
});

// 五个区块一起认（#140 第十一片）：命令行 --check / --write 一次核对全五张表，区块可以散在 docs/ops.md 和 docs/ops/*.md 里。
// 假仓里的一套 deploy/ 文件同时够五个区块用：既出端口、用户、目录，也出单元、密钥名。
const ALL_FRANCE = [
  '#!/usr/bin/env bash',
  'PG_PORT=5432',
  'PILOT_USER=pilot',
  'ensure_dir /srv/a root:root 755',
].join('\n');
const ALL_HK = [
  '#!/usr/bin/env bash',
  'WG_PORT=4500',
  'ensure_service_user fleet /home/fleet',
  'ensure_dir /etc/fleet-dao root:fleet 750',
].join('\n');
const ALL_HUMAN = ['ensure_service_user fleet /home/fleet', 'ensure_dir /opt/fleet-dao root:root 755'].join(
  '\n',
);
const ALL_UNITS: Record<string, string> = {
  'deploy/france/fleet-api.service': '[Unit]\nDescription=驾驶舱后端\n',
  'deploy/hk/fleet-feishu.service': '[Unit]\nDescription=fleet-dao 飞书网关\n',
};
const ALL_SECRETS = JSON.stringify({
  formatVersion: 1,
  files: { 'api.env': { FLEET_PUBLIC_URL: { private: FINGERPRINT } } },
});

/** 五个区块齐、不带文档的假仓：生成五张表用它。 */
function allFiles(over: Record<string, string> = {}): Record<string, string> {
  return {
    'deploy/france.sh': ALL_FRANCE,
    'deploy/hk.sh': ALL_HK,
    'deploy/lib/human-tier.sh': ALL_HUMAN,
    'deploy/lib/session-user.sh': 'SESSION_USER=fleet-agent-carpool',
    ...ALL_UNITS,
    'deploy/france/desired-config.json': ALL_SECRETS,
    ...over,
  };
}

const allNoDoc = () => memRepo(allFiles());

/** 五个区块各生成一段，按给定顺序拼成一段文字。 */
function blocksText(names: readonly string[], repo: RepoView = allNoDoc()): string {
  const of: Record<string, string> = {
    ports: renderPortsBlock(repo),
    users: renderUsersBlock(repo),
    dirs: renderDirsBlock(repo),
    units: renderUnitsBlock(repo),
    secrets: renderSecretsBlock(repo),
  };
  return names.map((n) => of[n] ?? '').join('\n\n');
}

/** 分散的仓：ports、users 在 docs/ops.md，dirs、units、secrets 在 docs/ops/x.md。 */
function splitRepo(over: Record<string, string> = {}): RepoView {
  const base = allNoDoc();
  return memRepo(
    allFiles({
      'docs/ops.md': `# 运维\n\n${blocksText(['ports', 'users'], base)}\n`,
      'docs/ops/x.md': `# 拆出来的\n\n${blocksText(['dirs', 'units', 'secrets'], base)}\n`,
      ...over,
    }),
  );
}

describe('五个区块一起认（第十一片）', () => {
  it('区块名字对外是 ports、users、dirs、units、secrets，按这个顺序核对', () => {
    expect(OPS_BLOCK_NAMES).toEqual(['ports', 'users', 'dirs', 'units', 'secrets']);
  });

  it('不给路径时：docs/ops.md 加 docs/ops/*.md 都算候选，按路径排', () => {
    const repo = splitRepo({ 'docs/ops/b.md': 'x\n', 'docs/ops/a.md': 'x\n' });
    expect(opsDocPaths(repo)).toEqual(['docs/ops.md', 'docs/ops/a.md', 'docs/ops/b.md', 'docs/ops/x.md']);
    expect(opsDocPaths(repo, 'docs/one.md')).toEqual(['docs/one.md']);
  });

  it('五个区块散在两个文件里，核对通过、返回空数组', () => {
    expect(checkOpsBlocks(splitRepo())).toEqual([]);
  });

  it('同一个文件里放全五个区块，核对通过', () => {
    const base = allNoDoc();
    const repo = memRepo(allFiles({ 'docs/ops.md': `# 运维\n\n${blocksText(OPS_BLOCK_NAMES, base)}\n` }));
    expect(checkOpsBlocks(repo)).toEqual([]);
  });

  it('给了文档路径就只在这一个文件里找五个区块：别处再有一份也不管', () => {
    const base = allNoDoc();
    const repo = memRepo(
      allFiles({
        'docs/ops.md': `# 运维\n\n${blocksText(OPS_BLOCK_NAMES, base)}\n`,
        // 另一个文件里也有 ports 标记：给了路径就只认 docs/ops.md，这份不算重复。
        'docs/ops/other.md': `# 别的\n\n${renderPortsBlock(base)}\n`,
      }),
    );
    expect(checkOpsBlocks(repo, 'docs/ops.md')).toEqual([]);
  });

  // 故意造出的失败：某个区块在两个文件里各有一份，必须报一条点出区块名和文件的问题。
  it('某区块在两个文件里重复出现，报一条点出区块名的问题，不当成通过', () => {
    const base = allNoDoc();
    const repo = memRepo(
      allFiles({
        'docs/ops.md': `# 运维\n\n${blocksText(['ports', 'users'], base)}\n`,
        'docs/ops/x.md': `# 拆出来的\n\n${blocksText(['dirs', 'units', 'secrets'], base)}\n`,
        // 第二份 ports：docs/ops.md 里已经有一份了。
        'docs/ops/y.md': `# 多出来的\n\n${renderPortsBlock(base)}\n`,
      }),
    );
    const problems = checkOpsBlocks(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('端口表');
    expect(problems[0]?.text).toContain('docs/ops.md');
    expect(problems[0]?.text).toContain('docs/ops/y.md');
  });

  // 故意造出的失败：少一个区块，必须报一条点出是哪个区块。
  it('缺一个区块（dirs 没放进去），报一条点出区块名的问题', () => {
    const base = allNoDoc();
    const repo = memRepo(
      allFiles({
        'docs/ops.md': `# 运维\n\n${blocksText(['ports', 'users'], base)}\n`,
        'docs/ops/x.md': `# 拆出来的\n\n${blocksText(['units', 'secrets'], base)}\n`,
      }),
    );
    const problems = checkOpsBlocks(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('目录表');
    expect(problems[0]?.text).toContain('找不到');
  });

  it('一行内容被手改（端口号），报一条点出变量的问题', () => {
    const base = allNoDoc();
    const repo = splitRepo({
      'docs/ops.md': `# 运维\n\n${blocksText(['ports', 'users'], base).replace('| 5432 |', '| 5433 |')}\n`,
    });
    const problems = checkOpsBlocks(repo);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('PG_PORT');
    expect(problems[0]?.text).toContain('5433');
  });

  it('一个候选文件都读不到，五个区块各报一条「没查成」并点出区块名', () => {
    const problems = checkOpsBlocks(allNoDoc());
    expect(problems).toHaveLength(5);
    expect(problems.every((p) => p.notQueried)).toBe(true);
    for (const label of ['端口表', '用户表', '目录表', '单元表', '密钥名表']) {
      expect(problems.some((p) => p.text.includes(label) && p.text.includes('找不到'))).toBe(true);
    }
  });

  it('生成不出来（deploy 脚本读不到），返回「没查成」，不当成通过', () => {
    const base = allNoDoc();
    const { 'deploy/hk.sh': _hk, ...noHk } = allFiles({
      'docs/ops.md': `# 运维\n\n${blocksText(['ports', 'users'], base)}\n`,
    });
    const problems = checkOpsBlocks(memRepo(noHk));
    expect(problems.length).toBeGreaterThan(0);
    // 端口、用户、目录都要读 hk.sh，读不到就是「没查成」，不当成通过。
    expect(problems.some((p) => p.notQueried && p.text.includes('deploy/hk.sh'))).toBe(true);
  });
});

describe('--write 一次换五个区块（第十一片）', () => {
  it('散在两个文件里：两处都换，内容本来就新则不改', () => {
    const result = writeOpsBlocks(splitRepo());
    expect(result.problems).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  it('手改过一行：只改回到生成的，区块外的字原样', () => {
    const base = allNoDoc();
    const docText = `# 运维\n\n${blocksText(['ports', 'users'], base).replace('| 5432 |', '| 5433 |')}\n`;
    const repo = memRepo(
      allFiles({
        'docs/ops.md': docText,
        'docs/ops/x.md': `# 拆出来的\n\n${blocksText(['dirs', 'units', 'secrets'], base)}\n`,
      }),
    );
    const { changes, problems } = writeOpsBlocks(repo);
    expect(problems).toEqual([]);
    expect(changes.map((c) => c.path)).toEqual(['docs/ops.md']);
    const out = changes[0]?.text ?? '';
    expect(out).toContain('| PG_PORT | 5432 |');
    expect(out).not.toContain('| 5433 |');
    expect(out.startsWith('# 运维\n\n')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
  });

  // 故意造出的失败：标记缺失，必须报出来，一个字都不写。
  it('缺一个区块的标记，problems 非空、changes 是空的（一个字都不写）', () => {
    const base = allNoDoc();
    const repo = memRepo(
      allFiles({
        'docs/ops.md': `# 运维\n\n${blocksText(['ports', 'users'], base)}\n`,
        // units、secrets 都放了，唯独没有 dirs。
        'docs/ops/x.md': `# 拆出来的\n\n${blocksText(['units', 'secrets'], base)}\n`,
      }),
    );
    const { changes, problems } = writeOpsBlocks(repo);
    expect(changes).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('目录表');
  });

  it('一个候选文件都读不到，problems 非空、changes 是空的', () => {
    const { changes, problems } = writeOpsBlocks(allNoDoc());
    expect(changes).toEqual([]);
    expect(problems).toHaveLength(5);
    expect(problems.every((p) => p.notQueried)).toBe(true);
  });
});
