import { describe, expect, it } from 'vitest';
import {
  type ChangelogVersion,
  hasChangelogVersion,
  renderChangelogVersion,
  writeChangelogVersion,
} from '../src/changelog.ts';
import { issue } from './fake-github.ts';

const BASE: ChangelogVersion = {
  version: 4,
  start: '2026-10-12',
  end: '2026-10-18',
  cutHead: 'a'.repeat(40),
  deliveries: { state: 'ok', commits: ['b'.repeat(40)] },
  issues: [],
};
const done = (number: number, title: string, labels: string[]) =>
  issue(number, { state: 'closed', stateReason: 'completed', title, labels });

describe('按完成单生成版本节', () => {
  it('类别和性质归入五类；优先级为安全、移除、缺陷、需求、变更', () => {
    const section = renderChangelogVersion({
      ...BASE,
      issues: [
        done(1, '能导出任务', ['需求']),
        done(2, '任务列表查询更快', ['需求', '性质:perf']),
        done(3, '修好空列表', ['需求', '性质:bug']),
        done(4, '退役旧接口', ['需求']),
        done(5, '验证签名', ['缺陷', '安全']),
        done(6, '修正导航', ['缺陷']),
        done(7, '简化发布流程', ['需求', '性质:process']),
        done(8, '更新说明', ['杂项']),
      ],
    });
    const entries = (name: string) => section.split(`### ${name}\n\n`)[1]?.split('\n\n')[0];
    expect(entries('新增')).toBe('- 能导出任务（#1）');
    expect(entries('变更')).toContain('任务列表查询更快（#2）');
    expect(entries('变更')).toContain('简化发布流程（#7）');
    expect(entries('修复')).toContain('修好空列表（#3）');
    expect(entries('修复')).toContain('修正导航（#6）');
    expect(entries('移除/弃用')).toBe('- 退役旧接口（#4）');
    expect(entries('安全')).toBe('- 验证签名（#5）');
  });
  it('只收completed：开着、不做、重复、未知原因、PR和个人工具运营均不当产品条目', () => {
    const section = renderChangelogVersion({
      ...BASE,
      issues: [
        done(1, '看得见任务进度', ['需求']),
        issue(2, { title: '还没做' }),
        issue(3, { title: '不做条目', state: 'closed', stateReason: 'not_planned' }),
        issue(4, { title: '重复条目', state: 'closed', stateReason: 'duplicate' }),
        issue(5, { title: '原因未知', state: 'closed' }),
        { ...done(6, 'PR标题', ['需求']), isPr: true },
        done(7, '换模型节省额度', ['杂项']),
        done(8, '分配测试订阅', ['AI运营']),
      ],
    });
    expect(section).toContain('看得见任务进度（#1）');
    for (const word of [
      '还没做',
      '不做条目',
      '重复条目',
      '原因未知',
      'PR标题',
      '换模型节省额度',
      '分配测试订阅',
    ])
      expect(section).not.toContain(word);
  });
  it('固定三尾按顺序出现，提交全号；不从完成关单推断现场已验/没有兼容问题', () => {
    const section = renderChangelogVersion(BASE);
    expect(section.match(/^### .+$/gm)).toEqual([
      '### 版本与交付物',
      '### 兼容性与升级',
      '### 验证状态与已知限制',
    ]);
    expect(section).toContain(BASE.cutHead);
    expect(section).toContain('b'.repeat(40));
    expect(section).toContain('未逐项核验');
    expect(section).toContain('不代表法国现场验收通过');
  });
  it('读不到交付物写没查成和原因；真空列表才说期间没有记录', () => {
    expect(
      renderChangelogVersion({ ...BASE, deliveries: { state: 'unavailable', reason: '发布历史权限不足' } }),
    ).toContain('没查成：发布历史权限不足');
    expect(renderChangelogVersion({ ...BASE, deliveries: { state: 'ok', commits: [] } })).toContain(
      '发布历史已读全，这一版期间没有切换发布记录',
    );
    expect(() =>
      renderChangelogVersion({ ...BASE, deliveries: { state: 'unavailable', reason: '' } }),
    ).toThrow('没有原因');
  });
  it('标题转义，不让需求标题注入Markdown结构', () => {
    const section = renderChangelogVersion({
      ...BASE,
      issues: [done(1, '导出 [文件](url)\n### 假标题', ['需求'])],
    });
    expect(section).toContain('导出 \\[文件\\](url) ### 假标题');
    expect(section.match(/^### /gm)).toHaveLength(4);
  });
});

describe('按版本幂等写回', () => {
  const history = '# Changelog\n\n前言保留。\n\n## [v3] - 2026-10-05\n\n历史不动。\n';
  it('插入多版倒序，重跑字节不变，只替换指定版本而保留相邻锚点和历史', () => {
    const first = writeChangelogVersion(history, BASE);
    const second = writeChangelogVersion(first, { ...BASE, version: 5 });
    expect(writeChangelogVersion(second, BASE)).toBe(second);
    const updated = writeChangelogVersion(second, { ...BASE, issues: [done(1, '新增功能', ['需求'])] });
    expect(updated.indexOf('## [v5]')).toBeLessThan(updated.indexOf('## [v4]'));
    expect(updated).toContain('<a id="v5"></a>\n## [v5]');
    expect(updated).toContain('<a id="v4"></a>\n## [v4]');
    expect(updated).toContain('历史不动。');
    expect(updated).toContain('前言保留。');
    expect(updated.match(/## \[v4\]/g)).toHaveLength(1);
    expect(hasChangelogVersion(updated, 4)).toBe(true);
    expect(hasChangelogVersion(updated, 40)).toBe(false);
  });
  it('相邻的非版本二级标题也属于边界，更新版本不能吞掉其他说明', () => {
    const old = '# Changelog\n\n## [v4] - old\nold\n\n## 补充说明\n保留原文。\n';
    const updated = writeChangelogVersion(old, BASE);
    expect(updated).toContain('## 补充说明\n保留原文。\n');
    expect(writeChangelogVersion(updated, BASE)).toBe(updated);
  });
  it('旧版没有显式锚点也能更新；重复版本拒绝而不是覆盖不明内容', () => {
    const old = '# Changelog\n\n## [v4] - old\n\nold\n\n## [v3] - old\nkeep\n';
    const updated = writeChangelogVersion(old, BASE);
    expect(updated).not.toContain('\nold\n');
    expect(updated).toContain('keep');
    expect(() => writeChangelogVersion(`${old}\n## [v4] - duplicate\n`, BASE)).toThrow('重复');
  });
});
