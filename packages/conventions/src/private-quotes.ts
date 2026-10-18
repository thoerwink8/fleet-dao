import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type PrivateQuote, parsePrivateQuotes } from '../../shared/src/private-quotes.ts';
import { DirectiveRefused } from './directives.ts';
import type { FleetApiRunner } from './project-world.ts';
export const quotesDir = (home: string) => join(home, '.fleet-dao', 'private', 'quotes');
/** 拒绝软链目录/文件；新目录 0700、新文件 0600，独占创建并刷盘后才上传。 */
export function savePrivateQuote(home: string, quote: PrivateQuote) {
  parsePrivateQuotes([quote]);
  let path = home;
  for (const part of ['.fleet-dao', 'private', 'quotes']) {
    path = join(path, part);
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('私有原话目录不安全，未保存。');
    if (part !== '.fleet-dao') chmodSync(path, 0o700);
  }
  const file = join(path, quote.id + '.json');
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(quote));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** 单轮最多100条、一次SSH；失败不逐条重试，避免离线积压卡住引导。 */
export async function flushPrivateQuotes(home: string, api: FleetApiRunner, onlyId?: string) {
  const dir = quotesDir(home);
  if (!existsSync(dir)) return { sent: 0, remaining: 0 };
  try {
    for (const p of [join(home, '.fleet-dao'), join(home, '.fleet-dao', 'private'), dir])
      if (lstatSync(p).isSymbolicLink()) throw new Error('unsafe');
    const names = readdirSync(dir);
    const batch: Array<{ quote: PrivateQuote; file: string }> = [];
    for (const name of names) {
      if (batch.length >= 100 || (onlyId && name !== onlyId + '.json')) continue;
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      const file = join(dir, name);
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const [quote] = parsePrivateQuotes([JSON.parse(readFileSync(file, 'utf8'))]);
        if (quote && name === quote.id + '.json') batch.push({ quote, file });
      } catch {
        /* 坏的保留，其他合格项仍可补传；不回显原始错误。 */
      }
    }
    let sent = 0;
    if (batch.length) {
      try {
        const result = await api(['quote', 'put'], JSON.stringify(batch.map((x) => x.quote)));
        if (result.code !== 0) throw new Error('upload');
        const receipt = JSON.parse(result.stdout);
        const expected = new Set(batch.map((x) => x.quote.id));
        if (
          !Array.isArray(receipt.ids) ||
          receipt.ids.length !== expected.size ||
          new Set(receipt.ids).size !== expected.size ||
          receipt.ids.some((id: unknown) => typeof id !== 'string' || !expected.has(id))
        )
          throw new Error('receipt');
        for (const { file } of batch) {
          try {
            unlinkSync(file);
            sent++;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') sent++;
          }
        }
      } catch {
        /* 上传或回执未知，不删除、不逐条重试。 */
      }
    }
    return { sent, remaining: names.length - sent };
  } catch {
    throw new Error('私有原话补传没成：本机目录不可安全读取；内容不回显。');
  }
}
export function publicMeaning(meaning: string | undefined) {
  if (!meaning?.trim())
    throw new DirectiveRefused('对外仓记引导必须给 --meaning（不带项目业务、人名、地址）；原话未公开。');
  return meaning.trim();
}
export async function privatizeDirective<T extends { text: string; atDate: Date; owner: string }>(
  r: T,
  input: {
    home: string;
    machine: string;
    lineage: string;
    remote: string | null;
    meaning: string | undefined;
    api: FleetApiRunner;
  },
) {
  const meaning = publicMeaning(input.meaning);
  const id = randomUUID();
  savePrivateQuote(input.home, {
    id,
    spokenAt: r.atDate.toISOString(),
    text: r.text,
    machine: input.machine,
    lineage: input.lineage,
    remote: input.remote,
    directiveId: null,
  });
  const flushed = await flushPrivateQuotes(input.home, input.api, id);
  return {
    directive: { ...r, text: meaning, source: '私有记录', privateQuoteId: id },
    ...flushed,
  };
}
