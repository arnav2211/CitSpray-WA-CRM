import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import {
  ChartBar, Users, Kanban, Bell, Gear, PaperPlaneTilt, SignOut, Compass, ChatCircleDots, Plug,
} from "@phosphor-icons/react";

const navBase = "flex items-center gap-3 px-4 py-2.5 text-sm border-l-2 border-transparent hover:bg-gray-100 transition-colors";
const navActive = "bg-white border-l-2 border-[#002FA7] text-gray-900 font-semibold";

function Item({ to, icon: Icon, children, testId }) {
  return (
    <NavLink to={to} data-testid={testId}
      className={({ isActive }) => `${navBase} ${isActive ? navActive : "text-gray-700"}`}>
      <Icon size={18} weight="regular" />
      <span>{children}</span>
    </NavLink>
  );
}

export default function Sidebar() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const isAdmin = user?.role === "admin";

  return (
    <aside className="w-60 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col" data-testid="app-sidebar">
      <div className="px-5 py-5 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-[#002FA7] flex items-center justify-center">
            <Compass size={16} weight="bold" color="white" />
          </div>
          <div>
            <div className="font-chivo font-black text-sm tracking-tight leading-none">LEADORBIT</div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500 mt-0.5">CRM Control Room</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 py-3 space-y-0.5">
        <div className="px-5 pt-2 pb-1 text-[10px] uppercase tracking-widest text-gray-400 font-bold">Workspace</div>
        <Item to="/dashboard" icon={ChartBar} testId="nav-dashboard">Dashboard</Item>
        <Item to="/leads" icon={Kanban} testId="nav-leads">Leads</Item>
        <Item to="/followups" icon={Bell} testId="nav-followups">Follow-ups</Item>
        {isAdmin && (
          <>
            <div className="px-5 pt-4 pb-1 text-[10px] uppercase tracking-widest text-gray-400 font-bold">Admin</div>
            <Item to="/users" icon={Users} testId="nav-users">Executives</Item>
            <Item to="/routing" icon={Gear} testId="nav-routing">Routing Rules</Item>
            <Item to="/integrations" icon={Plug} testId="nav-integrations">Integrations</Item>
            <Item to="/templates" icon={ChatCircleDots} testId="nav-templates">WA Templates</Item>
            <Item to="/reports" icon={PaperPlaneTilt} testId="nav-reports">Reports</Item>
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
  );
}
