import { type Db, getPrivateQuote, listPrivateQuotes, putPrivateQuotes } from '@fleet-dao/db';
import { parsePrivateQuotes, quoteIdValid, quoteTimeValid } from '@fleet-dao/shared';
export const QUOTE_USAGE =
  '用法：fleet-api quote put < quotes.json | quote get <id> | quote list --since <ISO时间>（原文只走标准输入/私有标准输出）';
export function parseQuoteArgs(args: readonly string[]) {
  if (args.length === 1 && args[0] === 'put') return { action: 'put' } as const;
  if (args.length === 2 && args[0] === 'get' && quoteIdValid(args[1]))
    return { action: 'get', id: args[1]! } as const;
  if (args.length === 3 && args[0] === 'list' && args[1] === '--since' && quoteTimeValid(args[2]))
    return { action: 'list', since: new Date(args[2]!) } as const;
  throw new Error(QUOTE_USAGE);
}
export async function runQuote(args: readonly string[], db: Db, stdin: () => Promise<string>) {
  const input = parseQuoteArgs(args);
  try {
    if (input.action === 'get') {
      const row = await getPrivateQuote(db, input.id);
      if (!row) throw new Error('missing');
      return row;
    }
    if (input.action === 'list') return await listPrivateQuotes(db, input.since);
    const quotes = parsePrivateQuotes(JSON.parse(await stdin()));
    return { ids: await putPrivateQuotes(db, quotes) };
  } catch {
    throw new Error('私有原话操作失败：输入无效、编号冲突、记录不存在或数据库不可用；内容不回显。');
  }
}
