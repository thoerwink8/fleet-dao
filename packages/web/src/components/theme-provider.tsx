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
  type ModePref,
  type MotionPref,
  type PaletteId,
  type ResolvedMode,
  readThemePref,
  resolveMode,
  saveThemePref,
  type ThemePref,
} from '../lib/theme';

interface ThemeApi {
  pref: ThemePref;
  resolvedMode: ResolvedMode;
  setPalette(p: PaletteId): void;
  setMode(m: ModePref): void;
  setMotion(m: MotionPref): void;
  /** 深浅互换（⌘K 与快捷键用）。 */
  toggleMode(): void;
}

const ThemeContext = createContext<ThemeApi | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const resolvedMode = resolveMode(pref.mode, systemDark);

  useLayoutEffect(() => {
    applyTheme(pref, systemDark);
  }, [pref, systemDark]);

  const update = useCallback((patch: Partial<ThemePref>) => {
    setPref((prev) => {
      const next = { ...prev, ...patch };
      saveThemePref(next);
      return next;
    });
  }, []);

  const api = useMemo<ThemeApi>(
    () => ({
      pref,
      resolvedMode,
      setPalette: (palette) => update({ palette }),
      setMode: (mode) => update({ mode }),
      setMotion: (motion) => update({ motion }),
      toggleMode: () => update({ mode: resolvedMode === 'dark' ? 'light' : 'dark' }),
    }),
    [pref, resolvedMode, update],
  );

  return <ThemeContext value={api}>{children}</ThemeContext>;
}

export function useTheme(): ThemeApi {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('缺少 ThemeProvider');
  return ctx;
}
