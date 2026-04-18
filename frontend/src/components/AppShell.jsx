import React from "react";
import Sidebar from "@/components/Sidebar";
import { Outlet, useLocation } from "react-router-dom";

export default function AppShell() {
  const loc = useLocation();
  return (
    <div className="min-h-screen flex bg-white" data-testid="app-shell">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-20 bg-white/90 backdrop-blur-xl border-b border-gray-200 px-6 md:px-8 py-3 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">LeadOrbit</div>
            <div className="font-chivo font-bold text-lg leading-none">{pageTitle(loc.pathname)}</div>
          </div>
          <div className="text-xs text-gray-500 hidden md:block">
            <span className="kbd">v1.0</span> · Command Console
          </div>
        </header>
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function pageTitle(path) {
  if (path.startsWith("/leads")) return "Leads";
  if (path.startsWith("/followups")) return "Follow-ups";
  if (path.startsWith("/users")) return "Executives";
  if (path.startsWith("/routing")) return "Routing Rules";
  if (path.startsWith("/templates")) return "WhatsApp Templates";
  if (path.startsWith("/reports")) return "Reports";
  return "Dashboard";
}
