import React, { useEffect, useMemo, useState, useCallback } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle, Clock, ArrowClockwise, WhatsappLogo, ArrowSquareOut,
  Package, Bell, MagnifyingGlass, CaretDown,
} from "@phosphor-icons/react";
import { fmtIST } from "@/lib/format";
import LeadDrawer from "@/components/LeadDrawer";

const POLL_MS = 15000;

// Bucket + color a follow-up by how urgent it is right now.
function urgency(f) {
  const due = new Date(f.due_at).getTime();
  const now = Date.now();
  const diffMin = (due - now) / 60000;
  if (f.status === "missed" || diffMin < -30) return { key: "overdue", label: "Overdue", cls: "bg-[#FDECEC] border-[#E60000] text-[#B00000]", dot: "bg-[#E60000]" };
  if (diffMin < 0) return { key: "due", label: "Due now", cls: "bg-[#FFF4E5] border-[#E67E00] text-[#B85F00]", dot: "bg-[#E67E00]" };
  if (diffMin < 120) return { key: "soon", label: "Due soon", cls: "bg-[#FFFBEA] border-[#D4A200] text-[#8A6D00]", dot: "bg-[#D4A200]" };
  return { key: "upcoming", label: "Upcoming", cls: "bg-[#EAF1FF] border-[#002FA7] text-[#002FA7]", dot: "bg-[#002FA7]" };
}

const FILTERS = [
  { k: "open", label: "To do" },
  { k: "reorder", label: "Reorders" },
  { k: "done", label: "Done" },
  { k: "all", label: "All" },
];

export default function Followups() {
  const nav = useNavigate();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("open");
  const [q, setQ] = useState("");
  const [openLeadId, setOpenLeadId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/followups");
      setList(Array.isArray(data) ? data : []);
    } catch (e) { toast.error(errMsg(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const markDone = async (id) => {
    setList((prev) => prev.filter((f) => f.id !== id));
    try { await api.patch(`/followups/${id}`, { status: "done" }); toast.success("Marked done"); }
    catch (e) { toast.error(errMsg(e)); load(); }
  };
  const snooze = async (id, minutes, label) => {
    setList((prev) => prev.filter((f) => f.id !== id));
    try { await api.patch(`/followups/${id}`, { snooze_minutes: minutes }); toast.success(`Snoozed ${label}`); }
    catch (e) { toast.error(errMsg(e)); load(); }
  };

  const filtered = useMemo(() => {
    let rows = [...list];
    if (filter === "open") rows = rows.filter((f) => f.status === "pending" || f.status === "missed");
    else if (filter === "reorder") rows = rows.filter((f) => f.meta?.type === "reorder" && f.status !== "done");
    else if (filter === "done") rows = rows.filter((f) => f.status === "done");
    if (q.trim()) {
      const ql = q.trim().toLowerCase();
      rows = rows.filter((f) =>
        (f.lead_customer_name || "").toLowerCase().includes(ql) ||
        (f.lead_phone || "").toLowerCase().includes(ql) ||
        (f.note || "").toLowerCase().includes(ql));
    }
    // Sort: overdue/due first (earliest due_at), done last
    rows.sort((a, b) => {
      if ((a.status === "done") !== (b.status === "done")) return a.status === "done" ? 1 : -1;
      return new Date(a.due_at) - new Date(b.due_at);
    });
    return rows;
  }, [list, filter, q]);

  const counts = useMemo(() => ({
    open: list.filter((f) => f.status === "pending" || f.status === "missed").length,
    reorder: list.filter((f) => f.meta?.type === "reorder" && f.status !== "done").length,
    overdue: list.filter((f) => (f.status === "missed") || (f.status === "pending" && new Date(f.due_at) < new Date(Date.now() - 30 * 60000))).length,
  }), [list]);

  return (
    <div className="p-4 md:p-8 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1.5">
            <Bell size={12} weight="bold" /> Schedule
          </div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Follow-ups</h1>
          <p className="text-xs text-gray-500 mt-1">
            {counts.overdue > 0
              ? <span className="text-[#E60000] font-bold">{counts.overdue} overdue — act now.</span>
              : "You're on top of your follow-ups."}
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="border border-gray-900 hover:bg-gray-900 hover:text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50">
          <ArrowClockwise size={12} weight="bold" /> {loading ? "…" : "Refresh"}
        </button>
      </div>

      {/* Filters + search */}
      <div className="flex items-center gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <button key={f.k} onClick={() => setFilter(f.k)}
            className={`px-3 py-1.5 text-[11px] uppercase tracking-widest font-bold border ${filter === f.k ? "bg-[#002FA7] text-white border-[#002FA7]" : "border-gray-300 hover:bg-gray-100"}`}
            data-testid={`fu-filter-${f.k}`}>
            {f.label}
            {f.k === "open" && counts.open > 0 && <span className="ml-1 opacity-80">({counts.open})</span>}
            {f.k === "reorder" && counts.reorder > 0 && <span className="ml-1 opacity-80">({counts.reorder})</span>}
          </button>
        ))}
        <div className="flex-1 max-w-xs ml-auto">
          <div className="flex items-center border border-gray-300 bg-white">
            <MagnifyingGlass size={14} className="ml-2 text-gray-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer, phone, note…"
              className="flex-1 px-2 py-2 text-sm outline-none" data-testid="fu-search" />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="border border-dashed border-gray-300 bg-gray-50/50 py-16 text-center">
            <CheckCircle size={40} weight="light" className="mx-auto text-gray-300 mb-2" />
            <div className="text-xs uppercase tracking-widest text-gray-400 font-bold">
              {loading ? "Loading…" : "Nothing to follow up"}
            </div>
          </div>
        )}
        {filtered.map((f) => (
          <FollowupCard key={f.id} f={f} onOpen={() => setOpenLeadId(f.lead_id)}
            onChat={() => nav(`/chat?lead=${f.lead_id}`)} onDone={() => markDone(f.id)}
            onSnooze={(min, lbl) => snooze(f.id, min, lbl)} />
        ))}
      </div>

      {openLeadId && (
        <LeadDrawer leadId={openLeadId} onClose={() => { setOpenLeadId(null); load(); }} />
      )}
    </div>
  );
}

