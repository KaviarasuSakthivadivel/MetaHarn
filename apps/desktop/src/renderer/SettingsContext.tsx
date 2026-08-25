import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, getTheme } from "./themes.js";
import type { AgentKind } from "../preload/preload.js";

export type ThemeMode = "light" | "dark" | "system";

interface Settings {
  theme: ThemeMode;
  darkThemeId: string;
  lightThemeId: string;
  terminalFontSize: number;
  /** Which agent "+ New terminal session" uses without prompting, when
   * it's actually installed — see ProjectOverview.tsx. Defaults to Claude
   * since that's the only agent guaranteed to exist for most users. */
  defaultAgentKind: AgentKind;
}

const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  darkThemeId: DEFAULT_DARK_THEME_ID,
  lightThemeId: DEFAULT_LIGHT_THEME_ID,
  terminalFontSize: 13,
  defaultAgentKind: "claude",
};
const STORAGE_KEY = "metaharn:settings";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function useSystemPrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, []);
  return prefersDark;
}

interface SettingsContextValue extends Settings {
  resolvedMode: "light" | "dark";
  setTheme: (theme: ThemeMode) => void;
  setDarkThemeId: (id: string) => void;
  setLightThemeId: (id: string) => void;
  setTerminalFontSize: (size: number) => void;
  setDefaultAgentKind: (kind: AgentKind) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const systemPrefersDark = useSystemPrefersDark();
  const resolvedMode: "light" | "dark" =
    settings.theme === "system" ? (systemPrefersDark ? "dark" : "light") : settings.theme;

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));

    document.documentElement.setAttribute("data-theme", resolvedMode);

    const themeId = resolvedMode === "dark" ? settings.darkThemeId : settings.lightThemeId;
    const theme = getTheme(themeId);
    if (theme) {
      for (const [key, value] of Object.entries(theme.vars)) {
        document.documentElement.style.setProperty(key, value);
      }
    }
  }, [settings, resolvedMode]);

  const value: SettingsContextValue = {
    ...settings,
    resolvedMode,
    setTheme: (theme) => setSettings((s) => ({ ...s, theme })),
    setDarkThemeId: (darkThemeId) => setSettings((s) => ({ ...s, darkThemeId })),
    setLightThemeId: (lightThemeId) => setSettings((s) => ({ ...s, lightThemeId })),
    setTerminalFontSize: (terminalFontSize) => setSettings((s) => ({ ...s, terminalFontSize })),
    setDefaultAgentKind: (defaultAgentKind) => setSettings((s) => ({ ...s, defaultAgentKind })),
  };

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

/** Resolves "system" against the OS preference, for consumers (e.g. Monaco, xterm) that need a concrete light/dark value. */
export function useResolvedTheme(): "light" | "dark" {
  return useSettings().resolvedMode;
}
