// 资源页表格里的一格怎么写（#3509 起只用 layout 的 Text、Tag）：读成了写数，没在占用、采样中、没读到写灰字加原因（悬停给原因），
// 内存快满了写橙字；磁盘读不全在数前面带 ≥，旁边一个橙色「不全」。绝不拿 0 顶。
import { Stack } from '../layout/stack';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';
import type { Cell, DiskCell } from './view';

const WORD = {
  sampling: '采样中',
  idle: '没在占用',
  empty: '空分组',
  none: '不单算',
  unread: '没读到',
} as const;

export function cellWord(cell: Cell): string {
  if (cell.kind === 'ok') return '';
  if (cell.kind === 'unread' && cell.word) return cell.word;
  return WORD[cell.kind];
}

export function diskWord(cell: DiskCell): string {
  return { ok: '', pending: '还没测完', none: '不单算', unread: '没读到' }[cell.kind];
}

/** 一格的原因（展开的明细里写全文；手机上没有悬停）。 */
export function whyOf(cell: Cell | DiskCell): string | undefined {
  if (cell.kind === 'ok')
    return 'incomplete' in cell ? cell.incomplete : 'title' in cell ? cell.title : undefined;
  return 'why' in cell ? cell.why : undefined;
}

export function CellText({ cell }: { cell: Cell }) {
  if (cell.kind === 'ok') {
    return (
      <Text tone={cell.tight ? 'warning' : 'default'} {...(cell.title ? { title: cell.title } : {})}>
        {cell.text}
      </Text>
    );
  }
  return (
    <Text tone="muted" {...('why' in cell && cell.why ? { title: cell.why } : {})}>
      {cellWord(cell)}
    </Text>
  );
}

export function DiskText({ cell }: { cell: DiskCell }) {
  if (cell.kind === 'ok') {
    return (
      <span data-disk-cell title={cell.incomplete}>
        <Stack direction="horizontal" gap="sm" align="center" justify="end">
          <Text>{cell.incomplete ? `≥ ${cell.text}` : cell.text}</Text>
          {cell.incomplete ? <Tag tone="warning">不全</Tag> : null}
        </Stack>
      </span>
    );
  }
  return (
    <Text tone="muted" title={cell.why}>
      {diskWord(cell)}
    </Text>
  );
}
