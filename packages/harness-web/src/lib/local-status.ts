// 本机装法的状态口 /api/local/status（#3858）：宿主页、设置页读它。形状和 harness-api 的 LocalStatus 一致。
import { useEffect, useState } from 'react';
import { API_BASE, FatalApiError, getJson, isUnauthorized } from './api';

export type Level = 'strong' | 'medium' | 'weak';

export interface LocalStatus {
  profile: 'local';
  version: string;
  listen: string;
  dataDir: string;
  isolation: { level: Level; facts: string[] };
  externalWrites: { github: boolean; egressGateway: boolean };
  hosts: { id: string; kind: 'local' | 'ssh'; label: string; isolation: Level }[];
  settings: { key: string; value: string; note: string }[];
}

export const LEVEL_LABEL: Record<Level, string> = { strong: '强', medium: '中', weak: '弱' };

export function useLocalStatus(): {
  status: LocalStatus | null;
  error: string | null;
  unauthorized: boolean;
} {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    getJson<LocalStatus>(`${API_BASE}/local/status`, ac.signal)
      .then((s) => setStatus(s))
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        if (isUnauthorized(err)) setUnauthorized(true);
        else setError(err instanceof FatalApiError || err instanceof Error ? err.message : '读不到本机状态');
      });
    return () => ac.abort();
  }, []);
  return { status, error, unauthorized };
}
