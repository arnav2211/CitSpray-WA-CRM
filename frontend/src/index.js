import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "@/dark.css";
import App from "@/App";
import { applyTheme } from "@/context/ThemeContext";

// apply the saved theme before the first paint (no white flash in dark mode)
try { applyTheme(localStorage.getItem("theme") === "dark" ? "dark" : "light"); } catch { /* ignore */ }

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
