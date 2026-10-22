import React, { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Recycle, Phone, WhatsappLogo, ArrowSquareOut, CheckCircle, Copy } from "@phosphor-icons/react";

/* Win-back calls: a small daily list of your OWN old customers who stopped ordering,
   best prospects first. Call, then tap what happened - it comes back on the right day. */

const OUTCOMES = [
  { k: "ordered", label: "Ordered", cls: "bg-[#0A7A35] text-white border-[#0A7A35]" },
  { k: "interested", label: "Interested", cls: "bg-[#E7F6EC] text-[#0A7A35] border-[#0A7A35]/40", date: true },
  { k: "call_later", label: "Call later", cls: "bg-[#F0F4FF] text-[#002FA7] border-[#002FA7]/40", date: true },
  { k: "no_answer", label: "No answer", cls: "bg-gray-50 text-gray-700 border-gray-300" },
  { k: "not_interested", label: "Not interested", cls: "bg-[#FDECEC] text-[#B00000] border-[#B00000]/30" },
  { k: "wrong_number", label: "Wrong number", cls: "bg-[#FDECEC] text-[#B00000] border-[#B00000]/30" },
];
const LABEL = Object.fromEntries(OUTCOMES.map((o) => [o.k, o.label]).concat([["unreachable", "Unreachable (3 tries)"]]));
const inr = (n) => (n ? "₹" + Math.round(n).toLocaleString("en-IN") : "");
const fmtD = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "-");
function ago(d) {
  if (!d) return "";
  const days = Math.floor((Date.now() - new Date(d + "T00:00:00").getTime()) / 86400000);
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(days < 730 ? 1 : 0)} years ago`;
}

export default function WinBack() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [person, setPerson] = useState("");
  const [busy, setBusy] = useState(null);
  const [notes, setNotes] = useState({});

  const load = useCallback(async () => {
    try {
      const params = isAdmin && person ? { exec_id: person } : {};
      if (!isAdmin || person) {
        const { data } = await api.get("/winback/today", { params });
        setData(data);
      } else {
        setData(null);
      }
      if (isAdmin) {
        const { data: s } = await api.get("/winback/stats");
        setStats(s);
      }
    } catch (e) { toast.error(errMsg(e)); }
  }, [isAdmin, person]);
  useEffect(() => { load(); }, [load]);

  const record = async (l, o) => {
    if (o.k === "ordered" && !window.confirm(`Mark ${l.customer_name} as ORDERED? (Create the order in OMS as usual.)`)) return;
    setBusy(l.id + o.k);
    try {
      const { data: r } = await api.post(`/winback/${l.id}/outcome`, { outcome: o.k, note: notes[l.id] || "" });
      toast.success(`${LABEL[r.status] || r.status}${r.next ? ` - back in your list on ${fmtD(r.next)}` : ""}`);
      setNotes((m) => ({ ...m, [l.id]: "" }));
      load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(null); }
  };
  const saveSettings = async (patch) => {
    try { await api.put("/winback/settings", patch); toast.success("Saved"); load(); } catch (e) { toast.error(errMsg(e)); }
  };

  const items = data?.items || [];
  const done = items.filter((x) => x.done_today).length;
  return (
    <div className="p-4 md:p-8 space-y-4" data-testid="winback-page">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1.5"><Recycle size={12} weight="bold" /> Old customers</div>
        <h1 className="font-chivo font-black text-2xl md:text-4xl">Win-back calls</h1>
        <p className="text-xs text-gray-600 mt-1 max-w-3xl">
          Customers who bought from us before but have not ordered for a long time. Every working day you get a short list -
          best customers first. Call, remind them what they took last time, and tap what happened. When the call is recorded,
          the AI writes what the customer said and the next call date by itself (and marks the result if it is clear) -
          "No answer", "Call later" and "Interested" come back automatically on the right day.
        </p>
      </div>

      {isAdmin && stats && (
        <div className="border border-gray-200 bg-white" data-testid="winback-stats">
          <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center gap-3 justify-between">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Team progress</div>
            <div className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1"><input type="checkbox" checked={!!stats.settings.enabled} onChange={(e) => saveSettings({ enabled: e.target.checked })} /> On</label>
              <span>Calls per person per day</span>
              <select value={stats.settings.per_day} onChange={(e) => saveSettings({ per_day: Number(e.target.value) })} className="border border-gray-300 px-1 py-1" data-testid="winback-per-day">
                {[5, 10, 15, 20, 25, 30, 40, 50].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                <tr>
                  <th className="text-left px-4 py-2">Person</th><th className="text-right px-3 py-2">Today</th>
                  <th className="text-right px-3 py-2">Ordered</th><th className="text-right px-3 py-2">Interested</th>
                  <th className="text-right px-3 py-2">Call later</th><th className="text-right px-3 py-2">No answer</th>
                  <th className="text-right px-3 py-2">Not int.</th><th className="text-right px-3 py-2">Wrong no.</th>
                  <th className="text-right px-3 py-2">Came back*</th><th className="text-right px-4 py-2">Not called yet</th>
                </tr>
              </thead>
              <tbody>
                {stats.people.map((p) => (
                  <tr key={p.id} className={`border-t border-gray-200 cursor-pointer hover:bg-gray-50 ${person === p.id ? "bg-[#F0F4FF]" : ""}`} onClick={() => setPerson(p.id)}>
                    <td className="px-4 py-2 font-semibold underline-offset-2 hover:underline">{p.name}</td>
                    <td className="px-3 py-2 text-right font-mono">{p.done_today}/{p.today}</td>
                    <td className="px-3 py-2 text-right font-mono text-[#0A7A35] font-bold">{p.outcomes.ordered}</td>
                    <td className="px-3 py-2 text-right font-mono">{p.outcomes.interested}</td>
                    <td className="px-3 py-2 text-right font-mono">{p.outcomes.call_later}</td>
                    <td className="px-3 py-2 text-right font-mono">{p.outcomes.no_answer + p.outcomes.unreachable}</td>
                    <td className="px-3 py-2 text-right font-mono">{p.outcomes.not_interested}</td>
                    <td className="px-3 py-2 text-right font-mono">{p.outcomes.wrong_number}</td>
                    <td className="px-3 py-2 text-right font-mono text-[#0A7A35] font-bold">{p.came_back}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-500">{p.not_called_yet}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 text-[11px] text-gray-500 border-t border-gray-100">* Came back = placed an order in OMS after the win-back call. Click a person to see their list.</div>
        </div>
      )}

      {(!isAdmin || person) && (
        <>
          <div className="text-sm text-gray-700">
            Today: <b>{done}</b> of <b>{items.length}</b> called
            {isAdmin && person && <button type="button" className="ml-3 underline text-xs" onClick={() => setPerson("")}>back to team</button>}
          </div>
          {items.length === 0 && (
            <div className="border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
              {data?.settings?.enabled === false ? "Win-back calls are switched off." : "No old customers to call today - all done!"}
            </div>
          )}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {items.map((l) => (
              <div key={l.id} className={`border bg-white p-4 ${l.done_today ? "opacity-60 border-gray-200" : "border-gray-300"}`} data-testid={`winback-${l.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-chivo font-bold text-lg truncate">{l.customer_name}</div>
                    <div className="text-xs text-gray-500 font-mono">{l.phone}{l.phones?.length ? ` · ${l.phones.join(", ")}` : ""}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] uppercase tracking-widest font-bold text-[#B00000]">Last order {ago(l.last_order_at)}</div>
                    <div className="text-xs text-gray-600">{l.past_orders_count} order{l.past_orders_count === 1 ? "" : "s"}{l.past_orders_total ? ` · ${inr(l.past_orders_total)}` : ""}</div>
                  </div>
                </div>
                {l.winback_status && (
                  <div className="mt-1 text-[11px] text-[#002FA7]">
                    Last call: <b>{LABEL[l.winback_status] || l.winback_status}</b>
                    {l.winback_history?.length && l.winback_history[l.winback_history.length - 1].auto ? " (marked by AI from the call)" : ""}
                    {l.winback_next_at ? ` · next call ${fmtD(l.winback_next_at)}` : ""}
                  </div>
                )}
                {l.winback_ai?.summary && (
                  <div className="mt-2 text-xs border-l-4 border-[#7C3AED] bg-[#F5F3FF] p-2 text-gray-800" data-testid={`wb-ai-${l.id}`}>
                    <div className="text-[10px] uppercase tracking-widest text-[#7C3AED] font-bold mb-0.5">AI notes from the call</div>
                    {l.winback_ai.summary}
                    {!l.winback_status && <div className="text-[10px] text-gray-500 mt-1">The result was not clear from the call - please tap it below.</div>}
                  </div>
                )}
                {l.recent_orders?.length > 0 && (
                  <div className="mt-2 text-xs bg-gray-50 border border-gray-100 p-2 space-y-1">
                    {l.recent_orders.slice(0, 2).map((o, i) => (
                      <div key={i}>
                        <span className="font-semibold">{fmtD(o.date)}</span>{o.total ? <span className="text-gray-500"> · {inr(o.total)}</span> : null}
                        <div className="text-gray-600 truncate">{(o.items || []).filter((x) => !/^(total|grand|courier|shipping|gst|18%)/i.test(x.trim())).slice(0, 3).join(" · ")}</div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-xs border-l-4 border-[#002FA7] bg-[#F0F4FF] p-2 text-gray-800 relative">
                  <div className="text-[10px] uppercase tracking-widest text-[#002FA7] font-bold mb-0.5">Say this</div>
                  {l.opener}
                  <button type="button" title="Copy" className="absolute top-1 right-1 text-gray-400 hover:text-gray-900"
                    onClick={() => { navigator.clipboard?.writeText(l.opener); toast.success("Copied"); }}><Copy size={12} /></button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a href={`tel:${l.phone}`} className="flex items-center gap-1 bg-gray-900 text-white px-3 py-1.5 text-xs font-bold"><Phone size={14} /> Call</a>
                  <button type="button" onClick={() => nav(`/chat?lead=${l.id}`)} className="flex items-center gap-1 border border-[#25D366] text-[#128C4B] px-3 py-1.5 text-xs font-bold"><WhatsappLogo size={14} /> WhatsApp</button>
                  <button type="button" onClick={() => nav(`/leads?lead=${l.id}`)} className="flex items-center gap-1 border border-gray-300 px-3 py-1.5 text-xs"><ArrowSquareOut size={14} /> Open lead</button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input value={notes[l.id] || ""} onChange={(e) => setNotes((m) => ({ ...m, [l.id]: e.target.value }))}
                    placeholder="Extra note (optional - the AI writes the call notes and next date itself)" className="flex-1 min-w-[160px] border border-gray-300 px-2 py-1.5 text-xs" />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {OUTCOMES.map((o) => (
                    <button key={o.k} type="button" disabled={busy === l.id + o.k} onClick={() => record(l, o)}
                      className={`border px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider disabled:opacity-50 ${o.cls}`} data-testid={`wb-${o.k}-${l.id}`}>
                      {o.k === "ordered" && <CheckCircle size={12} className="inline mr-1" />}{o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
