import React, { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import FollowupAlerts from "@/components/FollowupAlerts";
import { AlertListener } from "@/components/AlertListener";
import { Outlet, useLocation, useNavigate, NavLink } from "react-router-dom";
import { List, House, ChatTeardropDots, Kanban, Phone, PhoneCall } from "@phosphor-icons/react";
import { useAuth } from "@/context/AuthContext";

export default function AppShell() {
  const loc = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const onChat = loc.pathname.startsWith("/chat");

  useEffect(() => {
    if (user && user.role === "data_entry" && loc.pathname !== "/data-entry") {
      navigate("/data-entry", { replace: true });
    }
  }, [user, loc.pathname, navigate]);

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
    <div className="h-screen app-shell-viewport flex bg-white overflow-hidden" data-testid="app-shell">
      <Sidebar mobileOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
        <header className="shrink-0 z-20 bg-white/90 backdrop-blur-xl border-b border-gray-200 px-4 md:px-8 py-3 flex items-center justify-between gap-3">
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
        <div className={`flex-1 min-h-0 ${onChat ? "overflow-hidden" : "overflow-auto"}`}>
          <Outlet />
        </div>
        {/* Mobile bottom nav — in normal flow (not fixed) so it can never
            overlap page content like the Add Note button */}
        {user?.role !== "data_entry" && (
          <nav
            className="md:hidden shrink-0 bg-white border-t border-gray-200 flex items-stretch justify-around h-14 shadow-[0_-2px_10px_rgba(0,0,0,0.05)]"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            data-testid="mobile-bottom-nav"
          >
            <NavLink to="/dashboard" className={({ isActive }) => `flex flex-col items-center justify-center flex-1 text-[10px] ${isActive ? "text-[#002FA7] font-semibold" : "text-gray-500"}`}>
              <House size={20} weight="regular" />
              <span className="mt-0.5">Dashboard</span>
            </NavLink>
            <NavLink to="/chat" className={({ isActive }) => `flex flex-col items-center justify-center flex-1 text-[10px] ${isActive ? "text-[#002FA7] font-semibold" : "text-gray-500"}`}>
              <ChatTeardropDots size={20} weight="regular" />
              <span className="mt-0.5">WhatsApp</span>
            </NavLink>
            <NavLink to="/leads" className={({ isActive }) => `flex flex-col items-center justify-center flex-1 text-[10px] ${isActive ? "text-[#002FA7] font-semibold" : "text-gray-500"}`}>
              <Kanban size={20} weight="regular" />
              <span className="mt-0.5">Leads</span>
            </NavLink>
            <a href="tel:dialer" className="flex flex-col items-center justify-center flex-1 text-[10px] text-gray-500">
              <Phone size={20} weight="regular" />
              <span className="mt-0.5">Dialer</span>
            </a>
            <NavLink to="/calls" className={({ isActive }) => `flex flex-col items-center justify-center flex-1 text-[10px] ${isActive ? "text-[#002FA7] font-semibold" : "text-gray-500"}`}>
              <PhoneCall size={20} weight="regular" />
              <span className="mt-0.5">Calls</span>
            </NavLink>
          </nav>
        )}
      </main>
      <FollowupAlerts />
      <AlertListener />
    </div>
  );
}

function pageTitle(path) {
  if (path.startsWith("/data-entry-inspect")) return "Data Entry Stats";
  if (path.startsWith("/data-entry")) return "Lead Entry";
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
  if (path.startsWith("/alerts")) return "Admin Alerts";
  return "Dashboard";
}
