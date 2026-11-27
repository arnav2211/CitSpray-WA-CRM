import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

/* Light / dark mode. The choice is kept on this device (localStorage) and applied as the
   `dark` class on <html>; src/dark.css re-colours the app's light classes under it. */
const ThemeCtx = createContext({ theme: "light", toggleTheme: () => {}, setTheme: () => {} });

export function applyTheme(t) {
  const dark = t === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0B0F17" : "#ffffff");
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try { return localStorage.getItem("theme") === "dark" ? "dark" : "light"; } catch { return "light"; }
  });
  useEffect(() => { applyTheme(theme); }, [theme]);
  const setTheme = useCallback((t) => {
    try { localStorage.setItem("theme", t); } catch { /* ignore */ }
    setThemeState(t);
  }, []);
  const toggleTheme = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);
  return <ThemeCtx.Provider value={{ theme, toggleTheme, setTheme }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
