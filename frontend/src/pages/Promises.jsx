import React, { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { Handshake, ChatCircleDots, Check, X, ArrowsClockwise } from "@phosphor-icons/react";
import { fmtSmartLong } from "@/lib/format";

/* Promises made on calls ("I'll send you the price on WhatsApp"), found by the AI
   call summary, and whether they were really kept - the AI reads what was sent
   after the call. Admins see everyone's; executives see their own. */

const STATUS = {
  open: { label: "Waiting", cls: "bg-amber-100 text-amber-800" },
  reminded: { label: "Reminded", cls: "bg-orange-100 text-orange-800" },
  missed: { label: "Not kept", cls: "bg-red-600 text-white" },
  no_window: { label: "Waiting for customer", cls: "bg-gray-200 text-gray-700" },
  kept: { label: "Kept", cls: "bg-green-100 text-green-800" },
  kept_late: { label: "Kept late", cls: "bg-lime-200 text-lime-900" },
  dismissed: { label: "Dismissed", cls: "bg-gray-100 text-gray-500" },
  expired: { label: "Expired", cls: "bg-gray-100 text-gray-500" },
};
const FILTERS = [
  ["open,reminded,missed,no_window", "Pending"],
  ["missed", "Not kept"],
  ["kept,kept_late", "Kept"],
  ["kept_late", "Kept late"],
  ["", "All"],
];

// "1 d 3 h" / "2 h 15 min" / "40 min"
function fmtLate(min) {
  const m = Math.max(0, Math.round(min || 0));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d} d${h ? ` ${h} h` : ""}`;
  if (h) return `${h} h${mm ? ` ${mm} min` : ""}`;
  return `${mm} min`;
}

export default function Promises() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [filter, setFilter] = useState(FILTERS[0][0]);
  const [person, setPerson] = useState("");
  const [people, setPeople] = useState([]);
  const [data, setData] = useState({ rows: [], counts: {} });
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { days: 30 };
      if (filter) params.status = filter;
      if (person) params.exec_id = person;
      const { data: d } = await api.get("/promises", { params });
      setData(d);
    } catch (e) { toast.error(errMsg(e)); } finally { setLoading(false); }
  }, [filter, person]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isAdmin) return;
    api.get("/users").then(({ data: u }) => setPeople(u.filter((x) => x.role === "executive"))).catch(() => {});
  }, [isAdmin]);

  const resolve = async (id, status) => {
    const note = status === "dismissed" ? window.prompt("Why dismiss this promise? (optional)") : "";
    if (note === null) return;
    try {
      await api.post(`/promises/${id}/resolve`, { status, note });
      toast.success(status === "kept" ? "Marked as kept" : "Dismissed");
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };
  // Opens the chat in a NEW TAB so the Promises list stays where it was
  // (inside the phone app it opens in the app itself)
  const openChat = (r) => {
    if (r.company && localStorage.getItem("active_company") !== r.company && isAdmin) {
      localStorage.setItem("active_company", r.company);   // the new tab opens in the lead's company
    }
    window.open(`/chat?lead=${r.lead_id}`, "_blank", "noopener");
  };

  const c = data.counts || {};
  const pending = (c.open || 0) + (c.reminded || 0) + (c.no_window || 0);
  return (
    <div className="p-4 md:p-8 space-y-4" data-testid="promises-page">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1"><Handshake size={12} /> From AI call summaries</div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Promises</h1>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            What was promised to customers on calls ("I'll send the price on WhatsApp") and whether it was really sent.
            The AI reads the WhatsApp messages sent after the call — "ok" or "I'll update you" doesn't count.
            Reminder after 3 office hours, admin alert 3 office hours later. Last 30 days.
          </p>
        </div>
        <button type="button" onClick={load} className="border border-gray-300 px-3 py-1.5 text-xs flex items-center gap-1"><ArrowsClockwise size={12} className={loading ? "animate-spin" : ""} /> Refresh</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="border border-gray-200 bg-white p-3"><div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Pending</div><div className="font-chivo font-black text-2xl">{pending}</div></div>
        <div className="border border-gray-200 bg-white p-3"><div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Not kept</div><div className="font-chivo font-black text-2xl text-red-600">{c.missed || 0}</div></div>
        <div className="border border-gray-200 bg-white p-3"><div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Kept</div><div className="font-chivo font-black text-2xl text-green-700">{(c.kept || 0) + (c.kept_late || 0)}{c.kept_late ? <span className="text-xs font-bold text-lime-700 ml-2">{c.kept_late} late</span> : null}</div></div>
        <div className="border border-gray-200 bg-white p-3"><div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Waiting for customer</div><div className="font-chivo font-black text-2xl text-gray-600">{c.no_window || 0}</div></div>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        {FILTERS.map(([v, label]) => (
          <button key={label} type="button" onClick={() => setFilter(v)}
            className={`px-3 py-1.5 text-xs font-bold uppercase tracking-widest border ${filter === v ? "bg-gray-900 text-white border-gray-900" : "border-gray-300 bg-white"}`}>{label}</button>
        ))}
        {isAdmin && (
          <select value={person} onChange={(e) => setPerson(e.target.value)} className="border border-gray-300 px-2 py-1.5 text-xs">
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>

      <div className="space-y-2">
        {!data.rows.length && <div className="text-sm text-gray-500 border border-dashed border-gray-300 p-6 text-center">{loading ? "Loading…" : "No promises here."}</div>}
        {data.rows.map((r) => {
          const st = STATUS[r.status] || { label: r.status, cls: "bg-gray-100" };
          const partly = r.ai_verdict === "partly" && !["kept", "kept_late"].includes(r.status);
          return (
            <div key={r.id} className="border border-gray-200 bg-white p-3 space-y-1.5" data-testid={`promise-${r.id}`}>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 ${st.cls}`}>{partly ? "Partly sent" : st.label}</span>
                  <span className="font-semibold text-sm">{r.lead_name || r.phone}</span>
                  <span className="font-mono text-xs text-gray-500">{r.phone}</span>
                  {r.company === "fragvansh" && <span className="text-[10px] uppercase font-bold text-purple-700">Fragvansh</span>}
                </div>
                <div className="text-[11px] text-gray-500">{r.exec_name} · call {fmtSmartLong(r.call_end_at)}</div>
              </div>
              <div className="text-sm">Promised: <b>“{r.what}”</b> on WhatsApp</div>
              {(r.ai_reason || r.ai_missing) && (
                <div className="text-xs text-gray-600">
                  {r.ai_reason}{r.ai_missing && !["kept", "kept_late"].includes(r.status) ? <span className="text-red-600"> Missing: {r.ai_missing}</span> : null}
                </div>
              )}
              {r.ai_evidence && ["kept", "kept_late"].includes(r.status) && <div className="text-xs text-green-700">Sent: “{r.ai_evidence}”</div>}
              <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
                <div className="text-[11px] text-gray-400">
                  {["kept", "kept_late"].includes(r.status) && r.kept_at && (
                    <span className={r.status === "kept_late" ? "text-lime-800 font-semibold" : ""}>
                      {r.resolved_by ? "Marked kept" : "Sent"} {fmtSmartLong(r.kept_at)}
                      {r.resolved_by ? ` by ${r.resolved_by}` : ""}
                      {r.status === "kept_late"
                        ? ` · ${fmtLate(r.late_minutes)} late (was due ${fmtSmartLong(r.due_at)})`
                        : (!r.resolved_by ? " · on time" : "")}
                    </span>
                  )}
                  {["open", "reminded"].includes(r.status) && r.due_at && <>Due {fmtSmartLong(r.due_at)}</>}
                  {r.status === "missed" && r.escalated_at && <>Admin alerted {fmtSmartLong(r.escalated_at)}</>}
                  {r.status === "no_window" && <>Customer hasn't messaged in 24 h - WhatsApp doesn't allow sending until they do</>}
                </div>
                <div className="flex gap-1">
                  <button type="button" onClick={() => openChat(r)} className="bg-[#128C7E] text-white text-[11px] font-bold px-2 py-1 flex items-center gap-1"><ChatCircleDots size={12} /> Open chat</button>
                  {!["kept", "kept_late", "dismissed"].includes(r.status) && (
                    <>
                      <button type="button" onClick={() => resolve(r.id, "kept")} className="border border-gray-300 text-[11px] font-bold px-2 py-1 flex items-center gap-1"><Check size={12} /> Mark kept</button>
                      {isAdmin && <button type="button" onClick={() => resolve(r.id, "dismissed")} className="border border-gray-300 text-[11px] px-2 py-1 flex items-center gap-1"><X size={12} /> Dismiss</button>}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
