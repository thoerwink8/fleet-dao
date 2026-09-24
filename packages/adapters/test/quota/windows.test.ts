import { describe, expect, it } from 'vitest';
import { classifyLabel, normalizeStatus, windowAppliesTo, windowsForModel } from '../../src/quota/index.ts';

describe('窗口归类：集合不固定，认不出的也收下', () => {
  it('5h / 7d 是账号级窗口', () => {
    expect(classifyLabel('5h')).toEqual({ window: '5h' });
    expect(classifyLabel('7d')).toEqual({ window: '7d' });
  });

  it('7d_<组> 是只扣这一组模型的周窗口', () => {
    expect(classifyLabel('7d_claude', true)).toEqual({ window: '7d_model', scope: 'claude' });
    // 没标 modelScoped 也按「时长_组名」认：宁可当模型组，不能把组窗口当账号级卡住所有路由。
    expect(classifyLabel('7d_fable')).toEqual({ window: '7d_model', scope: 'fable' });
  });

  it('没见过的时长或形状归 other，组名照样认出来', () => {
    expect(classifyLabel('5h_opus')).toEqual({ window: 'other', scope: 'opus' });
    expect(classifyLabel('30d')).toEqual({ window: 'other' });
    expect(classifyLabel('1d_gpt')).toEqual({ window: 'other', scope: 'gpt' });
  });

  it('不是「时长_组名」形状、也没标模型组的，按账号级收', () => {
    expect(classifyLabel('on_demand')).toEqual({ window: 'other' });
  });

  it('标了模型组却没有组名的，整个标签当组名，不当账号级', () => {
    expect(classifyLabel('opus', true)).toEqual({ window: 'other', scope: 'opus' });
    expect(classifyLabel('weekly_opus', true)).toEqual({ window: 'other', scope: 'opus' });
  });
});

describe('上游状态字为准', () => {
  it('三态原样收，原字留着', () => {
    expect(normalizeStatus('allowed')).toEqual({ upstreamStatus: 'allowed', statusRaw: 'allowed' });
    expect(normalizeStatus('warning')).toEqual({ upstreamStatus: 'warning', statusRaw: 'warning' });
    expect(normalizeStatus('limit_reached')).toEqual({
      upstreamStatus: 'limit_reached',
      statusRaw: 'limit_reached',
    });
  });

  it('Claude 的写法归到三态：rejected 是已满，normal 是正常，critical 只是很紧', () => {
    expect(normalizeStatus('rejected').upstreamStatus).toBe('limit_reached');
    expect(normalizeStatus('allowed_warning').upstreamStatus).toBe('warning');
    expect(normalizeStatus('normal').upstreamStatus).toBe('allowed');
    expect(normalizeStatus('critical')).toEqual({ upstreamStatus: 'warning', statusRaw: 'critical' });
  });

  it('认不出的状态字不归类、不猜，只留原字', () => {
    expect(normalizeStatus('throttled')).toEqual({ statusRaw: 'throttled' });
    expect(normalizeStatus(undefined)).toEqual({});
    expect(normalizeStatus('')).toEqual({});
  });
});

describe('模型组窗口只卡对应模型', () => {
  const windows = [
    { label: '5h' },
    { label: '7d' },
    { label: '7d_claude', scope: 'claude' },
    { label: '7d_fable', scope: 'fable' },
  ];

  it('账号级窗口卡所有模型；7d_fable 只卡 id 里含 fable 的', () => {
    const fable = windowsForModel(windows, { id: 'claude-5-fable-medium' }).map((w) => w.label);
    expect(fable).toEqual(['5h', '7d', '7d_claude', '7d_fable']);
    const gpt = windowsForModel(windows, { id: 'gpt-5.6-luna' }).map((w) => w.label);
    expect(gpt).toEqual(['5h', '7d']);
  });

  it('模型 id 去掉了厂商前缀时，按模型族认组', () => {
    const opus = windowsForModel(windows, { id: 'opus-5.5', family: 'claude' }).map((w) => w.label);
    expect(opus).toEqual(['5h', '7d', '7d_claude']);
  });

  it('有成员表的组按成员表，不按名字猜（Cursor 的 auto 与 api 桶）', () => {
    const scopeModels = {
      auto: { in: ['composer-2.5', 'default'] },
      api: { notIn: ['composer-2.5', 'default'] },
    };
    const auto = { scope: 'auto' };
    const api = { scope: 'api' };
    expect(windowAppliesTo(auto, { id: 'composer-2.5' }, scopeModels)).toBe(true);
    expect(windowAppliesTo(api, { id: 'composer-2.5' }, scopeModels)).toBe(false);
    expect(windowAppliesTo(auto, { id: 'kimi-k3' }, scopeModels)).toBe(false);
    expect(windowAppliesTo(api, { id: 'kimi-k3' }, scopeModels)).toBe(true);
  });

  it('组名与 id 的分隔符写法不同也认得出', () => {
    expect(windowAppliesTo({ scope: 'claude_opus' }, { id: 'claude-opus-5-5' })).toBe(true);
    expect(windowAppliesTo({ scope: 'opus' }, { id: 'OPUS_5.5' })).toBe(true);
  });
});
