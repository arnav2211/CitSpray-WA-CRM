import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthContext";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LineChart, Line, PieChart, Pie, Cell, Legend,
} from "recharts";
import { X, Phone, ArrowLeft, Check, Clock, Warning } from "@phosphor-icons/react";
import { fmtIST, fmtISTTime } from "@/lib/format";

const COLORS = ["#002FA7", "#008A00", "#FFCC00", "#E60000", "#0F172A"];

// Quick-range presets. Returns YYYY-MM-DD pairs in IST.
const istNow = () => {
  // Today's IST date (rendered as a plain YYYY-MM-DD string).
  const d = new Date();
  // toLocaleDateString in en-CA gives YYYY-MM-DD format.
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const istShift = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const istMonthRange = (year, month) => {
  // month: 1..12. End-of-month via day-0 of next month.
  const last = new Date(Date.UTC(year, month, 0));
  const lastDay = last.getUTCDate();
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  return { from: `${ym}-01`, to: `${ym}-${String(lastDay).padStart(2, "0")}` };
};

const OUTCOME_LABEL = {
  connected: "Connected",
  busy: "Busy",
  no_answer: "No Answer",
  rejected: "Rejected",
  switched_off: "Switched Off",
  not_reachable: "Not Reachable",
};
const OUTCOME_COLOR = {
  connected: "bg-green-100 text-green-800 border-green-200",
  busy: "bg-amber-100 text-amber-800 border-amber-200",
  no_answer: "bg-orange-100 text-orange-800 border-orange-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
  switched_off: "bg-gray-100 text-gray-600 border-gray-200",
  not_reachable: "bg-gray-100 text-gray-600 border-gray-200",
};

function formatGap(seconds) {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtTimeIST(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  } catch { return "—"; }
}

function fmtDateIST(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
  } catch { return ""; }
}

