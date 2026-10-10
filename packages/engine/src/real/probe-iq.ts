// 路由探针的降智检测（#1637）：每次真探带一道答案唯一、短、现役模型都稳过的题，答案由代码判。
// 偷换成玩具模型、或被限了思考的中转站答不对，探针就判疑似降智。
// 只出多步四则运算、简单逻辑、日期推算：不出数字母、倒着拼这种看分词的题，也不出要联网、要最新知识的题。
// 算术题的题面和标准答案同源（同一个算式字符串用下面的小求值器算出来），日期题用 Date 现算。

export type IqKind = 'number' | 'text' | 'date';

export interface IqQuestion {
  id: string;
  /** 问模型的那句（含答题格式提示）。 */
  text: string;
  /** 一眼看懂的短写：「(37+58)×12-205」「2026-02-20+45天」。 */
  short: string;
  /** 标准答案，原样（日期是「4月15日」）。判的时候两边都先规整。 */
  answer: string;
  kind: IqKind;
}

// ---- 算式求值：只认整数、+ - × ÷ 和括号。除不尽是出题的错，直接抛。 ----

type Token = number | '+' | '-' | '×' | '÷' | '(' | ')';

function tokenize(expr: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(\d+|[+\-×÷()])/gy;
  let pos = 0;
  while (pos < expr.length) {
    re.lastIndex = pos;
    const m = re.exec(expr);
    if (!m) throw new Error(`算式认不出：${expr}`);
    const tok = m[1] as string;
    out.push(/^\d+$/.test(tok) ? Number(tok) : (tok as Token));
    pos = re.lastIndex;
  }
  return out;
}

