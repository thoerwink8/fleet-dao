// 降智检测题库（#1637）：每道题的标准答案和代码现算的一致；解析、规整、轮换。
import { describe, expect, it } from 'vitest';
import {
  evalArithmetic,
  IQ_QUESTIONS,
  iqAnswerMatches,
  normalizeAnswer,
  parseProbeReply,
  pickIqQuestion,
  probePrompt,
} from '../../src/real/probe-iq.ts';

describe('题库', () => {
  it('至少 30 道，id 不重复，题面不重复', () => {
    expect(IQ_QUESTIONS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(IQ_QUESTIONS.map((q) => q.id)).size).toBe(IQ_QUESTIONS.length);
    expect(new Set(IQ_QUESTIONS.map((q) => q.text)).size).toBe(IQ_QUESTIONS.length);
  });

  it('算术题的标准答案和题面里的算式现算的一致', () => {
    const arith = IQ_QUESTIONS.filter((q) => q.id.startsWith('arith-'));
    expect(arith.length).toBeGreaterThanOrEqual(15);
    for (const q of arith) {
      const expr = /算一下 (.+?) 等于多少/.exec(q.text)?.[1];
      expect(expr, q.id).toBeTruthy();
      expect(String(evalArithmetic(expr as string)), q.id).toBe(q.answer);
    }
  });

  it('日期题的标准答案用 Date 独立现算一遍', () => {
    const dates = IQ_QUESTIONS.filter((q) => q.kind === 'date');
    expect(dates.length).toBeGreaterThanOrEqual(5);
    for (const q of dates) {
      const m = /(\d{4})年(\d+)月(\d+)日往后数 (\d+) 天/.exec(q.text);
      expect(m, q.id).toBeTruthy();
      const [, y, mo, d, n] = (m as RegExpExecArray).map(Number) as number[];
      const t = new Date(Date.UTC(y as number, (mo as number) - 1, (d as number) + (n as number)));
      expect(q.answer, q.id).toBe(`${t.getUTCMonth() + 1}月${t.getUTCDate()}日`);
    }
  });

  it('逻辑题的标准答案（人工核过）', () => {
    const answers = Object.fromEntries(IQ_QUESTIONS.map((q) => [q.id, q.answer]));
    expect(answers).toMatchObject({
      'logic-1': '甲',
      'logic-2': '丙',
      'logic-3': '3',
      'logic-4': '红',
      'logic-5': '15',
      'logic-6': '周六',
      'logic-7': '7',
      'logic-8': '20',
      'logic-9': '96',
      'logic-10': '6',
    });
  });

  it('每道题的标准答案自己判得过；题面里没有数字母、倒着拼这类看分词的题', () => {
    for (const q of IQ_QUESTIONS) {
      expect(iqAnswerMatches(q, q.answer), q.id).toBe(true);
      expect(q.text, q.id).not.toMatch(/几个字母|倒着|反过来拼|多少个字/);
    }
  });

  it('算式求值：优先级、括号、除不尽抛错', () => {
    expect(evalArithmetic('2 + 3 × 4')).toBe(14);
    expect(evalArithmetic('(2 + 3) × 4')).toBe(20);
    expect(evalArithmetic('100 ÷ 5 ÷ 2')).toBe(10);
    expect(() => evalArithmetic('7 ÷ 2')).toThrow('除不尽');
  });
});

describe('轮换', () => {
  it('按分钟数轮着挑，连着的两个时刻不同题；整个周期每道都轮得到', () => {
    const at = (min: number) => new Date(min * 60_000);
    expect(pickIqQuestion(at(0)).id).not.toBe(pickIqQuestion(at(1)).id);
    const seen = new Set<string>();
    for (let i = 0; i < IQ_QUESTIONS.length; i++) seen.add(pickIqQuestion(at(i * 15)).id);
    expect(seen.size).toBeGreaterThan(IQ_QUESTIONS.length / 2);
    const bank = IQ_QUESTIONS.slice(0, 3);
    expect(pickIqQuestion(at(4), bank)).toBe(bank[1]);
  });
});

describe('提示词', () => {
  it('保留不调工具、不解释，要三行，带题', () => {
    const q = IQ_QUESTIONS[0];
    const p = probePrompt(q as NonNullable<typeof q>);
    expect(p).toContain('不要调用任何工具');
    expect(p).toContain('不要解释');
    expect(p).toContain('第一行只写 OK');
    expect(p).toContain('「答案：」');
    expect(p).toContain('「模型：」');
    expect(p).toContain(q?.text);
  });
});

describe('解析', () => {
  it('三行：OK、答案、自报身份', () => {
    expect(parseProbeReply('OK\n答案：935\n模型：Anthropic Claude Opus 5.5')).toEqual({
      ok: true,
      answer: '935',
      identity: 'Anthropic Claude Opus 5.5',
    });
  });

  it('粗体、反引号、代码块围栏、半角冒号、前面的空行都去掉', () => {
    expect(parseProbeReply('\n```text\n**OK**\n**答案:** `935`\n模型: GPT\n```')).toEqual({
      ok: true,
      answer: '935',
      identity: 'GPT',
    });
  });

  it('第一个非空行不是 OK 就没答上，哪怕后面有 OK', () => {
    expect(parseProbeReply('好的\nOK\n答案：1').ok).toBe(false);
    expect(parseProbeReply('OK.\n答案：1').ok).toBe(false);
    expect(parseProbeReply('').ok).toBe(false);
  });

  it('没写的行是 null，不当空串', () => {
    expect(parseProbeReply('OK')).toEqual({ ok: true, answer: null, identity: null });
  });
});

describe('规整', () => {
  it('「答案：1,191。」和「1191」算同一个答案', () => {
    const q = { id: 'x', text: '', short: '', answer: '1191', kind: 'number' as const };
    expect(iqAnswerMatches(q, '1,191。')).toBe(true);
    expect(iqAnswerMatches(q, ' １１９１ ')).toBe(true);
    expect(iqAnswerMatches(q, '1191.')).toBe(true);
    expect(iqAnswerMatches(q, '1190')).toBe(false);
    expect(iqAnswerMatches(q, '')).toBe(false);
    expect(iqAnswerMatches(q, null)).toBe(false);
  });

  it('日期认 4-15、4月15日、04-15、2026年4月15日', () => {
    const q = { id: 'd', text: '', short: '', answer: '4月15日', kind: 'date' as const };
    for (const a of ['4-15', '4月15日', '04-15', '2026年4月15日', '4月15号', '4/15']) {
      expect(iqAnswerMatches(q, a), a).toBe(true);
    }
    expect(iqAnswerMatches(q, '4月16日')).toBe(false);
  });

  it('文字答案不分大小写，星期和周等同；千分位逗号只在数字之间去', () => {
    const q = { id: 't', text: '', short: '', answer: '周六', kind: 'text' as const };
    expect(iqAnswerMatches(q, '星期六。')).toBe(true);
    expect(normalizeAnswer('ABC')).toBe('abc');
    expect(normalizeAnswer('1,234,567')).toBe('1234567');
    expect(normalizeAnswer('a, b')).toBe('a,b');
  });
});
