// ops-tables 的测试（#140 第一片端口、第三片用户、第五片目录）：全用内存假仓，不读盘上的 docs/ops.md 和 deploy/。
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
import type { RepoView } from '../src/repo.ts';
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

// 目录表（#140 第五片）：假仓里三个脚本各一份 ensure_dir。
function dirsFiles(over: Record<string, string> = {}): Record<string, string> {
  return {
    'deploy/france.sh': [
      'RELEASES_DIR=/srv/fleet-dao-releases',
      'ensure_dir /etc/wireguard root:root 700',
      '',
    ].join('\n'),
    'deploy/hk.sh': ['ensure_dir /etc/fleet-dao root:fleet 750', ''].join('\n'),
    'deploy/lib/human-tier.sh': ['  ensure_dir "$RELEASES_DIR" root:root 755', ''].join('\n'),
    ...over,
  };
}

function dirsDocRepo(files: Record<string, string>, tweak?: (block: string) => string): RepoView {
  const block = renderDirsBlock(memRepo(files));
  const doc = ['# 运维', '', '做法写在 deploy/。', tweak ? tweak(block) : block, ''].join('\n');
  return memRepo({ ...files, 'docs/ops.md': doc });
}

describe('renderDirsBlock', () => {
  it('ensure_dir /etc/fleet-dao root:fleet 750 生成一行带来源脚本的表格行', () => {
    const r = memRepo(dirsFiles());
    expect(renderDirsBlock(r)).toContain('| /etc/fleet-dao | root:fleet | 750 | deploy/hk.sh |');
  });

  it('整块长相固定：表头固定，行按路径、再按来源脚本排，两次调用逐字相同', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/hk.sh': [
          'ensure_dir /etc/wireguard root:root 700',
          'ensure_dir /etc/fleet-dao root:fleet 750',
        ].join('\n'),
      }),
    );
    expect(renderDirsBlock(r)).toBe(
      [
        '<!-- fleet:dirs:start -->',
        '',
        '| 路径 | 属主:组 | 权限 | 来源脚本 |',
        '|---|---|---|---|',
        '| /etc/fleet-dao | root:fleet | 750 | deploy/hk.sh |',
        '| /etc/wireguard | root:root | 700 | deploy/france.sh |',
        '| /etc/wireguard | root:root | 700 | deploy/hk.sh |',
        '| /srv/fleet-dao-releases | root:root | 755 | deploy/lib/human-tier.sh |',
        '',
        '<!-- fleet:dirs:end -->',
      ].join('\n'),
    );
    expect(renderDirsBlock(r)).toBe(renderDirsBlock(r));
  });
});

describe('readDirEntries', () => {
  it('"$RELEASES_DIR" 在有 RELEASES_DIR=/srv/fleet-dao-releases 赋值时展开成字面路径', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/lib/human-tier.sh':
          'RELEASES_DIR=/srv/fleet-dao-releases\nensure_dir "$RELEASES_DIR" root:root 755\n',
        'deploy/france.sh': 'ensure_dir /etc/wireguard root:root 700\n',
      }),
    );
    const hit = readDirEntries(r).find((e) => e.script === 'deploy/lib/human-tier.sh');
    expect(hit).toMatchObject({ path: '/srv/fleet-dao-releases', owner: 'root:root', mode: '755' });
  });

  it('裸 $NAME 也展开；赋值在 deploy/lib/ 下别的脚本里也认；赋值右边带变量递归展开', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/france.sh':
          'ensure_dir $TRAIN_DIR root:root 755\nensure_dir "$TRAIN_DIR/bin" root:root 755\n',
        'deploy/lib/paths.sh': 'RELEASES_DIR=/srv/rel\nTRAIN_DIR=$RELEASES_DIR/.train\n',
        'deploy/lib/human-tier.sh': 'ensure_dir /opt/x root:root 755\n',
      }),
    );
    const paths = readDirEntries(r)
      .filter((e) => e.script === 'deploy/france.sh')
      .map((e) => e.path);
    expect(paths).toEqual(['/srv/rel/.train', '/srv/rel/.train/bin']);
  });

  it('库脚本里的变量赋值写在 france.sh 里时也认', () => {
    const r = memRepo(dirsFiles());
    expect(readDirEntries(r).map((e) => e.path)).toContain('/srv/fleet-dao-releases');
  });

  it('路径带按用户变化的变量（/home/$u、"$home"）的行不进表', () => {
    const r = memRepo(
      dirsFiles({
        'deploy/lib/human-tier.sh': [
          'ensure_dir /opt/fleet-dao root:root 755',
          '  ensure_dir "/home/$u" "$u:$u" 750',
          '  ensure_dir "$home" "$user:$user" 750',
          '',
        ].join('\n'),
      }),
    );
    const paths = readDirEntries(r).map((e) => e.path);
    expect(paths.some((p) => p.includes('home'))).toBe(false);
    expect(paths).toContain('/opt/fleet-dao');
  });

  it('注释里的 ensure_dir 不读', () => {
    const r = memRepo(
      dirsFiles({ 'deploy/hk.sh': '# ensure_dir /ghost root:root 755\nensure_dir /real root:root 755\n' }),
    );
    const paths = readDirEntries(r).map((e) => e.path);
    expect(paths).toContain('/real');
    expect(paths).not.toContain('/ghost');
  });

  // 故意造出失败：变量没有任何赋值，必须抛带脚本名和行号的错，不静默跳过这一行。
  it('变量展开不了，抛带脚本名和行号的错', () => {
    const r = memRepo(
      dirsFiles({ 'deploy/hk.sh': 'ensure_dir /a root:root 755\nensure_dir "$NO_SUCH_DIR" root:root 755\n' }),
    );
    expect(() => readDirEntries(r)).toThrow('deploy/hk.sh:2');
    expect(() => readDirEntries(r)).toThrow('$NO_SUCH_DIR');
  });

  it('赋值是命令替换、不是字面路径时，也算展开不了', () => {
    const r = memRepo(dirsFiles({ 'deploy/hk.sh': 'D=$(mktemp -d)\nensure_dir "$D" root:root 755\n' }));
    expect(() => readDirEntries(r)).toThrow('deploy/hk.sh:2');
  });

  it('读不到脚本、脚本里一个 ensure_dir 都没有、参数不足三个，都抛错', () => {
    const { 'deploy/hk.sh': _hk, ...noHk } = dirsFiles();
    expect(() => readDirEntries(memRepo(noHk))).toThrow('读不到 deploy/hk.sh');
    expect(() => readDirEntries(memRepo(dirsFiles({ 'deploy/hk.sh': 'echo hi\n' })))).toThrow(
      'deploy/hk.sh 里一个 ensure_dir 都没读到',
    );
    expect(() => readDirEntries(memRepo(dirsFiles({ 'deploy/hk.sh': 'ensure_dir /a root:root\n' })))).toThrow(
      'deploy/hk.sh:1',
    );
  });
});