/** 算一个只含整数、+ - × ÷ 和括号的算式。除不尽抛错。 */
export function evalArithmetic(expr: string): number {
  const tokens = tokenize(expr);
  let i = 0;
  const factor = (): number => {
    const t = tokens[i++];
    if (typeof t === 'number') return t;
    if (t === '(') {
      const v = sum();
      if (tokens[i++] !== ')') throw new Error(`括号没配对：${expr}`);
      return v;
    }
    throw new Error(`算式认不出：${expr}`);
  };
  const product = (): number => {
    let v = factor();
    while (tokens[i] === '×' || tokens[i] === '÷') {
      const op = tokens[i++];
      const r = factor();
      if (op === '×') v *= r;
      else {
        if (r === 0 || v % r !== 0) throw new Error(`除不尽：${expr}`);
        v /= r;
      }
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = tokens[i++];
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const result = sum();
  if (i !== tokens.length) throw new Error(`算式没算完：${expr}`);
  return result;
}

const ARITHMETIC = [
  '(37 + 58) × 12 - 205',
  '(1200 - 345) ÷ 15 + 77',
  '48 × 25 + 360 ÷ 12',
  '(19 + 23) × (31 - 17)',
  '1000 - 7 × 86 + 45',
  '(256 + 144) ÷ 20 × 13',
  '99 × 11 - 450 ÷ 9',
  '(15 × 16 - 40) ÷ 8 + 123',
  '2024 - 17 × 39',
  '(84 ÷ 7 + 9) × 15 - 100',
  '365 × 4 - 1200 ÷ 25',
  '(72 + 48) × 3 ÷ 9',
  '13 × 17 + 19 × 23',
  '(500 - 275) × 4 + 36 ÷ 3',
  '800 ÷ 16 × 7 - 150',
  '(45 + 55) × (20 - 8) ÷ 6',
  '1234 + 4321 - 2222',
  '(9 × 9 + 19) × 12',
  '36 × 27 - 18 × 14',
] as const;

function arithmeticQuestion(expr: string, n: number): IqQuestion {
  const value = evalArithmetic(expr);
  return {
    id: `arith-${n + 1}`,
    text: `算一下 ${expr} 等于多少？答案只写最终的数字。`,
    short: expr.replace(/\s+/g, ''),
    answer: String(value),
    kind: 'number',
  };
}

// ---- 日期推算 ----

function addDays(y: number, m: number, d: number, days: number): { month: number; day: number } {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

const DATES: ReadonlyArray<readonly [number, number, number, number]> = [
  [2026, 2, 20, 45],
  [2026, 3, 8, 30],
  [2026, 11, 25, 20],
  [2028, 2, 20, 15],
  [2026, 12, 20, 100],
  [2027, 1, 31, 28],
  [2026, 7, 15, 60],
  [2026, 5, 3, 90],
];

function dateQuestion([y, m, d, n]: readonly [number, number, number, number], idx: number): IqQuestion {
  const r = addDays(y, m, d, n);
  return {
    id: `date-${idx + 1}`,
    text: `${y}年${m}月${d}日往后数 ${n} 天是几月几日？答案只写月和日，例如 3月5日。`,
    short: `${y}-${m}-${d}+${n}天`,
    answer: `${r.month}月${r.day}日`,
    kind: 'date',
  };
}

// ---- 简单逻辑 ----

const LOGIC: ReadonlyArray<readonly [string, string, string, IqKind]> = [
  ['logic-1', '甲比乙高，乙比丙高。三人里最高的是谁？答案只写一个字（甲、乙或丙）。', '甲', 'text'],
  ['logic-2', '甲比乙高，乙比丙高。三人里最矮的是谁？答案只写一个字（甲、乙或丙）。', '丙', 'text'],
  [
    'logic-3',
    '四个人排队：小王在小李前面，小李在小张前面，小赵站在最后。从前往后数，小张排第几？答案只写数字。',
    '3',
    'number',
  ],
  [
    'logic-4',
    '红、蓝、绿三个盒子排成一排：红盒在蓝盒左边，绿盒在红盒左边。从左往右第二个是什么颜色？答案只写一个字。',
    '红',
    'text',
  ],
  ['logic-5', '7、12、3、18、9 这五个数里，最大的数减最小的数是多少？答案只写数字。', '15', 'number'],
  ['logic-6', '今天是周三，再过 10 天是周几？答案只写「周几」，例如 周二。', '周六', 'text'],
  [
    'logic-7',
    '小明有 5 个苹果，给了小红 2 个，又从小刚那里拿到 4 个，现在有几个？答案只写数字。',
    '7',
    'number',
  ],
  ['logic-8', '数列 2、4、6、8……的第 10 个数是多少？答案只写数字。', '20', 'number'],
  ['logic-9', '数列 3、6、12、24……的第 6 个数是多少？答案只写数字。', '96', 'number'],
  ['logic-10', '1 到 10 里，既是偶数又是 3 的倍数的数是多少？答案只写数字。', '6', 'number'],
];

/** 题库。至少 30 道；个数取质数 37，和 15 分钟一轮的节奏错开，轮换时每道都轮得到。 */
export const IQ_QUESTIONS: readonly IqQuestion[] = [
  ...ARITHMETIC.map(arithmeticQuestion),
  ...LOGIC.map(([id, text, answer, kind]) => ({ id, text, short: text.split('？')[0] ?? id, answer, kind })),
  ...DATES.map(dateQuestion),
];

/** 按时刻轮换（分钟数对题数取余）。测试里可以注入别的挑法。 */
export function pickIqQuestion(now: Date, bank: readonly IqQuestion[] = IQ_QUESTIONS): IqQuestion {
  const minute = Math.floor(now.getTime() / 60_000);
  return bank[((minute % bank.length) + bank.length) % bank.length] as IqQuestion;
}

/** 问出去的整段提示词：保留「不要调用任何工具，不要解释」，要严格三行。 */
export function probePrompt(q: IqQuestion): string {
  return [
    '这是路由探针的连通性测试。不要调用任何工具，不要解释，严格按下面三行回复，不要多写别的：',
    '第一行只写 OK',
    '第二行写「答案：」加上下面这道题的最终答案',
    '第三行写「模型：」加上你自报的厂家和型号',
    `题目：${q.text}`,
  ].join('\n');
}

// ---- 解析和判 ----

export interface ProbeReply {
  /** 第一个非空行整行就是 OK（不分大小写）。 */
  ok: boolean;
  /** 「答案：」那一行冒号后面的原话，没有这一行是 null。 */
  answer: string | null;
  /** 「模型：」那一行冒号后面的原话，没有这一行是 null。 */
  identity: string | null;
}

/** 去掉 markdown 的粗体、反引号、代码块围栏，按行拆开（去空行）。 */
function cleanLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) => line.replace(/\*\*|__|`/g, '').trim())
    .filter((line) => line !== '');
}

export function parseProbeReply(text: string): ProbeReply {
  const lines = cleanLines(text);
  const labelled = (label: string): string | null => {
    for (const line of lines) {
      const m = new RegExp(`^${label}\\s*[:：]\\s*(.*)$`).exec(line);
      if (m) return (m[1] ?? '').trim();
    }
    return null;
  };
  return {
    ok: /^ok$/i.test(lines[0] ?? ''),
    answer: labelled('答案'),
    identity: labelled('模型'),
  };
}

/** 比答案前先规整：全角转半角、去空白、去千分位逗号、去句末标点、不分大小写，星期/礼拜写成周。 */
export function normalizeAnswer(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, '')
    .replace(/[。.!！;；,，、]+$/u, '')
    .toLowerCase()
    .replace(/星期|礼拜/g, '周');
}

/** 日期的几种写法（4-15、4月15日、04-15、2026-4-15）都规整成「4-15」。认不出的原样返回。 */
function canonicalDate(norm: string): string {
  const m = /^(?:\d{4}[年/.-])?(\d{1,2})(?:月|[-/.])(\d{1,2})[日号]?$/.exec(norm);
  return m ? `${Number(m[1])}-${Number(m[2])}` : norm;
}

function canonical(raw: string, kind: IqKind): string {
  const norm = normalizeAnswer(raw);
  return kind === 'date' ? canonicalDate(norm) : norm;
}

/** 实答和标准答案是不是同一个（规整之后）。没写（null）一定不对。 */
export function iqAnswerMatches(q: IqQuestion, answer: string | null): boolean {
  if (answer === null) return false;
  const got = canonical(answer, q.kind);
  return got !== '' && got === canonical(q.answer, q.kind);
}
