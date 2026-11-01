import { useCallback, useEffect, useState } from 'react';

/**
 * 主题（F5）：浅 / 深 / 跟随系统。
 *
 * 三条刻意的选择：
 * ① **默认值是「跟随系统」**，不是「浅色」。用户没表态时替他选一个，等于把偏好藏起来。
 * ② 主题写在 `<html class="dark">` 上，颜色全走 CSS 变量——组件里一个 `dark:` 都不需要，
 *    也就不会出现「新写的组件忘了加 dark:」这种必然会发生的漏网。
 * ③ 存的是**选择**（含 follow），不是算出来的结果；系统主题半夜切了，明天再打开要跟着换。
 */

export type ThemeChoice = 'light' | 'dark' | 'follow';

const KEY = 'ec_theme_v1';

/** 纯函数：给定选择与系统偏好，算出该不该上 dark（测试直接调它，不需要 DOM） */
export function resolveDark(choice: ThemeChoice, systemDark: boolean): boolean {
  if (choice === 'light') return false;
  if (choice === 'dark') return true;
  return systemDark;
}

export function readChoice(storage?: Pick<Storage, 'getItem'> | null): ThemeChoice {
  try {
    const raw = storage?.getItem(KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'follow') return raw;
  } catch {
    /* 隐私模式下 localStorage 会抛错：主题不该因此打不开页面 */
  }
  return 'follow';
}

export function systemPrefersDark(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function applyDark(dark: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', dark);
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(() =>
    readChoice(typeof localStorage === 'undefined' ? null : localStorage),
  );
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq?.addEventListener) return;
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const dark = resolveDark(choice, systemDark);
  useEffect(() => {
    applyDark(dark);
  }, [dark]);

  const set = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* 存不下只是下次打开回到跟随系统，不影响当前使用 */
    }
  }, []);

  return { choice, set, dark, systemDark };
}

export const THEME_LABEL: Record<ThemeChoice, string> = {
  light: '浅色',
  dark: '深色',
  follow: '跟随系统',
};
