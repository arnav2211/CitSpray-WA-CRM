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

  const isAdmin = user && user.role === "admin";
  const company = isAdmin ? stored : ((user && COMPANIES[user.company]) ? user.company : "citspray");

  const setCompany = useCallback((c) => {
    if (!COMPANIES[c]) return;
    localStorage.setItem("active_company", c);
    setStored(c);
    // Simplest correct scope-flip: every page refetches everything under the new
    // company header, and no stale cross-company state can linger anywhere.
    window.location.reload();
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
