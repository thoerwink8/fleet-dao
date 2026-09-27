import { describe, expect, test } from 'vitest';
import type { Ask } from '../api/types';
import { askEffectText, askStanding, canAnswerAsk } from './ask';

const base: Ask = {
  id: 'a1',
  question: '验证码用哪家短信？',
  options: ['阿里云', '腾讯云'],
  askedAt: '2026-09-25T07:55:00.000Z',
  status: 'pending',
  scope: 'task',
  recommended: '阿里云',
};
const answered = (more: Partial<Ask>): Ask => ({ ...base, status: 'answered', answer: '腾讯云', ...more });

describe('问他不挡路（#259）的说法', () => {
  test('还没回：写明已按推荐先做、改选会怎样；合进去以后改选开后续单；碰人闸、另开单各有说法；老式的没有', () => {
    expect(askStanding(base, 'running')).toBe('已按推荐先做：阿里云。改选别的，下个存档点交给 AI 改。');
    expect(askStanding(base, 'done')).toBe(
      '已按推荐先做：阿里云。这张单已经合进去了，改选别的会另开后续单。',
    );
    expect(askStanding({ ...base, scope: 'hold', hold: 'spend' }, 'running')).toBe(
      '碰了人闸（花钱）：先按推荐做（阿里云），合并前等你批。',
    );
    expect(askStanding({ ...base, scope: 'outside', followUpIssue: 40 }, 'running')).toBe(
      '超出这张单的范围：这张单绕开它接着做，另开一张单等你拍（#40）。',
    );
    expect(askStanding({ ...base, scope: undefined, recommended: undefined }, 'running')).toBeNull();
    expect(askStanding(answered({}), 'running')).toBeNull();
  });

  test('回了：按后端给的 effect 说怎么生效；老式的、没回的没有', () => {
    expect(askEffectText(answered({ effect: 'confirmed', answer: '阿里云' }))).toBe('就是推荐的，已生效');
    expect(askEffectText(answered({ effect: 'change' }))).toBe('下个存档点生效');
    expect(askEffectText(answered({ effect: 'applied' }))).toBe('已生效');
    expect(askEffectText(answered({ effect: 'follow-up' }))).toBe('这张单已经合进去了，会另开后续单');
    expect(askEffectText(answered({ effect: 'follow-up', followUpIssue: 31 }))).toBe(
      '这张单已经合进去了，另开了后续单 #31',
    );
    expect(askEffectText(answered({ effect: 'recorded' }))).toBe('这张单没做成就停了，只记下');
    expect(askEffectText(answered({ scope: 'outside', followUpIssue: 40 }))).toBe('记在 #40 上');
    expect(askEffectText(answered({ scope: undefined, effect: undefined }))).toBeNull();
    expect(askEffectText(base)).toBeNull();
  });

  test('【故意造出的失败】单子结束后：按推荐先做了的合进去以后照样能改，叫停、失败的和老式的不能答', () => {
    expect(canAnswerAsk(base, 'running')).toBe(true);
    expect(canAnswerAsk(base, 'done')).toBe(true);
    expect(canAnswerAsk(base, 'stopped')).toBe(false);
    expect(canAnswerAsk(base, 'failed')).toBe(false);
    expect(canAnswerAsk({ ...base, scope: undefined }, 'done')).toBe(false);
    expect(canAnswerAsk({ ...base, scope: undefined }, 'running')).toBe(true);
    expect(canAnswerAsk(answered({}), 'running')).toBe(false);
  });
});
