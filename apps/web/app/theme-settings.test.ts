import assert from "node:assert/strict";
import test from "node:test";
import { COLOR_THEME_INIT_SCRIPT, DEFAULT_COLOR_THEME, resolvedColorTheme, storedColorTheme } from "./theme-settings.ts";

test("normalizes persisted color themes", () => {
  assert.equal(storedColorTheme("dark"), "dark");
  assert.equal(storedColorTheme("light"), "light");
  assert.equal(storedColorTheme("system"), "system");
  assert.equal(storedColorTheme(null), DEFAULT_COLOR_THEME);
});

test("resolves system color theme from the operating system preference", () => {
  assert.equal(resolvedColorTheme("system", true), "dark");
  assert.equal(resolvedColorTheme("system", false), "light");
  assert.equal(resolvedColorTheme("light", true), "light");
  assert.equal(resolvedColorTheme("dark", false), "dark");
});

test("initial theme script applies the saved theme before hydration", () => {
  assert.match(COLOR_THEME_INIT_SCRIPT, /localStorage\.getItem/);
  assert.match(COLOR_THEME_INIT_SCRIPT, /matchMedia/);
  assert.match(COLOR_THEME_INIT_SCRIPT, /document\.documentElement\.dataset\.theme/);
});