export default function Reports() {
  const { user } = useAuth();
  const isExec = user?.role === "executive";
  const today = useMemo(() => istNow(), []);
  const [mode, setMode] = useState("today");          // today | yesterday | month | custom
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [monthYear, setMonthYear] = useState(today.slice(0, 7));  // YYYY-MM
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  // Executive detail drill-down
  const [detailExec, setDetailExec] = useState(null); // { id, name, username }
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (isExec) {
        const r = await api.get(`/reports/executive-detail/${user?.id}`, {
          params: {
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
          },
        });
        setData(r.data);
      } else {
        const r = await api.get("/reports/overview", {
          params: {
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
          },
        });
        setData(r.data);
      }
    } catch (e) { toast.error(errMsg(e)); }
    finally { setLoading(false); }
  }, [dateFrom, dateTo, isExec, user?.id]);
  useEffect(() => { load(); }, [load]);

  const applyPreset = (m) => {
    setMode(m);
    if (m === "today") { setDateFrom(today); setDateTo(today); }
    else if (m === "yesterday") { const y = istShift(-1); setDateFrom(y); setDateTo(y); }
    else if (m === "month") {
      const [y, mm] = monthYear.split("-").map(Number);
      const { from, to } = istMonthRange(y, mm);
      setDateFrom(from); setDateTo(to);
    }
    // 'custom' lets the user edit the inputs directly
  };
  // Whenever month picker changes (when in 'month' mode), refresh the range
  useEffect(() => {
    if (mode !== "month") return;
    const [y, mm] = monthYear.split("-").map(Number);
    if (!y || !mm) return;
    const { from, to } = istMonthRange(y, mm);
    setDateFrom(from); setDateTo(to);
  }, [mode, monthYear]);

  // Load executive detail when an exec is selected
  const loadDetail = useCallback(async (exec) => {
    setDetailExec(exec);
    setDetailLoading(true);
    setDetailData(null);
    try {
      const { data: d } = await api.get(`/reports/executive-detail/${exec.id}`, {
        params: {
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        },
      });
      setDetailData(d);
    } catch (e) {
      toast.error("Failed to load executive detail: " + errMsg(e));
    } finally {
      setDetailLoading(false);
    }
  }, [dateFrom, dateTo]);

  if (!data && loading) return <div className="p-8 text-xs uppercase tracking-widest text-gray-500">Loading…</div>;
  if (!data) return null;

  if (isExec) {
    return (
      <div className="p-4 md:p-8 space-y-6">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Analytics</div>
            <h1 className="font-chivo font-black text-2xl md:text-4xl">My Reports</h1>
            <div className="text-xs font-mono text-gray-500">@{user?.username} · {user?.name}</div>
          </div>
          {/* Date filter */}
          <div className="flex flex-col gap-2" data-testid="reports-date-filter">
            <div className="flex items-center gap-1 flex-wrap">
              {[
                { k: "today", label: "Today" },
                { k: "yesterday", label: "Yesterday" },
                { k: "month", label: "Select month" },
                { k: "custom", label: "Custom" },
              ].map((opt) => (
                <button
                  key={opt.k}
                  onClick={() => applyPreset(opt.k)}
                  className={`px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold border ${mode === opt.k ? "bg-gray-900 text-white border-gray-900" : "bg-white border-gray-300 hover:border-gray-900"}`}
                  data-testid={`reports-preset-${opt.k}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {mode === "month" ? (
                <input
                  type="month" value={monthYear} onChange={(e) => setMonthYear(e.target.value)}
                  className="border border-gray-300 px-2 py-1.5 text-sm font-mono"
                  data-testid="reports-month-input"
                />
              ) : (
                <>
                  <input
                    type="date" value={dateFrom}
                    onChange={(e) => { setDateFrom(e.target.value); if (mode !== "custom") setMode("custom"); }}
                    max={dateTo || undefined}
                    className="border border-gray-300 px-2 py-1.5 text-sm font-mono"
                    data-testid="reports-date-from"
                  />
                  <span className="text-gray-400 text-xs">→</span>
                  <input
                    type="date" value={dateTo}
                    onChange={(e) => { setDateTo(e.target.value); if (mode !== "custom") setMode("custom"); }}
                    min={dateFrom || undefined}
                    className="border border-gray-300 px-2 py-1.5 text-sm font-mono"
                    data-testid="reports-date-to"
                  />
                </>
              )}
              {loading && <span className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">Loading…</span>}
            </div>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <SummaryCard label="Leads Assigned" value={data.leads_assigned} color="bg-blue-50 text-[#002FA7] border-blue-200" />
          <SummaryCard label="Conversions" value={data.conversions} color="bg-green-50 text-green-700 border-green-200" />
          <SummaryCard label="Conversion Rate" value={`${data.conversion_rate}%`} color="bg-amber-50 text-amber-700 border-amber-200" />
          <SummaryCard label="Unique Called" value={data.unique_numbers_called || 0} color="bg-purple-50 text-purple-700 border-purple-200" />
          <SummaryCard label="Total Calls" value={data.total_calls} color="bg-gray-50 text-gray-700 border-gray-200" />
        </div>

        {/* Lead Status & Activity breakdown grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border border-gray-200 bg-white p-5">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4">Leads by Status</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat label="New" value={data.leads_by_status?.new} />
              <Stat label="Contacted" value={data.leads_by_status?.contacted} />
              <Stat label="Qualified" value={data.leads_by_status?.qualified} />
              <Stat label="Converted" value={data.leads_by_status?.converted} accent="text-green-700 font-bold" />
              <Stat label="Lost" value={data.leads_by_status?.lost} accent="text-red-600" />
            </div>
          </div>
          <div className="border border-gray-200 bg-white p-5">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4">Activity Metrics</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat label="Leads Worked" value={data.leads_worked} />
              <Stat label="Work Rate" value={data.leads_assigned > 0 ? `${Math.round((data.leads_worked / data.leads_assigned) * 100)}%` : "—"} />
              <Stat label="WhatsApp Messages" value={data.wa_messages_sent} />
              <Stat label="F/U Completion %" value={`${data.followup_completion_pct}%`} />
              <Stat label="F/U Pending" value={data.followup_pending} />
              <Stat label="Talk Time" value={formatGap(data.total_talk_time_seconds)} />
            </div>
          </div>
        </div>

        {/* Call Outcomes */}
        <div className="border border-gray-200 bg-white p-5">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4">Call Outcomes</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 text-xs">
            <Stat label="Connected" value={data.calls_by_outcome?.connected} accent="text-[#008A00] font-bold" />
            <Stat label="No Response" value={data.calls_by_outcome?.no_response} accent="text-[#FF8800]" />
            <Stat label="Rejected" value={data.calls_by_outcome?.rejected} accent="text-[#E60000]" />
            <Stat label="Not Reachable" value={data.calls_by_outcome?.not_reachable} />
            <Stat label="Busy" value={data.calls_by_outcome?.busy} />
            <Stat label="Invalid" value={data.calls_by_outcome?.invalid} />
          </div>
        </div>

        {/* Call Log Timeline */}
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-3">
            Call Log Timeline ({data.total_calls} calls)
          </div>
          {data.call_log.length === 0 ? (
            <div className="border border-gray-200 bg-gray-50 p-6 text-center text-xs uppercase tracking-widest text-gray-400">
              No calls logged in this period
            </div>
          ) : (
            <div className="space-y-0">
              {data.call_log.map((call, idx) => (
                <CallTimelineRow key={call.id || idx} call={call} isFirst={idx === 0} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const byStatus = Object.entries(data.by_status || {}).map(([k, v]) => ({ name: k, value: v }));
  const bySource = Object.entries(data.by_source || {}).map(([k, v]) => ({ name: k, value: v }));

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Analytics</div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Reports</h1>
        </div>
        {/* Date filter */}
        <div className="flex flex-col gap-2" data-testid="reports-date-filter">
          <div className="flex items-center gap-1 flex-wrap">
            {[
              { k: "today", label: "Today" },
              { k: "yesterday", label: "Yesterday" },
              { k: "month", label: "Select month" },
              { k: "custom", label: "Custom" },
            ].map((opt) => (
              <button
                key={opt.k}
                onClick={() => applyPreset(opt.k)}
                className={`px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold border ${mode === opt.k ? "bg-gray-900 text-white border-gray-900" : "bg-white border-gray-300 hover:border-gray-900"}`}
                data-testid={`reports-preset-${opt.k}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {mode === "month" ? (
              <input
                type="month" value={monthYear} onChange={(e) => setMonthYear(e.target.value)}
                className="border border-gray-300 px-2 py-1.5 text-sm font-mono"
                data-testid="reports-month-input"
              />
            ) : (
              <>
                <input
                  type="date" value={dateFrom}
                  onChange={(e) => { setDateFrom(e.target.value); if (mode !== "custom") setMode("custom"); }}
                  max={dateTo || undefined}
                  className="border border-gray-300 px-2 py-1.5 text-sm font-mono"
                  data-testid="reports-date-from"
                />
                <span className="text-gray-400 text-xs">→</span>
                <input
                  type="date" value={dateTo}
                  onChange={(e) => { setDateTo(e.target.value); if (mode !== "custom") setMode("custom"); }}
                  min={dateFrom || undefined}
                  className="border border-gray-300 px-2 py-1.5 text-sm font-mono"
                  data-testid="reports-date-to"
                />
              </>
            )}
            {loading && <span className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">Loading…</span>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="border border-gray-200 bg-white p-5 lg:col-span-2">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4">Leads Per Day — 14 days</div>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={data.leads_timeseries}>
              <CartesianGrid stroke="#F3F4F6" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d) => d.slice(5)} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ border: "1px solid #E5E7EB", borderRadius: 0, fontSize: 12 }} />
              <Line type="linear" dataKey="count" stroke="#002FA7" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="border border-gray-200 bg-white p-5">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4">By Source</div>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={bySource} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                {bySource.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border border-gray-200 bg-white p-5">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4">By Status</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={byStatus}>
              <CartesianGrid stroke="#F3F4F6" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ border: "1px solid #E5E7EB", borderRadius: 0, fontSize: 12 }} />
              <Bar dataKey="value" fill="#002FA7" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="border border-gray-200 bg-white p-5">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4">Executive Performance</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.per_executive} layout="vertical">
              <CartesianGrid stroke="#F3F4F6" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={110} />
              <Tooltip contentStyle={{ border: "1px solid #E5E7EB", borderRadius: 0, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="leads" fill="#002FA7" />
              <Bar dataKey="converted" fill="#008A00" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="border border-gray-200 bg-white">
        <div className="px-5 py-3 border-b border-gray-200 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
          Detailed Executive Breakdown
          <span className="ml-2 normal-case tracking-normal text-gray-400 font-normal">(tap name for call report)</span>
        </div>
        {/* Mobile cards */}
        <div className="md:hidden divide-y divide-gray-200">
          {data.per_executive.map((e) => (
            <div key={e.id} className="p-4" data-testid={`exec-card-${e.username}`}>
              <div className="flex items-center justify-between">
                <div>
                  <button
                    onClick={() => loadDetail(e)}
                    className="font-semibold text-[#002FA7] hover:underline text-left"
                  >
                    {e.name}
                  </button>
                  <div className="text-xs text-gray-500 font-mono">@{e.username}</div>
                </div>
                <div className={`text-[10px] uppercase tracking-widest font-bold ${e.active ? "text-[#008A00]" : "text-[#E60000]"}`}>
                  {e.active ? "Active" : "Inactive"}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                <Stat label="Leads" value={e.leads} />
                <Stat label="Converted" value={e.converted} accent="text-[#008A00]" />
                <Stat label="Calls total" value={e.calls_total} />
                <Stat label="Unique numbers" value={e.calls_unique_numbers || 0} />
                <Stat label="Connected" value={e.calls_connected} accent="text-[#008A00]" />
                <Stat label="No response" value={e.calls_no_response} accent="text-[#FF8800]" />
                <Stat label="WA messages" value={e.wa_messages_sent} />
                <Stat label="Conversion %" value={e.conversion_rate} accent="text-[#002FA7]" />
                <Stat label="F/U done %" value={e.followup_completion_pct} />
              </div>
            </div>
          ))}
        </div>
        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
            <tr>
              <th className="text-left px-4 py-2">Executive</th>
              <th className="text-right px-3 py-2" title="Total leads assigned">Leads</th>
              <th className="text-right px-3 py-2" title="Qualified">Q</th>
              <th className="text-right px-3 py-2 text-[#008A00]" title="Converted">Conv</th>
              <th className="text-right px-3 py-2 text-[#E60000]" title="Lost">Lost</th>
              <th className="text-right px-3 py-2">Conv %</th>
              <th className="text-right px-3 py-2 border-l border-gray-200" title="Total calls attempted">Calls</th>
              <th className="text-right px-3 py-2" title="Unique numbers called">Unique</th>
              <th className="text-right px-3 py-2 text-[#008A00]" title="Connected">Conn</th>
              <th className="text-right px-3 py-2 text-[#FF8800]" title="No Response (PNR)">PNR</th>
              <th className="text-right px-3 py-2" title="Not Reachable">N/R</th>
              <th className="text-right px-3 py-2 text-[#E60000]" title="Rejected">Rej</th>
              <th className="text-right px-3 py-2" title="Busy">Busy</th>
              <th className="text-right px-3 py-2 border-l border-gray-200" title="WhatsApp threads">WA</th>
              <th className="text-right px-3 py-2" title="WA messages sent">Msgs</th>
              <th className="text-right px-3 py-2 border-l border-gray-200" title="Follow-up completion %">F/U %</th>
              <th className="text-right px-3 py-2" title="Avg response (seconds)">Resp s</th>
            </tr>
          </thead>
          <tbody>
            {data.per_executive.map((e) => (
              <tr key={e.id} className="border-t border-gray-200 hover:bg-gray-50 cursor-pointer" data-testid={`exec-row-${e.username}`} onClick={() => loadDetail(e)}>
                <td className="px-4 py-3 font-semibold text-[#002FA7] hover:underline">
                  {e.name} <span className="text-xs text-gray-500 font-mono">@{e.username}</span>
                </td>
                <td className="px-3 py-3 text-right font-mono">{e.leads}</td>
                <td className="px-3 py-3 text-right font-mono">{e.qualified}</td>
                <td className="px-3 py-3 text-right font-mono text-[#008A00]">{e.converted}</td>
                <td className="px-3 py-3 text-right font-mono text-[#E60000]">{e.lost}</td>
                <td className="px-3 py-3 text-right font-mono">{e.conversion_rate}</td>
                <td className="px-3 py-3 text-right font-mono border-l border-gray-200">{e.calls_total}</td>
                <td className="px-3 py-3 text-right font-mono">{e.calls_unique_numbers || 0}</td>
                <td className="px-3 py-3 text-right font-mono text-[#008A00]">{e.calls_connected}</td>
                <td className="px-3 py-3 text-right font-mono text-[#FF8800]">{e.calls_no_response}</td>
                <td className="px-3 py-3 text-right font-mono">{e.calls_not_reachable}</td>
                <td className="px-3 py-3 text-right font-mono text-[#E60000]">{e.calls_rejected}</td>
                <td className="px-3 py-3 text-right font-mono">{e.calls_busy}</td>
                <td className="px-3 py-3 text-right font-mono border-l border-gray-200">{e.wa_threads}</td>
                <td className="px-3 py-3 text-right font-mono">{e.wa_messages_sent}</td>
                <td className="px-3 py-3 text-right font-mono border-l border-gray-200">{e.followup_completion_pct}</td>
                <td className="px-3 py-3 text-right font-mono">{e.avg_response_seconds || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {/* Executive Detail Drawer / Modal */}
      {detailExec && (
        <ExecDetailPanel
          exec={detailExec}
          data={detailData}
          loading={detailLoading}
          onClose={() => { setDetailExec(null); setDetailData(null); }}
        />
      )}
    </div>
  );
}

// ---------- Executive Detail Drill-down Panel ----------
function ExecDetailPanel({ exec, data, loading, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end" data-testid="exec-detail-overlay">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* Panel */}
      <div className="relative w-full md:w-[600px] lg:w-[700px] h-full bg-white shadow-xl overflow-y-auto animate-fadeIn">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-5 py-4 flex items-center justify-between z-10">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Executive Report</div>
            <h2 className="font-chivo font-bold text-xl text-gray-900">{exec.name}</h2>
            <div className="text-xs font-mono text-gray-500">@{exec.username}</div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 border border-gray-200"
            data-testid="close-exec-detail"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-xs uppercase tracking-widest text-gray-400">Loading executive report…</div>
        ) : !data ? (
          <div className="p-8 text-center text-xs uppercase tracking-widest text-gray-400">No data available</div>
        ) : (
          <div className="p-5 space-y-6">
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <SummaryCard label="Leads Assigned" value={data.leads_assigned} color="bg-blue-50 text-[#002FA7] border-blue-200" />
              <SummaryCard label="Leads Worked" value={data.leads_worked} color="bg-green-50 text-green-700 border-green-200" />
              <SummaryCard label="Work Rate" value={data.leads_assigned > 0 ? `${Math.round((data.leads_worked / data.leads_assigned) * 100)}%` : "—"} color="bg-amber-50 text-amber-700 border-amber-200" />
              <SummaryCard label="Unique Called" value={data.unique_numbers_called || 0} color="bg-purple-50 text-purple-700 border-purple-200" />
              <SummaryCard label="Total Calls" value={data.total_calls} color="bg-gray-50 text-gray-700 border-gray-200" />
            </div>

            {/* Call Log Timeline */}
            <div>
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-3">
                Call Log Timeline ({data.total_calls} calls)
              </div>
              {data.call_log.length === 0 ? (
                <div className="border border-gray-200 bg-gray-50 p-6 text-center text-xs uppercase tracking-widest text-gray-400">
                  No calls logged in this period
                </div>
              ) : (
                <div className="space-y-0">
                  {data.call_log.map((call, idx) => (
                    <CallTimelineRow key={call.id || idx} call={call} isFirst={idx === 0} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color }) {
  return (
    <div className={`border p-4 text-center ${color}`}>
      <div className="text-[10px] uppercase tracking-widest font-bold opacity-70">{label}</div>
      <div className="text-2xl font-chivo font-black mt-1">{value}</div>
    </div>
  );
}

function CallTimelineRow({ call, isFirst }) {
  const outcomeClass = OUTCOME_COLOR[call.outcome] || "bg-gray-100 text-gray-600 border-gray-200";
  const outcomeLabel = OUTCOME_LABEL[call.outcome] || call.outcome;

  return (
    <div className="flex gap-3">
      {/* Timeline connector */}
      <div className="flex flex-col items-center w-5 shrink-0">
        <div className={`w-3 h-3 rounded-full border-2 ${call.outcome === "connected" ? "border-green-500 bg-green-100" : "border-gray-300 bg-white"}`} />
        <div className="flex-1 w-px bg-gray-200" />
      </div>

      {/* Content */}
      <div className="flex-1 pb-4 min-w-0">
        {/* Gap indicator */}
        {!isFirst && call.gap_seconds != null && (
          <div className="flex items-center gap-1 mb-1.5">
            <Clock size={10} className="text-gray-400" />
            <span className={`text-[10px] font-mono font-bold uppercase tracking-widest ${
              call.gap_seconds > 1800 ? "text-red-500" : call.gap_seconds > 600 ? "text-amber-500" : "text-gray-400"
            }`}>
              {formatGap(call.gap_seconds)} gap
            </span>
          </div>
        )}

        <div className="border border-gray-200 bg-white hover:bg-gray-50 transition-colors p-3">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <div className="font-semibold text-sm text-gray-900 truncate">{call.customer_name}</div>
              {call.customer_phone && (
                <div className="text-[11px] text-gray-500 font-mono flex items-center gap-1 mt-0.5">
                  <Phone size={10} weight="bold" /> {call.customer_phone}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`text-[9px] uppercase tracking-widest font-bold px-2 py-0.5 border ${outcomeClass}`}>
                {outcomeLabel}
              </span>
              <span className="text-[10px] text-gray-500 font-mono whitespace-nowrap">
                {fmtTimeIST(call.at)}
              </span>
            </div>
          </div>
          {call.summary && (
            <div className="mt-2 text-xs text-gray-600 bg-gray-50 border border-gray-100 px-2.5 py-2 italic">
              "{call.summary}"
            </div>
          )}
          <div className="mt-1 text-[9px] text-gray-400 font-mono">{fmtDateIST(call.at)}</div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{label}</div>
      <div className={`font-mono text-base ${accent || ""}`}>{value ?? 0}</div>
    </div>
  );
}