describe('checkDirsBlock', () => {
  it('BLOCK_NAME_DIRS 是 dirs', () => {
    expect(BLOCK_NAME_DIRS).toBe('dirs');
  });

  it('文档区块和脚本一致，返回空数组', () => {
    expect(checkDirsBlock(dirsDocRepo(dirsFiles()), 'docs/ops.md')).toEqual([]);
  });

  it('文档里没有区块，报一条点出区块的问题（不是没查成）', () => {
    const r = memRepo({ ...dirsFiles(), 'docs/ops.md': '# 运维\n没有区块\n' });
    const problems = checkDirsBlock(r, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(false);
    expect(problems[0]?.text).toContain('目录区块对不上');
    expect(problems[0]?.text).toContain('fleet:dirs:start');
  });

  it('文档区块里多一行，报一条点出路径的问题', () => {
    const r = dirsDocRepo(dirsFiles(), (b) =>
      b.replace(
        '\n\n<!-- fleet:dirs:end -->',
        '\n| /tmp/extra | root:root | 755 | deploy/hk.sh |\n\n<!-- fleet:dirs:end -->',
      ),
    );
    expect(checkDirsBlock(r, 'docs/ops.md')).toEqual([
      {
        notQueried: false,
        text: '目录 /tmp/extra 多了：文档区块里有 root:root 755（deploy/hk.sh），脚本里没有。',
      },
    ]);
  });

  it('文档区块里少一行，报一条点出路径的问题', () => {
    const r = dirsDocRepo(dirsFiles(), (b) =>
      b.replace('| /etc/fleet-dao | root:fleet | 750 | deploy/hk.sh |\n', ''),
    );
    expect(checkDirsBlock(r, 'docs/ops.md')).toEqual([
      {
        notQueried: false,
        text: '目录 /etc/fleet-dao 少了：脚本里是 root:fleet 750（deploy/hk.sh），文档区块里没有。',
      },
    ]);
  });

  it('文档区块里属主写错，报一条点出路径的问题', () => {
    const r = dirsDocRepo(dirsFiles(), (b) => b.replace('| root:fleet |', '| root:root |'));
    expect(checkDirsBlock(r, 'docs/ops.md')).toEqual([
      {
        notQueried: false,
        text: '目录 /etc/fleet-dao 变了（deploy/hk.sh）：属主:组文档区块里是 root:root，脚本里是 root:fleet。',
      },
    ]);
  });

  it('权限写错也报一条点出路径的问题', () => {
    const r = dirsDocRepo(dirsFiles(), (b) => b.replace('| root:fleet | 750 |', '| root:fleet | 755 |'));
    const problems = checkDirsBlock(r, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.text).toContain('/etc/fleet-dao');
    expect(problems[0]?.text).toContain('权限');
  });

  it('只是行换了序，报不是逐字一致，不报某个目录变了', () => {
    const r = dirsDocRepo(dirsFiles(), (b) => {
      const lines = b.split('\n');
      const a = lines.indexOf('| /etc/fleet-dao | root:fleet | 750 | deploy/hk.sh |');
      const w = lines.indexOf('| /etc/wireguard | root:root | 700 | deploy/france.sh |');
      [lines[a], lines[w]] = [lines[w] ?? '', lines[a] ?? ''];
      return lines.join('\n');
    });
    const problems = checkDirsBlock(r, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.text).toContain('不是逐字一致');
  });

  it('读不到文档、变量展开不了，返回「没查成」，不当成通过', () => {
    const files = dirsFiles();
    expect(checkDirsBlock(memRepo(files), 'docs/ops.md')).toEqual([
      { notQueried: true, text: '没查成：读不到 docs/ops.md' },
    ]);
    const bad = memRepo({
      ...files,
      'deploy/hk.sh': 'ensure_dir "$NOPE" root:root 755\n',
      'docs/ops.md': '# x\n',
    });
    const problems = checkDirsBlock(bad, 'docs/ops.md');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.notQueried).toBe(true);
    expect(problems[0]?.text).toContain('deploy/hk.sh:1');
  });
});
