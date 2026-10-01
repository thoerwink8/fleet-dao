import { describe, expect, test } from 'vitest';
import {
  INITIAL_STATE,
  UNRELEASED_HEADING,
  feishuBody,
  namesFor,
  nextState,
  nextVersion,
  planFinalize,
  releaseBody,
  splitChangelog,
  today,
} from '../src/release-notes.ts';

const HEADING_V1 = `## [v1] - 2026-10-09`;
const HEADING_V2 = `## [v2] - 2026-11-10`;

const BASE = `# Changelog

写给人看的更新日志（#227）：格式照 Keep a Changelog 1.1.0。

${UNRELEASED_HEADING}
`;

describe('认格式（Keep a Changelog 1.1.0）', () => {
  test('只认「## [Unreleased]」「## [vN] - YYYY-MM-DD」', () => {
    const text = `${BASE}
- 加了记一版
- 加了 CI 检查
`;
    expect(splitChangelog(text).hasContent).toBe(true);
    expect(splitChangelog(text).section).toBe('- 加了记一版\n- 加了 CI 检查');
    expect(splitChangelog(text).next).toEqual({ version: 'v1', date: today() });
  });

  test('只有 Unreleased 一张时 next 是 v1，没有上一版', () => {
    const text = `${BASE}
- 一条
`;
    expect(splitChangelog(text).next.version).toBe('v1');
    expect(splitChangelog(text).released).toEqual([]);
  });

  test('有上一版时，下一版是它加一', () => {
    const text = `${BASE}
- 一条

${HEADING_V1}

### Added / 新增

- 第一版。

${HEADING_V2}

### Added / 新增

- 第二版。
`;
    const r = splitChangelog(text);
    expect(r.next.version).toBe('v3');
    expect(r.released[0]).toEqual({ version: 'v2', date: '2026-11-10' });
    expect(r.released[1]).toEqual({ version: 'v1', date: '2026-10-09' });
  });

  test('Unreleased 写错了模样（## Unreleased）就拒绝', () => {
    const text = `# Changelog

## Unreleased

- 一条
`;
    expect(() => splitChangelog(text)).toThrow(/缺 ## \[Unreleased\]/);
  });

  test('Unreleased 后面有认不出的二级标题就拒绝', () => {
    const text = `${BASE}
- 一条

## 别有用心的

- 不认。
`;
    expect(() => splitChangelog(text)).toThrow(/版本标题应为/);
  });

  test('Unreleased 只有一行「还没有」算作空', () => {
    const text = `${BASE}
还没有
`;
    expect(splitChangelog(text).hasContent).toBe(false);
  });

  test('Unreleased 只有几个空行也算空', () => {
    const text = `${BASE}

`;
    expect(splitChangelog(text).hasContent).toBe(false);
  });
});

describe('正文和名字', () => {
  test('正文就是 Unreleased 那段的原文', () => {
    expect(releaseBody('- 一条\n- 两条')).toBe('- 一条\n- 两条');
  });

  test('Unreleased 是空的话，正文这条走不成就报错', () => {
    expect(() => releaseBody('  \n  ')).toThrow(/Unreleased 段是空的/);
  });

  test('tag、release、milestone、飞书各自的名字都是 v<N>', () => {
    expect(namesFor('v2')).toEqual({
      tag: 'v2',
      releaseTitle: 'v2',
      milestoneTitle: 'v2',
      feishuTitle: 'v2',
    });
  });

  test('飞书消息正文带上一段，再贴回 CHANGELOG.md 的地址', () => {
    const b = feishuBody('v2', '- 一条', 'https://github.com/thoerwink8/fleet-dao/blob/main/CHANGELOG.md');
    expect(b.startsWith('v2 上线了。')).toBe(true);
    expect(b).toContain('- 一条');
    expect(b).toContain('CHANGELOG.md');
  });
});

describe('nextState：每一小步', () => {
  test('tag 之后 release，再关 milestone，再推飞书', () => {
    let s = INITIAL_STATE;
    s = nextState(s, 'tagged');
    expect(s).toEqual({ schema: 1, kind: 'tagged', tagCreated: true });
    s = nextState(s, 'release-created');
    expect(s.kind).toBe('release-created');
    s = nextState(s, 'milestone-closed');
    expect(s.kind).toBe('milestone-closed');
    s = nextState(s, 'notified');
    expect(s).toEqual({
      schema: 1,
      kind: 'notified',
      tagCreated: true,
      releaseCreated: true,
      milestoneClosed: true,
      feishuSent: true,
    });
  });

  test('在错的顺序下不让走：还没打 tag 就不能建 release、还没建 release 就不能关 milestone', () => {
    expect(() => nextState(INITIAL_STATE, 'release-created')).toThrow();
    expect(() => nextState(INITIAL_STATE, 'milestone-closed')).toThrow();
    expect(() => nextState(INITIAL_STATE, 'notified')).toThrow();
  });
});

describe('幂等（已经做过的不再重做）', () => {
  test('tag 已经有了：tag 跳、其余照走', () => {
    const p = planFinalize({
      state: INITIAL_STATE,
      tagExists: true,
      releaseExists: false,
      releaseBodyMatches: false,
      milestoneOpen: true,
    });
    expect(p).toEqual({ tag: false, release: false, closeMilestone: false, notify: false });
  });

  test('tag 有了，release 也有了但正文对的：只关 milestone、推飞书', () => {
    const p = planFinalize({
      state: {
        schema: 1,
        kind: 'milestone-closed',
        tagCreated: true,
        releaseCreated: true,
        milestoneClosed: true,
      },
      tagExists: true,
      releaseExists: true,
      releaseBodyMatches: true,
      milestoneOpen: true,
    });
    expect(p).toEqual({ tag: false, release: false, closeMilestone: true, notify: false });
  });

  test('在用的 v 已经发完了（notified）：第二轮什么都不动', () => {
    const p = planFinalize({
      state: {
        schema: 1,
        kind: 'notified',
        tagCreated: true,
        releaseCreated: true,
        milestoneClosed: true,
        feishuSent: true,
      },
      tagExists: false,
      releaseExists: false,
      releaseBodyMatches: false,
      milestoneOpen: false,
    });
    expect(p).toEqual({ tag: true, release: false, closeMilestone: false, notify: false });
  });
});
