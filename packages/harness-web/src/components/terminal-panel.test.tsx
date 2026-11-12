// @vitest-environment happy-dom
// 会话页有终端格，敲进去的字节按 pty.input 帧送出去。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const xterm = vi.hoisted(() => {
  let dataCb: ((data: string) => void) | undefined;
  type TermOptions = {
    theme?: unknown;
    windowsPty?: { backend?: string; buildNumber?: number };
  };
  const opened: { options: TermOptions }[] = [];
  class Terminal {
    options: TermOptions = {};
    constructor(options: TermOptions) {
      this.options = options;
      opened.push({ options });
    }
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
    onData(cb: (data: string) => void) {
      dataCb = cb;
      return { dispose() {} };
    }
  }
  class FitAddon {
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  }
  return {
    Terminal,
    FitAddon,
    opened,
    fire(data: string) {
      dataCb?.(data);
    },
  };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.Terminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xterm.FitAddon }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('../lib/profile', () => ({ IS_LOCAL: true }));

const empty = {
  status: 'live' as const,
  events: [],
  hasOlder: false,
  attempt: 0,
  retryInMs: null,
  resyncs: 0,
  error: null,
  errorStatus: null,
};

vi.mock('../lib/hooks', () => ({
  useSessionFeed: () => ({ feed: { loadOlder: async () => {}, stop() {} }, state: empty }),
  useTranscriptFeeds: () => ({ loadOlder: async () => {}, state: empty }),
  useSessions: () => ({
    sessions: [],
    stuckCount: 0,
    error: null,
    failures: 0,
    unauthorized: false,
    hasMore: false,
    loadingMore: false,
    loadMore: () => {},
  }),
}));

vi.mock('./session-list', () => ({ SessionList: () => <div /> }));
vi.mock('./changes-panel', () => ({ ChangesPanel: () => <div /> }));

const { Workbench } = await import('../pages/workbench');

const calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  xterm.opened.length = 0;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      calls.push({ url: String(url), method: init?.method ?? 'GET', body });
      if (String(url).includes('/terminal/stream')) {
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      if (String(url).endsWith('/terminal') && (init?.method ?? 'GET') === 'POST') {
        return Response.json({ runId: 'pty-1' });
      }
      if ((init?.method ?? 'GET') === 'POST') return Response.json({});
      if (String(url).includes('/sessions/')) {
        return Response.json({ session: { id: 's1', title: 't', status: 'idle', workspaceId: 'w' } });
      }
      return Response.json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('终端格', () => {
  it('打开终端后，输入的字节按 pty.input 送出', async () => {
    render(
      <MemoryRouter initialEntries={['/s/s1']}>
        <Routes>
          <Route path="/s/:id" element={<Workbench />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('terminal-open'));
    expect(await screen.findByTestId('terminal-panel')).toBeTruthy();
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/terminal') && c.method === 'POST')).toBe(true);
    });
    const bytes = new TextEncoder().encode('中');
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    xterm.fire('中');
    await waitFor(() => {
      const input = calls.find((c) => c.url.endsWith('/terminal/input'));
      expect(input?.body).toEqual({ type: 'pty.input', runId: 'pty-1', data: btoa(bin) });
    });
  });

  it('Windows 上 ConPTY 从 21376 起算宽度，不套旧的换行启发式', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });
    render(
      <MemoryRouter initialEntries={['/s/s1']}>
        <Routes>
          <Route path="/s/:id" element={<Workbench />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('terminal-open'));
    expect(await screen.findByTestId('terminal-panel')).toBeTruthy();
    await waitFor(() => {
      expect(xterm.opened.length).toBeGreaterThan(0);
    });
    const pty = xterm.opened.at(-1)?.options.windowsPty;
    expect(pty?.backend).toBe('conpty');
    expect(pty?.buildNumber).toBeGreaterThanOrEqual(21376);
  });
});
