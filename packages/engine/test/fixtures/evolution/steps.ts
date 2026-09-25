// 演练用的活动：每步一个活动类型（重放时对的是活动类型，参数不比）。
export const ran: string[] = [];

export async function stepA(): Promise<string> {
  ran.push('a');
  return 'a';
}

export async function stepB(): Promise<string> {
  ran.push('b');
  return 'b';
}

export async function stepC(): Promise<string> {
  ran.push('c');
  return 'c';
}
