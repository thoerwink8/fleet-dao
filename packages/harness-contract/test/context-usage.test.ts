import { describe, expect, it } from 'vitest';
import { contextFromStreamLine, contextLabel, usedTokens } from '../src/context-usage.ts';

describe('上下文用量', () => {
  it('Claude 这一次调用的三样相加，缺一就是未知，子代理不算', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 3,
          output_tokens: 4,
        },
      },
    });
    const reading = contextFromStreamLine('claude', line);
    expect(usedTokens(reading ?? {})).toBe(33);
    expect(contextLabel(reading)).toBe('33 / 未知');
    expect(
      contextFromStreamLine(
        'claude',
        JSON.stringify({
          type: 'assistant',
          parent_tool_use_id: 'toolu_sub',
          message: {
            usage: {
              input_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it('只有输入、没有缓存字段时不相加，显示未知', () => {
    const reading = contextFromStreamLine(
      'claude',
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 300, output_tokens: 20 } } }),
    );
    expect(contextLabel(reading)).toBe('未知');
  });

  it('帧里写了窗口就原样带上', () => {
    const reading = contextFromStreamLine(
      'claude',
      JSON.stringify({
        type: 'result',
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 0,
        },
        context_window: 200000,
      }),
    );
    expect(contextLabel(reading)).toBe('3 / 200000');
  });

  it('Grok 只认 usage 帧，不认 end 的累计', () => {
    const one = contextFromStreamLine(
      'grok',
      JSON.stringify({
        type: 'usage',
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 0,
          output_tokens: 8,
          reasoning_tokens: 4,
        },
      }),
    );
    expect(contextLabel(one)).toBe('150 / 未知');
    expect(
      contextFromStreamLine(
        'grok',
        JSON.stringify({
          type: 'end',
          usage: {
            input_tokens: 999,
            cache_read_input_tokens: 999,
            cache_creation_input_tokens: 0,
            total_tokens: 9999,
          },
          num_turns: 4,
        }),
      ),
    ).toBeNull();
  });

  it('codex、pi 和坏行没有准数', () => {
    const line = JSON.stringify({
      type: 'usage',
      usage: { input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
    });
    expect(contextFromStreamLine('codex', line)).toBeNull();
    expect(contextFromStreamLine('pi', line)).toBeNull();
    expect(contextFromStreamLine('claude', '不是 json')).toBeNull();
    expect(contextLabel(null)).toBe('未知');
  });
});
