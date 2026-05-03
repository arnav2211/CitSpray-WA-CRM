import React, { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import FollowupAlerts from "@/components/FollowupAlerts";
import { Outlet, useLocation } from "react-router-dom";
import { List } from "@phosphor-icons/react";

export default function AppShell() {
  const loc = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const onChat = loc.pathname.startsWith("/chat");

  // Close mobile drawer on route change
  useEffect(() => { setSidebarOpen(false); }, [loc.pathname]);

  // Lock body scroll when drawer open (mobile only)
  useEffect(() => {
    if (sidebarOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = prev; };
    }
  }, [sidebarOpen]);

  return (
    <div className="min-h-screen flex bg-white" data-testid="app-shell">
      <Sidebar mobileOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-20 bg-white/90 backdrop-blur-xl border-b border-gray-200 px-4 md:px-8 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden -ml-1 p-2 text-gray-700 hover:bg-gray-100 rounded-sm"
              aria-label="Open menu"
              data-testid="open-sidebar-btn"
            >
              <List size={22} weight="bold" />
            </button>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">LeadOrbit</div>
              <div className="font-chivo font-bold text-base md:text-lg leading-none truncate">{pageTitle(loc.pathname)}</div>
            </div>
          </div>
          <div className="text-xs text-gray-500 hidden md:block">
            <span className="kbd">v1.0</span> · Command Console
          </div>
        </header>
        <div className={`flex-1 ${onChat ? "overflow-hidden" : "overflow-auto"}`}>
          <Outlet />
        </div>
      </main>
      <FollowupAlerts />
    </div>
  );
}

function pageTitle(path) {
  if (path.startsWith("/chatflows")) return "Chatbot Flows";
  if (path.startsWith("/chat")) return "WhatsApp";
  if (path.startsWith("/leads")) return "Leads";
  if (path.startsWith("/followups")) return "Follow-ups";
  if (path.startsWith("/users")) return "Executives";
  if (path.startsWith("/routing")) return "Routing Rules";
  if (path.startsWith("/templates")) return "WhatsApp Templates";
  if (path.startsWith("/quick-replies")) return "Quick Replies";
  if (path.startsWith("/integrations")) return "Integrations";
  if (path.startsWith("/settings")) return "Settings";
  if (path.startsWith("/reports")) return "Reports";
  return "Dashboard";
}
