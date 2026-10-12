import React, { useEffect, useRef, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { Sparkle, ArrowsClockwise, Fire, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { fmtSmartLong } from "@/lib/format";
import { Link } from "react-router-dom";

/* AI Reports: daily / weekly / monthly. Admin sees every executive plus an
   AI-written summary of the period; executives see only their own numbers and
   coaching tips. Built from calls, AI call summaries, follow-ups, WhatsApp
   promises and team calls. */

const PERIODS = [["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]];
const CHECK_LABELS = { asked_quantity: "Asked qty", asked_purpose: "Asked purpose", explained_product: "Explained", asked_for_order: "Asked order" };

function istToday() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function shift(dateStr, period, dir) {
  const d = new Date(dateStr + "T00:00:00Z");
  if (period === "daily") d.setUTCDate(d.getUTCDate() + dir);
  else if (period === "weekly") d.setUTCDate(d.getUTCDate() + 7 * dir);
  else d.setUTCMonth(d.getUTCMonth() + dir);
  return d.toISOString().slice(0, 10);
}
const mins = (s) => `${Math.round((s || 0) / 60)}m`;
const pct = (v) => (v == null ? "—" : `${v}%`);

function Stat({ label, value, cls = "" }) {
  return (
    <div className="border border-gray-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{label}</div>
      <div className={`font-chivo font-black text-2xl mt-0.5 ${cls}`}>{value}</div>
    </div>
  );
}

export default function AiReports() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [period, setPeriod] = useState("daily");
  const [date, setDate] = useState(istToday());
  const [rep, setRep] = useState(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = async (refresh = false) => {
    const s = ++seq.current;
    setLoading(true);
    try {
      const { data } = await api.get("/ai-reports", { params: { period, date, refresh: refresh || undefined }, timeout: 120000 });
      if (s === seq.current) setRep(data);
    } catch (e) { if (s === seq.current) toast.error(errMsg(e)); }
    finally { if (s === seq.current) setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [period, date]);

  const d = rep?.data;
  const t = d?.totals || {};
  return (
    <div className="p-4 md:p-8 space-y-4" data-testid="ai-reports-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1">
            <Sparkle size={12} weight="fill" className="text-[#6D28D9]" /> AI Reports
          </div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">{rep?.label || "Report"}</h1>
          {!isAdmin && <p className="text-xs text-gray-500 mt-1">Your own calls, follow-ups, promises and coaching tips.</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex">
            {PERIODS.map(([k, l]) => (
              <button key={k} onClick={() => setPeriod(k)} data-testid={`ai-report-${k}`}
                className={`px-3 py-2 text-[10px] uppercase tracking-widest font-bold border ${period === k ? "bg-[#002FA7] text-white border-[#002FA7]" : "bg-white border-gray-300 text-gray-600"}`}>{l}</button>
            ))}
          </div>
          <button onClick={() => setDate(shift(date, period, -1))} className="border border-gray-300 bg-white p-2" title="Previous"><CaretLeft size={12} /></button>
          <input type="date" value={date} max={istToday()} onChange={(e) => e.target.value && setDate(e.target.value)} className="border border-gray-300 px-2 py-1.5 text-sm" />
          <button onClick={() => setDate(shift(date, period, 1))} disabled={date >= istToday()} className="border border-gray-300 bg-white p-2 disabled:opacity-40" title="Next"><CaretRight size={12} /></button>
          {isAdmin && (
            <button onClick={() => load(true)} disabled={loading} className="border border-gray-300 bg-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50" data-testid="ai-report-refresh">
              <ArrowsClockwise size={12} /> {loading ? "Building…" : "Refresh"}
            </button>
          )}
        </div>
      </div>

      {loading && !d && <div className="text-xs uppercase tracking-widest text-gray-400">Building the report…</div>}
      {d && (
        <>
          {isAdmin && rep.narrative && (
            <div className="border border-[#DDD6FE] bg-[#F5F3FF] p-4" data-testid="ai-report-narrative">
              <div className="text-[10px] uppercase tracking-widest font-bold text-[#6D28D9] flex items-center gap-1 mb-2"><Sparkle size={12} weight="fill" /> Summary</div>
              <div className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{rep.narrative}</div>
              {rep.generated_at && <div className="text-[10px] text-gray-400 mt-2">Generated {fmtSmartLong(rep.generated_at)}</div>}
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
            <Stat label="Calls" value={t.calls || 0} />
            <Stat label="Answered" value={t.connected || 0} />
            <Stat label="Talk time" value={mins(t.talk_seconds)} />
            <Stat label="Hot" value={t.hot || 0} cls="text-[#B00000]" />
            <Stat label="Follow-ups done" value={`${t.fu_done || 0}/${t.fu_due || 0}`} />
            <Stat label="Follow-ups missed" value={t.fu_missed || 0} cls={t.fu_missed ? "text-[#B00000]" : ""} />
            <Stat label="Promises kept" value={`${t.promises_kept || 0}/${t.promises || 0}`} />
            <Stat label="Promises missed" value={t.promises_missed || 0} cls={t.promises_missed ? "text-[#B00000]" : ""} />
          </div>

          <div className="border border-gray-200 bg-white overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                <tr>
                  <th className="text-left px-3 py-2">Executive</th>
                  <th className="text-right px-3 py-2">Calls</th>
                  <th className="text-right px-3 py-2">Answered</th>
                  <th className="text-right px-3 py-2">Talk</th>
                  <th className="text-right px-3 py-2">Hot / Warm / Cold</th>
                  <th className="text-right px-3 py-2">Follow-ups done / due / missed</th>
                  <th className="text-right px-3 py-2">Promises kept / made</th>
                  <th className="text-right px-3 py-2">Score</th>
                  <th className="text-left px-3 py-2">Checklist</th>
                </tr>
              </thead>
              <tbody>
                {d.executives.map((r) => (
                  <tr key={r.user_id} className="border-t border-gray-100 align-top">
                    <td className="px-3 py-2 font-semibold">{r.name}{r.team_calls ? <div className="text-[10px] text-gray-400 font-normal">{r.team_calls} team call(s)</div> : null}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.calls}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.connected}</td>
                    <td className="px-3 py-2 text-right font-mono">{mins(r.talk_seconds)}</td>
                    <td className="px-3 py-2 text-right font-mono"><span className="text-[#B00000]">{r.hot}</span> / {r.warm} / {r.cold}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.fu_done} / {r.fu_due} / <span className={r.fu_missed ? "text-[#B00000] font-bold" : ""}>{r.fu_missed}</span></td>
                    <td className="px-3 py-2 text-right font-mono">{r.promises_kept} / {r.promises}{r.promises_missed ? <span className="text-[#B00000] font-bold"> ({r.promises_missed} missed)</span> : null}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.avg_score ?? "—"}</td>
                    <td className="px-3 py-2 text-[11px] text-gray-600 whitespace-nowrap">
                      {Object.entries(r.check_pct || {}).map(([k, v]) => <div key={k}>{CHECK_LABELS[k]}: <b>{pct(v)}</b></div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="border border-gray-200 bg-white">
              <div className="px-4 py-2.5 border-b border-gray-200 text-[10px] uppercase tracking-widest font-bold text-gray-500 flex items-center gap-1"><Fire size={12} weight="fill" className="text-[#E60000]" /> Hot leads ({d.hot_leads.length})</div>
              <div className="divide-y divide-gray-100 max-h-[420px] overflow-y-auto">
                {d.hot_leads.length === 0 && <div className="p-4 text-xs text-gray-400">No hot calls in this period.</div>}
                {d.hot_leads.map((h, i) => (
                  <div key={i} className="px-4 py-2 text-xs">
                    <div className="flex justify-between gap-2">
                      {h.lead_id ? <Link to={`/leads/${h.lead_id}`} className="font-semibold text-[#002FA7]">{h.lead_name || "Lead"}</Link> : <span className="font-semibold">Lead</span>}
                      <span className="text-gray-400 font-mono">{h.exec} · {fmtSmartLong(h.at)}</span>
                    </div>
                    <div className="text-gray-700 mt-0.5">{h.summary}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <div className="border border-gray-200 bg-white">
                <div className="px-4 py-2.5 border-b border-gray-200 text-[10px] uppercase tracking-widest font-bold text-gray-500">Most asked-for products</div>
                <div className="p-4 flex flex-wrap gap-1.5">
                  {d.top_products.length === 0 && <span className="text-xs text-gray-400">Nothing yet.</span>}
                  {d.top_products.map(([p, n]) => <span key={p} className="border border-gray-300 px-2 py-1 text-xs capitalize">{p} <b>{n}</b></span>)}
                </div>
              </div>
              <div className="border border-gray-200 bg-white">
                <div className="px-4 py-2.5 border-b border-gray-200 text-[10px] uppercase tracking-widest font-bold text-gray-500">Coaching tips from the calls</div>
                <div className="p-4 space-y-2 text-xs">
                  {d.executives.filter((r) => r.tips?.length).length === 0 && <span className="text-gray-400">No coached calls yet.</span>}
                  {d.executives.filter((r) => r.tips?.length).map((r) => (
                    <div key={r.user_id}>
                      <div className="font-semibold">{r.name}</div>
                      <ul className="list-disc pl-5 text-gray-700">{r.tips.slice(0, 4).map((tip, i) => <li key={i}>{tip}</li>)}</ul>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
