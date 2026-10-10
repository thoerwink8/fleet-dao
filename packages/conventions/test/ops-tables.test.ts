// ops-tables 的测试（#140 第一片端口、第三片用户、第五片目录）：除一条读本仓 deploy/ 的用例外，全用内存假仓。

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_NAME_DIRS,
  BLOCK_NAME_PORTS,
  checkDirsBlock,
  checkPortsBlock,
  checkUsersBlock,
  extractBlock,
  readDirEntries,
  readUserEntries,
  renderDirsBlock,
  renderPortsBlock,
  renderUsersBlock,
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
    const r = memRepo({ 'deploy/france.sh': 'echo hi\n', 'deploy/hk.sh': HK, 'docs/ops.md': 'x' });
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
    const r = memRepo(usersFiles({ 'deploy/lib/human-tier.sh': 'ensure_service_user "$u" "/home/$u"\n' }));
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
    const r = memRepo(dirsFiles({ 'deploy/hk.sh': 'echo hi\nensure_dir "$NOPE" root:root 755\n' }));
    expect(() => readDirEntries(r)).toThrow('deploy/hk.sh:2');
    expect(() => readDirEntries(r)).toThrow('NOPE');
  });

  it('赋值值里有 $( 命令替换，抛带赋值所在脚本和行号的错', () => {
    const r = memRepo(
      dirsFiles({ 'deploy/hk.sh': 'CMD_DIR=$(mktemp -d)\nensure_dir "$CMD_DIR" root:root 755\n' }),
    );
    expect(() => readDirEntries(r)).toThrow('deploy/hk.sh:1');
  });

  it('变量互相引用绕成圈，抛错', () => {
    const r = memRepo(dirsFiles({ 'deploy/hk.sh': 'A=$B\nB=$A\nensure_dir "$A" root:root 755\n' }));
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
      dirsFiles({ 'deploy/hk.sh': 'for u in a b; do\n  ensure_dir /shared "$u:$u" 750\ndone\n' }),
    );
    expect(() => readDirEntries(noAssign)).toThrow('deploy/hk.sh:2');
    const withAssign = memRepo(
      dirsFiles({ 'deploy/hk.sh': 'u=root\nfor u in a b; do\n  ensure_dir /shared "$u:$u" 750\ndone\n' }),
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
