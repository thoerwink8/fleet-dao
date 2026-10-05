// 单子里问创始人（#259）的边界表：提问合不合格、他晚到的回答怎么算。含故意造出失败的行。
// 记数（tallyAsks）、存档点交给 Lead 照改（lateChanges、changeLine）、PR 正文「按推荐先做了」（assumedLines）：
// Fusion 的东西，#901 审查时只有测试在用，连同它们的测试一起删了。
import type { TaskState } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { checkAsk, lateAnswer } from '../src/ask.ts';

describe('提问合不合格', () => {
  it('这张单范围内的岔路：推荐的排第一个（卡片上的主按钮），前后空白、重复的选项去掉', () => {
    expect(
      checkAsk({ question: ' 验证码几位？ ', options: ['4 位', ' 6 位 ', '4 位'], recommend: '6 位' }),
    ).toEqual({
      ok: true,
      ask: { question: '验证码几位？', options: ['6 位', '4 位'], recommended: '6 位', scope: 'task' },
    });
  });

  it('超出这张单的范围、碰人闸各是一种', () => {
    expect(
      checkAsk({
        question: '要不要顺手改注册页？',
        options: ['改', '不改'],
        recommend: '不改',
        outside: true,
      }),
    ).toMatchObject({
      ok: true,
      ask: { scope: 'outside', recommended: '不改' },
    });
    expect(
      checkAsk({
        question: '短信用哪家？',
        options: ['阿里云', '腾讯云'],
        recommend: '阿里云',
        hold: 'spend',
      }),
    ).toMatchObject({
      ok: true,
      ask: { scope: 'hold', hold: 'spend' },
    });
  });

  it.each([
    ['【失败】没带选项', { question: '验证码几位？' }, /至少两个选项和推荐.*fleet ask/],
    [
      '【失败】只有一个选项',
      { question: '验证码几位？', options: ['6 位'], recommend: '6 位' },
      /至少两个选项/,
    ],
    [
      '【失败】去重之后只剩一个',
      { question: '验证码几位？', options: ['6 位', ' 6 位'], recommend: '6 位' },
      /至少两个选项/,
    ],
    ['【失败】没写推荐', { question: '验证码几位？', options: ['4 位', '6 位'] }, /没写推荐哪个/],
    [
      '【失败】推荐的不在选项里',
      { question: '验证码几位？', options: ['4 位', '6 位'], recommend: '8 位' },
      /不在选项里/,
    ],
    [
      '【失败】选项太多',
      { question: '哪家？', options: ['甲', '乙', '丙', '丁', '戊'], recommend: '甲' },
      /最多 4 个/,
    ],
    [
      '【失败】超出范围和人闸同时写',
      { question: '哪家？', options: ['甲', '乙'], recommend: '甲', outside: true, hold: 'spend' },
      /只能选一个/,
    ],
    [
      '【失败】人闸认不出',
      { question: '哪家？', options: ['甲', '乙'], recommend: '甲', hold: 'buy' },
      /人闸认不出：buy/,
    ],
    ['【失败】问题是空的', { question: '  ', options: ['甲', '乙'], recommend: '甲' }, /问题是空的/],
  ])('%s', (_name, input, why) => {
    const got = checkAsk(input);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toMatch(why);
  });

  it('只有他本人才有的东西（账号、权限）：退回时写明不是提问，改用 fleet blocked --needs access', () => {
    const got = checkAsk({ question: '把短信服务的账号给我' });
    expect(!got.ok && got.why).toContain('fleet blocked "<缺什么>" --needs access');
  });
});

describe('他晚到的回答', () => {
  const at = (answer: string, taskState: TaskState, applied = false) =>
    lateAnswer({ recommended: '6 位', answer, applied, taskState });

  it.each([
    ['选的就是推荐的：只记一笔（单子在做、合了都一样）', at(' 6 位', 'running'), 'confirmed'],
    ['选的就是推荐的、已经合了', at('6 位', 'done'), 'confirmed'],
    ['选了别的、还在做：下一个存档点交给主导改', at('4 位', 'running'), 'change'],
    ['选了别的、在合并队列里还没合：照样下一个存档点改', at('4 位', 'merging'), 'change'],
    ['选了别的、已经交给主导照改了', at('4 位', 'done', true), 'applied'],
    ['选了别的、已经合了：开后续单', at('4 位', 'done'), 'follow-up'],
    ['选了别的、单子被叫停了：只记下，重开时照做', at('4 位', 'stopped'), 'recorded'],
    ['选了别的、单子失败了', at('4 位', 'failed'), 'recorded'],
    ['自己写了一句别的（不是选项）也算选了别的', at('都行，你定', 'running'), 'change'],
  ])('%s', (_name, got, want) => {
    expect(got).toBe(want);
  });
});
