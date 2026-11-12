import { describe, expect, it } from 'vitest';
import { agentChoices, defaultModelFor } from './ade';

describe('agent 下拉', () => {
  it('没登录的标出来并且不能选，grok 默认 grok-4.7', () => {
    const choices = agentChoices([
      { id: 'claude', resume: true, models: ['sonnet'], ready: true },
      { id: 'grok', resume: true, models: ['grok-4.5', 'grok-4.7'], ready: true },
      { id: 'codex', resume: false, models: [], ready: false, note: '未登录' },
      { id: 'pi', resume: false, models: [], ready: false, note: '未登录' },
    ]);
    expect(choices).toEqual([
      { id: 'claude', label: 'claude', disabled: false },
      { id: 'grok', label: 'grok', disabled: false },
      { id: 'codex', label: 'codex · 未登录', disabled: true },
      { id: 'pi', label: 'pi · 未登录', disabled: true },
    ]);
    expect(defaultModelFor({ id: 'grok', models: ['grok-4.5', 'grok-4.7'] })).toBe('grok-4.7');
    expect(defaultModelFor({ id: 'claude', models: ['sonnet'] })).toBe('sonnet');
  });
});
