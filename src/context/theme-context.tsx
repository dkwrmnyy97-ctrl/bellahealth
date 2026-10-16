import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { isNighttime } from '@/utils/sunset';
import type { UserTheme } from '@/constants/theme';

export type { UserTheme };
export type ThemeMode = 'auto' | 'light' | 'dark';

type ThemeContextType = {
  isDark: boolean;
  /** Biological sex — used ONLY for non-visual features (cycle section, BMR, pronouns).
   *  Never use this to select a colour palette — use `userTheme` instead. */
  isMale: boolean;
  /** @deprecated use `userTheme` for palette decisions; kept only to avoid HealthKit/profile re-work */
  hasGenderPref: boolean;
  setIsMale: (v: boolean) => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  toggleDark: () => void;
  /** Explicit user-chosen colour theme. Defaults to 'neutral' for all new users. */
  userTheme: UserTheme;
  setUserTheme: (t: UserTheme) => void;
};

const ThemeContext = createContext<ThemeContextType>({
  isDark: false,
  isMale: false,
  hasGenderPref: false,
  setIsMale: () => {},
  themeMode: 'light',
  setThemeMode: () => {},
  toggleDark: () => {},
  userTheme: 'neutral',
  setUserTheme: () => {},
});

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>('light');
  const [isMale, setIsMaleState] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [hasGenderPref, setHasGenderPref] = useState(false);
  const [userTheme, setUserThemeState] = useState<UserTheme>('neutral');

  // Load persisted prefs on mount
  useEffect(() => {
    AsyncStorage.multiGet(['theme_mode', 'dark_mode', 'is_male', 'user_theme'])
      .then(([[, savedMode], [, savedDark], [, savedMale], [, savedUserTheme]]) => {
        if (savedMale !== null) {
          setHasGenderPref(true);
          if (savedMale === 'true') setIsMaleState(true);
        }

        if (savedMode) {
          // Migrate: if dark_mode was set before theme_mode existed, convert it
          const mode = savedMode as ThemeMode;
          setThemeModeState(mode);
          if (mode === 'light')      setIsDark(false);
          else if (mode === 'dark')  setIsDark(true);
          else                       setIsDark(isNighttime());
        } else if (savedDark === 'true') {
          setThemeModeState('dark');
          setIsDark(true);
        }

        if (savedUserTheme === 'mauve' || savedUserTheme === 'forest') {
          setUserThemeState(savedUserTheme);
        }
        // No savedUserTheme (or unrecognised value) → stays 'neutral' (default)
      })
      .catch(() => {});
  }, []);

  // Auto mode: recheck every minute
  useEffect(() => {
    if (themeMode !== 'auto') return;
    const check = () => setIsDark(isNighttime());
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [themeMode]);

  function setThemeMode(mode: ThemeMode) {
    setThemeModeState(mode);
    AsyncStorage.setItem('theme_mode', mode).catch(() => {});
    if (mode === 'light')      setIsDark(false);
    else if (mode === 'dark')  setIsDark(true);
    else                       setIsDark(isNighttime());
  }

  function setIsMale(v: boolean) {
    setIsMaleState(v);
    setHasGenderPref(true);
    AsyncStorage.setItem('is_male', String(v)).catch(() => {});
  }

  function setUserTheme(t: UserTheme) {
    setUserThemeState(t);
    AsyncStorage.setItem('user_theme', t).catch(() => {});
  }

  function toggleDark() {
    setThemeMode(isDark ? 'light' : 'dark');
  }

  return (
    <ThemeContext.Provider value={{ isDark, isMale, hasGenderPref, setIsMale, themeMode, setThemeMode, toggleDark, userTheme, setUserTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useAppTheme() {
  return useContext(ThemeContext);
}
