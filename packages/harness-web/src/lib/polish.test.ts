import { describe, expect, it } from 'vitest';
import { DONE_COLLAPSED_KEY, readDoneCollapsed, writeDoneCollapsed } from './collapse';
import { summaryOf } from './describe';
import {
  OUTCOME_LABEL,
  outcomeLabel,
  resultStatusLabel,
  sessionModeLabel,
  TYPE_LABEL,
  taskStatusLabel,
  typeLabel,
  verdictLabel,
} from './labels';

describe('枚举中文映射（只有 labels.ts 一处）', () => {
  it('认识的显示中文，原值留在 raw（放 title）', () => {
    expect(typeLabel('worker.settled')).toEqual({ text: '工人结束', raw: 'worker.settled' });
    expect(taskStatusLabel('running')).toEqual({ text: '在跑', raw: 'running' });
    expect(taskStatusLabel('claimed')).toEqual({ text: '已领取', raw: 'claimed' });
    expect(resultStatusLabel('blocked')).toEqual({ text: '被卡住', raw: 'blocked' });
    expect(outcomeLabel('retry')?.text).toBe('退回重试');
    expect(verdictLabel('passed')?.text).toBe('通过');
    expect(sessionModeLabel('resume')?.text).toBe('接着上次');
  });

  it('不认识的照原值显示，不丢也不编；空值给 undefined', () => {
    expect(typeLabel('brand.new.type')).toEqual({ text: 'brand.new.type', raw: 'brand.new.type' });
    expect(outcomeLabel('some-future-outcome')?.text).toBe('some-future-outcome');
    expect(verdictLabel(undefined)).toBeUndefined();
    expect(verdictLabel('')).toBeUndefined();
  });

  it('原型链上的名字（toString 之类）不会被当成映射命中', () => {
    expect(typeLabel('toString').text).toBe('toString');
    expect(outcomeLabel('constructor')?.text).toBe('constructor');
  });

  it('契约里的事件类型都有中文名', () => {
    for (const t of ['session.turn.started', 'worker.spawned', 'worker.cleaned', 'handback.recorded']) {
      expect(TYPE_LABEL[t], t).toBeTruthy();
    }
    expect(OUTCOME_LABEL.completed).toBeTruthy();
  });

  it('列表一句话摘要里的交回结局和核验结论也是中文', () => {
    expect(summaryOf('handback.recorded', { outcome: 'retry', verdict: 'unknown' })).toBe(
      '退回重试 / 不确定',
    );
    expect(summaryOf('handback.recorded', { reasons: ['没改动'], outcome: 'retry' })).toBe('没改动');
  });
});

class FakeStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

describe('做完组折叠状态', () => {
  it('没存过 = 折叠（默认）', () => {
    expect(readDoneCollapsed(new FakeStorage())).toBe(true);
  });

  it('展开后记住，再折叠也记住', () => {
    const s = new FakeStorage();
    writeDoneCollapsed(false, s);
    expect(s.data.get(DONE_COLLAPSED_KEY)).toBe('0');
    expect(readDoneCollapsed(s)).toBe(false);
    writeDoneCollapsed(true, s);
    expect(readDoneCollapsed(s)).toBe(true);
  });

  it('localStorage 读写抛错也不影响页面：读当折叠，写静默', () => {
    const boom = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readDoneCollapsed(boom)).toBe(true);
    expect(() => writeDoneCollapsed(false, boom)).not.toThrow();
  });

  it('拿不到 localStorage（undefined）也行', () => {
    expect(readDoneCollapsed(undefined)).toBe(true);
    expect(() => writeDoneCollapsed(false, undefined)).not.toThrow();
  });
});
