import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { useMediaQuery } from '../lib/hooks';
import {
  applyTheme,
  type MotionPref,
  type ResolvedMode,
  readThemePref,
  saveThemePref,
  type ThemePref,
} from '../lib/theme';

interface ThemeApi {
  pref: ThemePref;
  /** 亮暗跟随系统（#3509 起没有切换开关），这里只读出来给 sonner 这类要传 theme 的第三方件。 */
  resolvedMode: ResolvedMode;
  setMotion(m: MotionPref): void;
}

const ThemeContext = createContext<ThemeApi | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const resolvedMode: ResolvedMode = systemDark ? 'dark' : 'light';

  useLayoutEffect(() => {
    applyTheme(pref);
  }, [pref]);

  const setMotion = useCallback((motion: MotionPref) => {
    const next = { motion };
    saveThemePref(next);
    setPref(next);
  }, []);

  const api = useMemo<ThemeApi>(() => ({ pref, resolvedMode, setMotion }), [pref, resolvedMode, setMotion]);

  return <ThemeContext value={api}>{children}</ThemeContext>;
}

export function useTheme(): ThemeApi {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('缺少 ThemeProvider');
  return ctx;
}
