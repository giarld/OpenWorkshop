export type ColorTheme = "light" | "system" | "dark";
export type ResolvedColorTheme = "light" | "dark";

export const COLOR_THEME_STORAGE_KEY = "workshop:color-theme";
export const DEFAULT_COLOR_THEME: ColorTheme = "light";
export const SYSTEM_COLOR_THEME_QUERY = "(prefers-color-scheme: dark)";

export function storedColorTheme(value: string | null | undefined): ColorTheme {
  return value === "dark" || value === "system" ? value : DEFAULT_COLOR_THEME;
}

export function resolvedColorTheme(theme: ColorTheme, systemDark: boolean): ResolvedColorTheme {
  return theme === "system" ? systemDark ? "dark" : "light" : theme;
}

export function applyColorTheme(theme: ColorTheme, root: HTMLElement = document.documentElement, systemDark = window.matchMedia(SYSTEM_COLOR_THEME_QUERY).matches) {
  const resolved = resolvedColorTheme(theme, systemDark);
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

export function watchSystemColorTheme(media = window.matchMedia(SYSTEM_COLOR_THEME_QUERY), root: HTMLElement = document.documentElement) {
  const sync = () => {
    const theme = storedColorTheme(window.localStorage.getItem(COLOR_THEME_STORAGE_KEY));
    if (theme === "system") applyColorTheme(theme, root, media.matches);
  };
  media.addEventListener("change", sync);
  return () => media.removeEventListener("change", sync);
}

export const COLOR_THEME_INIT_SCRIPT = `try{var t=localStorage.getItem("${COLOR_THEME_STORAGE_KEY}");var p=t==="dark"||t==="system"?t:"light";var v=p==="system"&&matchMedia("${SYSTEM_COLOR_THEME_QUERY}").matches||p==="dark"?"dark":"light";document.documentElement.dataset.theme=v;document.documentElement.style.colorScheme=v}catch(e){}`;
