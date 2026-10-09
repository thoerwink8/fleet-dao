// 冲突交回的两件纯逻辑（#1303）：占位不能把文件名冲掉；这张单的 PR 正文要写上根因。
import { renderPrBody } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import { conflictFilesInMergeMessage } from '../src/real/user-git.ts';
import {
  ALERT_FILING_PR_NOTES,
  CONFLICT_HANDOFF_CAUSE,
  conflictFilesForHandoff,
  taskPrDid,
} from '../src/workflows/task-support.ts';

const FILE = 'packages/engine/src/real/index.ts';

describe('冲突文件名', () => {
  it('这一轮只剩占位：沿用上一轮反馈里的文件名', () => {
    const previous = [`有冲突没解：${FILE}。树里留着冲突标记，解完 \`git add\` 并提交`];
    expect(conflictFilesForHandoff(['（MERGE_HEAD 还在）'], previous)).toEqual([FILE]);
  });

  it('上一轮也没文件名：占位留着，不当成没有冲突', () => {
    expect(conflictFilesForHandoff(['（MERGE_HEAD 还在）'], [])).toEqual(['（MERGE_HEAD 还在）']);
  });

  it('合并说明里的 Conflicts 行是文件名，后面的说明文字不算', () => {
    const message = [
      "Merge branch 'main' into side",
      '',
      '# Conflicts:',
      `#\t${FILE}`,
      '#\tb.ts',
      '#',
      '# It looks like you may be committing a merge.',
    ].join('\n');
    expect(conflictFilesInMergeMessage(message)).toEqual([FILE, 'b.ts']);
  });
});

describe('PR 正文里的根因', () => {
  it('#1303 的正文写上合并被撤掉、反馈没进会话；别的单子仍是原来两句', () => {
    const body = renderPrBody({
      requirement: 1303,
      did: taskPrDid(1303, 2, 4),
      verified: ['相关测试'],
    });
    expect(body).toContain('**做了什么**：');
    expect(body).toContain(CONFLICT_HANDOFF_CAUSE);
    expect(body).toContain('merge --abort');
    expect(body).toContain('没有 MERGE_HEAD');
    expect(body).toContain('没进会话提示词');
    expect(body).toContain('不是解完了没提交');
    expect(taskPrDid(12, 2, 1)).toEqual(['按 #12 的要求动手（第 2 轮）', '改了 1 个文件']);
  });

  it('#1406 的正文逐条写上 #389、#431、#1230 的处置，别的单子不带', () => {
    const body = renderPrBody({
      requirement: 1406,
      did: taskPrDid(1406, 2, 4),
      verified: ['相关测试'],
    });
    expect(body).not.toContain('另有');
    for (const line of ALERT_FILING_PR_NOTES) expect(body).toContain(line);
    expect(body).toContain('条件早已不成立');
    expect(body).toContain('仍成立的立案');
    expect(taskPrDid(12, 1, 1)).toEqual(['按 #12 的要求动手（第 1 轮）', '改了 1 个文件']);
  });
});
