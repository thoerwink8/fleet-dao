// 通知中心测试共用（#3533）：页面改成左列表右详情后，一条通知的选项、修复区、处理了都在右边详情里，先点左边那一行再读详情。
import { fireEvent, screen } from '@testing-library/react';

/** 点开标题是 title 的那条通知，回右边的详情区（可重复调：已经开着也行）。 */
export async function openNotice(title: string): Promise<HTMLElement> {
  // 列表里的行在详情前面；详情也写标题，所以只点第一个
  const [first] = await screen.findAllByText(title);
  if (!first) throw new Error(`找不到标题是「${title}」的通知`);
  fireEvent.click(first);
  return screen.findByRole('region', { name: '通知详情' });
}

/** 列表里那一行（还没点开也能读：灰字、红标签在这里）。 */
export async function listRow(title: string): Promise<HTMLElement> {
  const [first] = await screen.findAllByText(title);
  const row = first?.closest('li[data-notice-row]');
  if (!row) throw new Error(`列表里找不到标题是「${title}」的行`);
  return row as HTMLElement;
}
