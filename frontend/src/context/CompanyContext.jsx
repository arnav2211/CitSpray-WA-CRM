import React, { createContext, useContext, useState, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";

export const COMPANIES = { citspray: "CitSpray", fragvansh: "Fragvansh" };

const CompanyContext = createContext(null);

// The active company scopes the whole UI. Admins switch freely (persisted in
// localStorage and sent as X-Company by lib/api.js); everyone else is pinned to
// the company on their user record — the backend enforces that regardless.
export function CompanyProvider({ children }) {
  const { user } = useAuth();
  const [stored, setStored] = useState(() => {
    const v = localStorage.getItem("active_company");
    return COMPANIES[v] ? v : "citspray";
  });

  // Admins switch to VIEW either company; data-entry switches to choose which
  // company they are ENTERING data for (they can't read either book anyway).
  const isAdmin = user && (user.role === "admin" || user.role === "data_entry");
  const company = isAdmin ? stored : ((user && COMPANIES[user.company]) ? user.company : "citspray");

  const setCompany = useCallback((c) => {
    if (!COMPANIES[c]) return;
    localStorage.setItem("active_company", c);
    setStored(c);
    // Scope-flip = full reload WITHOUT the query string: params like ?lead=<id>
    // deep-link into the other company's data (e.g. /chat kept showing the
    // previously open conversation after switching). Dropping the query resets
    // every page cleanly under the new X-Company header.
    window.location.href = window.location.pathname;
  }, []);

  return (
    <CompanyContext.Provider value={{
      company,
      companyLabel: COMPANIES[company] || "CitSpray",
      isFragvansh: company === "fragvansh",
      canSwitch: !!isAdmin,
      setCompany,
    }}>
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  // Safe fallback for anything rendered outside the provider (login page)
  return ctx || { company: "citspray", companyLabel: "CitSpray", isFragvansh: false, canSwitch: false, setCompany: () => {} };
}
