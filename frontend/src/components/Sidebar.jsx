import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import {
  ChartBar, Users, Kanban, Bell, Gear, PaperPlaneTilt, SignOut, Compass, ChatCircleDots, Plug, Sliders, ChatTeardropDots, Lightning, X, ChatTeardropText,
} from "@phosphor-icons/react";

const navBase = "flex items-center gap-3 px-4 py-3 md:py-2.5 text-sm border-l-2 border-transparent hover:bg-gray-100 transition-colors";
const navActive = "bg-white border-l-2 border-[#002FA7] text-gray-900 font-semibold";

function Item({ to, icon: Icon, children, testId, onNavigate }) {
  return (
    <NavLink to={to} data-testid={testId} onClick={onNavigate}
      className={({ isActive }) => `${navBase} ${isActive ? navActive : "text-gray-700"}`}>
      <Icon size={18} weight="regular" />
      <span>{children}</span>
    </NavLink>
  );
}

export default function Sidebar({ mobileOpen = false, onClose }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const isAdmin = user?.role === "admin";

  // When a nav item is clicked on mobile, close the drawer
  const handleNavigate = () => { if (mobileOpen && onClose) onClose(); };

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 md:hidden transition-opacity ${mobileOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
        data-testid="sidebar-backdrop"
        aria-hidden={!mobileOpen}
      />
      {/* Sidebar — fixed overlay on mobile, in-flow on md+ */}
      <aside
        className={`
          fixed md:relative top-0 left-0 z-50 md:z-auto h-full
          w-72 md:w-60 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col
          transform transition-transform duration-200 ease-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"} md:translate-x-0
        `}
        data-testid="app-sidebar"
      >
        <div className="px-5 py-5 border-b border-gray-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 bg-[#002FA7] flex items-center justify-center shrink-0">
              <Compass size={16} weight="bold" color="white" />
            </div>
            <div className="min-w-0">
              <div className="font-chivo font-black text-sm tracking-tight leading-none">LEADORBIT</div>
              <div className="text-[10px] uppercase tracking-widest text-gray-500 mt-0.5 truncate">CRM Control Room</div>
            </div>
          </div>
          {/* Mobile close button */}
          <button
            onClick={onClose}
            className="md:hidden p-1 text-gray-500 hover:text-gray-900"
            data-testid="sidebar-close-btn"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 py-3 space-y-0.5 overflow-y-auto">
          <div className="px-5 pt-2 pb-1 text-[10px] uppercase tracking-widest text-gray-400 font-bold">Workspace</div>
          <Item to="/dashboard" icon={ChartBar} testId="nav-dashboard" onNavigate={handleNavigate}>Dashboard</Item>
          <Item to="/chat" icon={ChatTeardropDots} testId="nav-chat" onNavigate={handleNavigate}>WhatsApp</Item>
          <Item to="/leads" icon={Kanban} testId="nav-leads" onNavigate={handleNavigate}>Leads</Item>
          <Item to="/followups" icon={Bell} testId="nav-followups" onNavigate={handleNavigate}>Follow-ups</Item>
          <Item to="/qa" icon={ChatTeardropText} testId="nav-qa" onNavigate={handleNavigate}>Internal Q&amp;A</Item>
          {isAdmin && (
            <>
              <div className="px-5 pt-4 pb-1 text-[10px] uppercase tracking-widest text-gray-400 font-bold">Admin</div>
              <Item to="/users" icon={Users} testId="nav-users" onNavigate={handleNavigate}>Executives</Item>
              <Item to="/routing" icon={Gear} testId="nav-routing" onNavigate={handleNavigate}>Routing Rules</Item>
              <Item to="/integrations" icon={Plug} testId="nav-integrations" onNavigate={handleNavigate}>Integrations</Item>
              <Item to="/templates" icon={ChatCircleDots} testId="nav-templates" onNavigate={handleNavigate}>WA Templates</Item>
              <Item to="/chatflows" icon={ChatTeardropDots} testId="nav-chatflows" onNavigate={handleNavigate}>Chatbot Flows</Item>
              <Item to="/quick-replies" icon={Lightning} testId="nav-quick-replies" onNavigate={handleNavigate}>Quick Replies</Item>
              <Item to="/settings" icon={Sliders} testId="nav-settings" onNavigate={handleNavigate}>Settings</Item>
              <Item to="/reports" icon={PaperPlaneTilt} testId="nav-reports" onNavigate={handleNavigate}>Reports</Item>
            </>
          )}
        </nav>

        <div className="border-t border-gray-200 p-4">
          <div className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">Signed in</div>
          <div className="mt-1 font-semibold text-sm" data-testid="current-user-name">{user?.name}</div>
          <div className="text-xs text-gray-500">
            <span className="kbd">{user?.role}</span> · @{user?.username}
          </div>
          <button
            className="mt-3 w-full flex items-center justify-center gap-2 border border-gray-300 py-2 text-xs uppercase tracking-wider font-bold hover:bg-gray-100"
            onClick={async () => { await logout(); nav("/login"); }}
            data-testid="logout-btn"
          >
            <SignOut size={14} /> Log out
          </button>
        </div>
      </aside>
    </>
  );
}
