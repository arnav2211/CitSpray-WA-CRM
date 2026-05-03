import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { fmtIST } from "@/lib/format";
import { ChatTeardropText, MagnifyingGlass, ArrowRight, ArrowsClockwise } from "@phosphor-icons/react";

const POLL_MS = 6000;
const FILTERS = [
  { k: "all",      label: "All" },
  { k: "pending",  label: "Pending" },
  { k: "answered", label: "Answered" },
];

export default function InternalQA() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filter !== "all") params.status = filter;
      if (q.trim()) params.q = q.trim();
      const { data } = await api.get("/internal-qa/threads", { params });
      setRows(data || []);
    } catch (e) { toast.error(errMsg(e)); }
    finally { setLoading(false); }
  }, [filter, q]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const counts = useMemo(() => {
    const c = { all: rows.length, pending: 0, answered: 0 };
    rows.forEach((r) => { if (r.status === "pending") c.pending += 1; else if (r.status === "answered") c.answered += 1; });
    return c;
  }, [rows]);

  const openInChat = (r) => {
    nav(`/chat?lead=${r.lead_id}&tab=internal${user?.role === "admin" ? `&agent=${r.agent_id}` : ""}`);
  };

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-6xl" data-testid="internal-qa-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-2">
            <ChatTeardropText size={12} weight="bold" /> Tracker
          </div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Internal Q&amp;A</h1>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl leading-relaxed">
            Every private question between {user?.role === "admin" ? "agents and you" : "you and admin"} — tracked with status, timestamp, and a one-click jump to the related chat.
            {user?.role === "executive" && " Only your own threads are visible here."}
          </p>
        </div>
        <button onClick={load} disabled={loading} className="border border-gray-900 hover:bg-gray-900 hover:text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50" data-testid="qa-refresh-btn">
          <ArrowsClockwise size={12} weight="bold" /> {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Filter strip */}
      <div className="flex items-center gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.k}
            onClick={() => setFilter(f.k)}
            className={`px-3 py-1.5 text-[11px] uppercase tracking-widest font-bold border ${filter === f.k ? "bg-[#002FA7] text-white border-[#002FA7]" : "border-gray-300 hover:bg-gray-100"}`}
            data-testid={`qa-filter-${f.k}`}
          >
            {f.label} <span className="ml-1 opacity-70">({counts[f.k]})</span>
          </button>
        ))}
        <div className="flex-1 max-w-xs ml-auto">
          <div className="flex items-center border border-gray-300 bg-white">
            <MagnifyingGlass size={14} className="ml-2 text-gray-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search customer, agent, question…"
              className="flex-1 px-2 py-2 text-sm outline-none"
              data-testid="qa-search-input"
            />
          </div>
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block border border-gray-200 bg-white overflow-hidden" data-testid="qa-table">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
              <th className="text-left px-4 py-3">Lead / Customer</th>
              <th className="text-left px-4 py-3">Agent</th>
              <th className="text-left px-4 py-3">Last Question</th>
              <th className="text-left px-4 py-3">Last Reply</th>
              <th className="text-left px-4 py-3">Replied By</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-right px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-xs uppercase tracking-widest text-gray-400 font-bold">
                {loading ? "Loading…" : "No internal Q&A threads match this filter."}
              </td></tr>
            )}
            {rows.map((r) => (
              <tr key={`${r.lead_id}:${r.agent_id}`} className="hover:bg-gray-50" data-testid={`qa-row-${r.lead_id}-${r.agent_username || r.agent_id}`}>
                <td className="px-4 py-3">
                  <div className="font-semibold text-sm">{r.lead_customer_name || "Unknown"}</div>
                  <div className="text-[11px] text-gray-500 font-mono">{r.lead_phone || "—"}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="text-sm">{r.agent_name || r.agent_username}</div>
                  <div className="text-[10px] text-gray-500 font-mono">@{r.agent_username || r.agent_id?.slice(0, 6)}</div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-700 max-w-[260px]">
                  <div className="truncate">{r.last_from_role === "executive" ? r.last_body : (r.last_asked_at ? "(earlier) " : "—")}</div>
                  <div className="text-[10px] text-gray-400 font-mono mt-0.5">{r.last_asked_at ? fmtIST(r.last_asked_at) : "—"}</div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-700 max-w-[260px]">
                  <div className="truncate">{r.last_from_role === "admin" ? r.last_body : (r.last_replied_at ? "(earlier) " : "—")}</div>
                  <div className="text-[10px] text-gray-400 font-mono mt-0.5">{r.last_replied_at ? fmtIST(r.last_replied_at) : "—"}</div>
                </td>
                <td className="px-4 py-3 text-sm">
                  {r.replied_by?.name || (r.replied_by?.username ? `@${r.replied_by.username}` : <span className="text-gray-400 italic">—</span>)}
                </td>
                <td className="px-4 py-3">
                  <StatusChip status={r.status} unread={r.unread_for_me} />
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => openInChat(r)}
                    className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold inline-flex items-center gap-1"
                    data-testid={`qa-open-chat-${r.lead_id}`}
                  >
                    Open chat <ArrowRight size={11} weight="bold" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card list */}
      <div className="md:hidden space-y-3">
        {rows.length === 0 && (
          <div className="border border-gray-200 bg-white p-6 text-center text-xs uppercase tracking-widest text-gray-400 font-bold">
            {loading ? "Loading…" : "No internal Q&A threads match this filter."}
          </div>
        )}
        {rows.map((r) => (
          <div key={`${r.lead_id}:${r.agent_id}:m`} className="border border-gray-200 bg-white p-3" data-testid={`qa-card-${r.lead_id}-${r.agent_username || r.agent_id}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold text-sm truncate">{r.lead_customer_name || "Unknown"}</div>
                <div className="text-[11px] text-gray-500 font-mono">{r.lead_phone || "—"}</div>
              </div>
              <StatusChip status={r.status} unread={r.unread_for_me} />
            </div>
            <div className="mt-2 text-xs text-gray-700 truncate">{r.last_body || "—"}</div>
            <div className="mt-1 text-[10px] text-gray-500 font-mono">
              {r.agent_name || r.agent_username} · {r.last_asked_at ? fmtIST(r.last_asked_at) : ""}
            </div>
            <button
              onClick={() => openInChat(r)}
              className="mt-2 w-full bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold inline-flex items-center justify-center gap-1"
              data-testid={`qa-open-chat-m-${r.lead_id}`}
            >
              Open chat <ArrowRight size={11} weight="bold" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusChip({ status, unread }) {
  const cls = status === "pending"
    ? "bg-[#FFF4E5] border-[#E67E00] text-[#B85F00]"
    : status === "answered"
      ? "bg-[#E7F7E6] border-[#008A00] text-[#005F00]"
      : "bg-gray-100 border-gray-300 text-gray-600";
  const label = status === "pending" ? "Pending" : status === "answered" ? "Answered" : "New";
  return (
    <span className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] uppercase tracking-widest font-bold ${cls}`} data-testid={`qa-status-${status}`}>
      {label}
      {unread > 0 && <span className="bg-[#E60000] text-white rounded-full px-1.5 text-[9px] ml-0.5">{unread}</span>}
    </span>
  );
}
