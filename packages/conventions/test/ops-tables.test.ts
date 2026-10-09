// ops-tables 的测试（#140 第一片端口、第三片用户）：全用内存假仓，不读盘上的 docs/ops.md 和 deploy/。
import { describe, expect, it } from 'vitest';
import {
  BLOCK_NAME_PORTS,
  checkPortsBlock,
  checkUsersBlock,
  extractBlock,
  readUserEntries,
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
