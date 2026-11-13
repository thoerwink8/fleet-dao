// @vitest-environment happy-dom
// #3928：宿主页只登记别名、目标和密钥路径。
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ade', () => ({
  adeGet: vi.fn(async () => ({ hosts: [] })),
  adeSend: vi.fn(),
}));

vi.mock('../lib/local-status', async () => {
  const actual = await vi.importActual<typeof import('../lib/local-status')>('../lib/local-status');
  return {
    ...actual,
    useLocalStatus: () => ({ status: null, error: null, unauthorized: false }),
  };
});

const { HostsPage } = await import('./local-pages');

afterEach(() => cleanup());

describe('宿主页（#3928）', () => {
  it('只有别名、目标和密钥路径，没有端口转发', async () => {
    render(<HostsPage />);
    const form = await screen.findByLabelText('添加 SSH 宿主');
    expect(screen.getByText('别名')).toBeTruthy();
    expect(screen.getByText('SSH 目标')).toBeTruthy();
    expect(screen.getByText('密钥路径')).toBeTruthy();
    expect(form.querySelectorAll('input')).toHaveLength(3);
    expect(document.body.textContent ?? '').not.toMatch(/端口转发|portForward|LocalForward|RemoteForward/);
  });
});