function FollowupCard({ f, onOpen, onChat, onDone, onSnooze }) {
  const u = urgency(f);
  const isReorder = f.meta?.type === "reorder";
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const done = f.status === "done";
  return (
    <div className={`border bg-white p-3 flex items-start gap-3 ${done ? "opacity-60" : ""}`} data-testid={`followup-${f.id}`}>
      <span className={`mt-1 w-2.5 h-2.5 rounded-full shrink-0 ${u.dot}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={onOpen} className="font-semibold text-sm hover:underline text-gray-900 truncate" data-testid={`fu-open-${f.id}`}>
            {f.lead_customer_name || "Unknown lead"}
          </button>
          {f.lead_phone && <span className="text-[11px] text-gray-500 font-mono">{f.lead_phone}</span>}
          {isReorder && (
            <span className="inline-flex items-center gap-1 bg-[#F3E8FF] border border-[#7C3AED] text-[#6D28D9] px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold rounded-sm">
              <Package size={10} weight="bold" /> Reorder
            </span>
          )}
          {!done && !isReorder && (
            <span className={`border px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold rounded-sm ${u.cls}`}>{u.label}</span>
          )}
        </div>
        <div className="text-xs text-gray-700 mt-1 whitespace-pre-wrap break-words">{f.note || "—"}</div>
        <div className="text-[10px] text-gray-400 font-mono mt-1">
          {done ? `Completed ${fmtIST(f.due_at)}` : isReorder ? "Reorder opportunity — call when you can" : `Due ${fmtIST(f.due_at)}`}
        </div>
      </div>
      {!done && (
        <div className="flex items-center gap-1 shrink-0 relative">
          <button onClick={onChat} title="Open WhatsApp chat"
            className="p-1.5 text-[#128C7E] hover:bg-[#128C7E]/10 rounded" data-testid={`fu-chat-${f.id}`}>
            <WhatsappLogo size={18} weight="fill" />
          </button>
          <button onClick={onOpen} title="Open lead"
            className="p-1.5 text-[#002FA7] hover:bg-[#002FA7]/10 rounded" data-testid={`fu-drawer-${f.id}`}>
            <ArrowSquareOut size={17} weight="bold" />
          </button>
          <div className="relative">
            <button onClick={() => setSnoozeOpen((v) => !v)} title="Snooze"
              className="p-1.5 text-gray-500 hover:bg-gray-100 rounded flex items-center" data-testid={`fu-snooze-${f.id}`}>
              <Clock size={17} /><CaretDown size={9} />
            </button>
            {snoozeOpen && (
              <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 shadow-lg z-10 w-32 py-1" onMouseLeave={() => setSnoozeOpen(false)}>
                {[["1 hour", 60], ["3 hours", 180], ["Tomorrow", 1440]].map(([lbl, min]) => (
                  <button key={min} onClick={() => { setSnoozeOpen(false); onSnooze(min, lbl); }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50" data-testid={`fu-snooze-${min}-${f.id}`}>{lbl}</button>
                ))}
              </div>
            )}
          </div>
          <button onClick={onDone} title="Mark done"
            className="p-1.5 text-[#008A00] hover:bg-[#008A00]/10 rounded" data-testid={`fu-done-${f.id}`}>
            <CheckCircle size={18} weight="fill" />
          </button>
        </div>
      )}
    </div>
  );
}
