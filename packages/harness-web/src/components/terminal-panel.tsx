// 会话终端（#3927）。xterm.js 按需加载。字节经 hostd 的 pty.* 帧来回，目录由服务端按会话填。
// 关掉页面再开不会接回还在跑的那条：这个格子卸掉时只关掉它打开的那个 runId，进程退出。未做接回。

import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { adeSend } from '../lib/ade';
import { API_BASE } from '../lib/api';
import { Button } from '../ui/button';

function clamp(n: number | undefined, fallback: number): number {
  if (!n || !Number.isFinite(n)) return fallback;
  return Math.min(1000, Math.max(1, Math.floor(n)));
}

function cssColor(name: string, depth = 0): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (raw.startsWith('var(') && depth < 2) {
    const inner =
      raw
        .slice(4, raw.endsWith(')') ? -1 : undefined)
        .split(',')[0]
        ?.trim() ?? '';
    if (inner.startsWith('--')) return cssColor(inner, depth + 1);
  }
  return raw;
}

function terminalTheme(): {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
} {
  return {
    background: cssColor('--fleet-layer-inset'),
    foreground: cssColor('--fleet-fg-1'),
    cursor: cssColor('--fleet-brand'),
    selectionBackground: cssColor('--fleet-layer-selected'),
  };
}

function bytesToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function takeEvents(buf: string): { rest: string; events: { event: string; data: string }[] } {
  const events: { event: string; data: string }[] = [];
  const parts = buf.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    if (!part.trim()) continue;
    let event = 'message';
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return { rest, events };
}

export function TerminalPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let cancelled = false;
    let openedId = '';
    let term: Terminal | undefined;
    let resize: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    const pending: string[] = [];
    // 下标读写，避免闭包赋值被收成「一直是 null」。
    const queued: { cols: number; rows: number }[] = [];
    const ac = new AbortController();
    const closeRun = (runId: string) => {
      if (!runId) return;
      void adeSend(`/sessions/${encodeURIComponent(sessionId)}/terminal/close`, 'POST', { runId }).catch(
        () => {},
      );
    };
    const sendInput = (runId: string, data: string) => {
      void adeSend(`/sessions/${encodeURIComponent(sessionId)}/terminal/input`, 'POST', {
        type: 'pty.input',
        runId,
        data,
      }).catch((err: unknown) => {
        if (!cancelled) setMsg(err instanceof Error ? err.message : '没写进去');
      });
    };
    const dispose = () => {
      themeObserver?.disconnect();
      resize?.disconnect();
      term?.dispose();
      term = undefined;
    };
    void (async () => {
      try {
        const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);
        await import('@xterm/xterm/css/xterm.css');
        if (cancelled) return;
        const fit: FitAddon = new FitAddon();
        const win = /Windows/i.test(navigator.userAgent);
        term = new XTerm({
          convertEol: false,
          fontFamily: 'JetBrains Mono Variable, ui-monospace, monospace',
          fontSize: 13,
          theme: terminalTheme(),
          cursorBlink: true,
          ...(win ? { windowsPty: { backend: 'conpty' as const, buildNumber: 19041 } } : {}),
        });
        term.loadAddon(fit);
        term.open(host);
        fit.fit();
        themeObserver = new MutationObserver(() => {
          if (term) term.options.theme = terminalTheme();
        });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        const flushSize = (cols: number, rows: number) => {
          const next = { cols: clamp(cols, 80), rows: clamp(rows, 24) };
          if (!openedId) queued[0] = next;
          else
            void adeSend(`/sessions/${encodeURIComponent(sessionId)}/terminal/resize`, 'POST', {
              runId: openedId,
              cols: next.cols,
              rows: next.rows,
            }).catch(() => {});
        };
        term.onData((data) => {
          const encoded = bytesToBase64(data);
          if (!openedId) pending.push(encoded);
          else sendInput(openedId, encoded);
        });
        if (typeof ResizeObserver !== 'undefined') {
          resize = new ResizeObserver(() => {
            fit.fit();
            const dims = fit.proposeDimensions();
            flushSize(dims?.cols ?? 80, dims?.rows ?? 24);
          });
          resize.observe(host);
        }
        const dims = fit.proposeDimensions();
        const opened = await adeSend<{ runId: string }>(
          `/sessions/${encodeURIComponent(sessionId)}/terminal`,
          'POST',
          { cols: clamp(dims?.cols, 80), rows: clamp(dims?.rows, 24) },
        );
        if (cancelled) {
          closeRun(opened.runId);
          return;
        }
        openedId = opened.runId;
        for (const data of pending) sendInput(openedId, data);
        pending.length = 0;
        const held = queued[0];
        if (held) flushSize(held.cols, held.rows);
        const res = await fetch(
          `${API_BASE}/ade/sessions/${encodeURIComponent(sessionId)}/terminal/stream?runId=${encodeURIComponent(openedId)}`,
          { signal: ac.signal, headers: { accept: 'text/event-stream' } },
        );
        if (!res.ok || !res.body) throw new Error('终端流没连上');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!cancelled) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          const parsed = takeEvents(buf);
          buf = parsed.rest;
          for (const ev of parsed.events) {
            if (ev.event === 'data') term?.write(base64ToBytes(ev.data));
            if (ev.event === 'exit') return;
          }
        }
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        if (!cancelled) setMsg(err instanceof Error ? err.message : '终端没打开');
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
      const id = openedId;
      openedId = '';
      dispose();
      closeRun(id);
    };
  }, [sessionId]);

  return (
    <aside
      data-testid="terminal-panel"
      className="absolute inset-0 z-20 flex flex-col bg-panel md:static md:z-auto md:h-64 md:shrink-0 md:border-t md:border-edge"
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-3">
        <span className="text-xs font-medium">终端</span>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          关闭
        </Button>
      </div>
      <div ref={ref} className="min-h-0 flex-1 bg-inset" />
      {msg ? <p className="shrink-0 px-3 py-1 text-2xs text-danger">{msg}</p> : null}
    </aside>
  );
}
