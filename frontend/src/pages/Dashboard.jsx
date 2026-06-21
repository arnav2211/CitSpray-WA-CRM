import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { Link } from "react-router-dom";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, LineChart, Line,
} from "recharts";
import { ArrowRight, Lightning, Warning, CheckCircle, Clock } from "@phosphor-icons/react";
import { toast } from "sonner";
import { fmtISTTime } from "@/lib/format";

function Stat({ label, value, accent, testId }) {
  return (
    <div className="border border-gray-200 bg-white p-5" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{label}</div>
      <div className={`font-chivo font-black text-4xl mt-2 ${accent || "text-gray-900"}`}>{value}</div>
    </div>
  );
}

function formatDuration(sec) {
  if (!sec) return "0s";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m ${s}s`;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [my, setMy] = useState(null);
  const [recent, setRecent] = useState([]);
  
  // Daily calling reports state
  const [dailyCalls, setDailyCalls] = useState(null);
  const [dailyDate, setDailyDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
  const [selectedExecId, setSelectedExecId] = useState("");

  const isAdmin = user.role === "admin";

  useEffect(() => {
    (async () => {
      try {
        if (isAdmin) {
          const { data: d } = await api.get("/reports/overview");
          setData(d);
        } else {
          const { data: d } = await api.get("/reports/my");
          setMy(d);
        }
        const { data: leads } = await api.get("/leads", { params: { limit: 10 } });
        setRecent(leads);
      } catch (e) { toast.error(errMsg(e)); }
    })();
  }, [user.role, isAdmin]);

  useEffect(() => {
    if (user.role === "data_entry") return;
    (async () => {
      try {
        const params = { date: dailyDate };
        if (isAdmin && selectedExecId) {
          params.user_id = selectedExecId;
        }
        const { data: res } = await api.get("/reports/daily-calls", { params });
        setDailyCalls(res);
      } catch (e) {
        toast.error("Failed to load daily calls: " + errMsg(e));
      }
    })();
  }, [dailyDate, selectedExecId, isAdmin, user.role]);

  const byStatusData = data ? Object.entries(data.by_status || {}).map(([k, v]) => ({ name: k, value: v })) : [];
  const bySourceData = data ? Object.entries(data.by_source || {}).map(([k, v]) => ({ name: k, value: v })) : [];

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
            {isAdmin ? "Control Room" : "Your Workspace"}
          </div>
          <h1 className="font-chivo font-black text-3xl md:text-4xl mt-1">
            {isAdmin ? "Pipeline Overview" : `Welcome, ${user.name.split(" ")[0]}`}
          </h1>
        </div>
        <Link to="/leads" className="text-xs uppercase tracking-widest font-bold text-[#002FA7] hover:underline flex items-center gap-1" data-testid="view-leads-link">
          View all leads <ArrowRight size={12} />
        </Link>
      </div>

      {isAdmin && data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Total Leads" value={data.total_leads} testId="stat-total" />
            <Stat label="Conversion Rate" value={`${data.conversion_rate}%`} accent="text-[#008A00]" testId="stat-conversion" />
            <Stat label="Reassigned" value={data.reassigned_leads} accent="text-[#002FA7]" testId="stat-reassigned" />
            <Stat label="Missed Follow-ups" value={data.missed_followups} accent="text-[#E60000]" testId="stat-missed" />
          </div>

          {/* Daily Call Activity Widget */}
          <div className="border border-gray-200 bg-white p-5 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-gray-100">
              <div>
                <h2 className="font-chivo font-black text-xl text-gray-900">Daily Call Activity</h2>
                <p className="text-xs text-gray-500">Track dialing metrics, talked calls, and total duration</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={selectedExecId}
                  onChange={(e) => setSelectedExecId(e.target.value)}
                  className="border border-gray-300 px-3 py-1.5 text-xs font-semibold focus:outline-none focus:border-gray-900 bg-white"
                >
                  <option value="">All Executives</option>
                  {data.per_executive.map(e => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
                <input
                  type="date"
                  value={dailyDate}
                  onChange={(e) => setDailyDate(e.target.value)}
                  className="border border-gray-300 px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-gray-900"
                />
              </div>
            </div>

            {dailyCalls ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-gray-50 p-4 border border-gray-150">
                    <div className="text-[9px] uppercase tracking-widest text-gray-500 font-bold">Call Attempts</div>
                    <div className="font-chivo font-black text-2xl mt-1 text-gray-900">{dailyCalls.total_calls}</div>
                  </div>
                  <div className="bg-gray-50 p-4 border border-gray-150">
                    <div className="text-[9px] uppercase tracking-widest text-gray-500 font-bold">Connected/Talked Calls</div>
                    <div className="font-chivo font-black text-2xl mt-1 text-[#008A00]">{dailyCalls.talked_calls}</div>
                  </div>
                  <div className="bg-gray-50 p-4 border border-gray-150">
                    <div className="text-[9px] uppercase tracking-widest text-gray-500 font-bold">Total Talk Time</div>
                    <div className="font-chivo font-black text-2xl mt-1 text-[#002FA7]">
                      {formatDuration(dailyCalls.total_talk_time_seconds)}
                    </div>
                  </div>
                </div>

                {!selectedExecId && dailyCalls.per_executive && dailyCalls.per_executive.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-gray-100">
                    <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2">Executive Breakdown</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-gray-50 text-[9px] uppercase tracking-widest text-gray-500 font-bold border-b border-gray-200">
                            <th className="text-left px-3 py-2">Executive Name</th>
                            <th className="text-right px-3 py-2">Attempts</th>
                            <th className="text-right px-3 py-2">Connected</th>
                            <th className="text-right px-3 py-2">Talk Time</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-150">
                          {dailyCalls.per_executive.map(e => (
                            <tr key={e.user_id} className="hover:bg-gray-50">
                              <td className="px-3 py-2 font-semibold text-gray-800">{e.user_name}</td>
                              <td className="px-3 py-2 text-right font-mono">{e.total_calls}</td>
                              <td className="px-3 py-2 text-right font-mono text-[#008A00]">{e.talked_calls}</td>
                              <td className="px-3 py-2 text-right font-mono text-[#002FA7]">
                                {formatDuration(e.total_talk_time_seconds)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-6 text-xs text-gray-400 uppercase tracking-widest">Loading metrics…</div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="border border-gray-200 bg-white p-5 lg:col-span-2">
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4">Leads — Last 14 days</div>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={data.leads_timeseries}>
                  <CartesianGrid stroke="#F3F4F6" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d) => d.slice(5)} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ border: "1px solid #E5E7EB", borderRadius: 0, fontSize: 12 }} />
                  <Line type="linear" dataKey="count" stroke="#002FA7" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="border border-gray-200 bg-white p-5">
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-4">By Status</div>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byStatusData}>
                  <CartesianGrid stroke="#F3F4F6" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ border: "1px solid #E5E7EB", borderRadius: 0, fontSize: 12 }} />
                  <Bar dataKey="value" fill="#002FA7" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="border border-gray-200 bg-white lg:col-span-2">
              <div className="px-5 py-3 border-b border-gray-200 flex items-baseline justify-between">
                <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Per Executive</div>
                <div className="text-[10px] uppercase tracking-widest text-gray-400">Leads · Converted · Avg Response</div>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                  <tr>
                    <th className="text-left px-5 py-2">Name</th>
                    <th className="text-right px-5 py-2">Leads</th>
                    <th className="text-right px-5 py-2">Converted</th>
                    <th className="text-right px-5 py-2 hidden md:table-cell">Avg Resp (s)</th>
                    <th className="text-left px-5 py-2 hidden md:table-cell">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.per_executive.map((e) => (
                    <tr key={e.id} className="border-t border-gray-200 hover:bg-gray-50" data-testid={`exec-row-${e.username}`}>
                      <td className="px-5 py-3">
                        <div className="font-semibold">{e.name}</div>
                        <div className="text-xs text-gray-500">@{e.username}</div>
                      </td>
                      <td className="px-5 py-3 text-right font-mono">{e.leads}</td>
                      <td className="px-5 py-3 text-right font-mono text-[#008A00]">{e.converted}</td>
                      <td className="px-5 py-3 text-right font-mono hidden md:table-cell">{e.avg_response_seconds || "—"}</td>
                      <td className="px-5 py-3 hidden md:table-cell">
                        <span className={`text-[10px] uppercase tracking-widest font-bold ${e.active ? "text-[#008A00]" : "text-[#E60000]"}`}>
                          {e.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {data.per_executive.length === 0 && (
                    <tr><td colSpan={5} className="px-5 py-6 text-center text-gray-500 text-xs uppercase tracking-widest">No executives yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="border border-gray-200 bg-white">
              <div className="px-5 py-3 border-b border-gray-200 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                Recent Leads
              </div>
              <div className="divide-y divide-gray-200">
                {recent.slice(0, 8).map((l) => (
                  <Link key={l.id} to={`/leads/${l.id}`} className="block px-5 py-3 hover:bg-gray-50" data-testid={`recent-lead-${l.id}`}>
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-sm truncate">{l.customer_name}</div>
                      <span className="text-[10px] font-mono text-gray-400">{fmtISTTime(l.created_at)}</span>
                    </div>
                    <div className="text-xs text-gray-500 truncate">{l.requirement || "—"}</div>
                  </Link>
                ))}
                {recent.length === 0 && <div className="px-5 py-6 text-center text-gray-500 text-xs uppercase tracking-widest">Empty</div>}
              </div>
            </div>
          </div>
        </>
      )}

      {!isAdmin && my && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="My Leads" value={my.total_leads} testId="stat-my-total" />
            <Stat label="New" value={my.new_leads} accent="text-[#002FA7]" testId="stat-my-new" />
            <Stat label="Converted" value={my.converted} accent="text-[#008A00]" testId="stat-my-converted" />
            <Stat label="Overdue" value={my.overdue_followups} accent="text-[#E60000]" testId="stat-my-overdue" />
          </div>

          {/* Daily Call Activity Widget */}
          <div className="border border-gray-200 bg-white p-5 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-gray-100">
              <div>
                <h2 className="font-chivo font-black text-xl text-gray-900">Daily Call Activity</h2>
                <p className="text-xs text-gray-500">Track dialing metrics, talked calls, and total duration</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={dailyDate}
                  onChange={(e) => setDailyDate(e.target.value)}
                  className="border border-gray-300 px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-gray-900"
                />
              </div>
            </div>

            {dailyCalls ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-gray-50 p-4 border border-gray-150">
                  <div className="text-[9px] uppercase tracking-widest text-gray-500 font-bold">Call Attempts</div>
                  <div className="font-chivo font-black text-2xl mt-1 text-gray-900">{dailyCalls.total_calls}</div>
                </div>
                <div className="bg-gray-50 p-4 border border-gray-150">
                  <div className="text-[9px] uppercase tracking-widest text-gray-500 font-bold">Connected/Talked Calls</div>
                  <div className="font-chivo font-black text-2xl mt-1 text-[#008A00]">{dailyCalls.talked_calls}</div>
                </div>
                <div className="bg-gray-50 p-4 border border-gray-150">
                  <div className="text-[9px] uppercase tracking-widest text-gray-500 font-bold">Total Talk Time</div>
                  <div className="font-chivo font-black text-2xl mt-1 text-[#002FA7]">
                    {formatDuration(dailyCalls.total_talk_time_seconds)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-xs text-gray-400 uppercase tracking-widest">Loading metrics…</div>
            )}
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <ActionCard icon={Lightning} title="Act on your newest lead" to="/leads?status=new" />
            <ActionCard icon={Clock} title="Today's follow-ups" to="/followups" />
          </div>

          <div className="border border-gray-200 bg-white">
            <div className="px-5 py-3 border-b border-gray-200 text-[10px] uppercase tracking-widest text-gray-500 font-bold">Recent Leads</div>
            <div className="divide-y divide-gray-200">
              {recent.map((l) => (
                <Link key={l.id} to={`/leads/${l.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-gray-50" data-testid={`my-recent-${l.id}`}>
                  <div className="min-w-0">
                    <div className="font-semibold text-sm truncate">{l.customer_name}</div>
                    <div className="text-xs text-gray-500 truncate">{l.requirement || "—"}</div>
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{l.status}</span>
                </Link>
              ))}
              {recent.length === 0 && <div className="px-5 py-6 text-center text-gray-500 text-xs uppercase tracking-widest">No leads yet</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ActionCard({ icon: Icon, title, to }) {
  return (
    <Link to={to} className="border border-gray-200 bg-white p-5 flex items-center justify-between hover:border-gray-900 transition-colors">
      <div className="flex items-center gap-3">
        <Icon size={22} weight="regular" />
        <div className="font-chivo font-bold">{title}</div>
      </div>
      <ArrowRight size={16} />
    </Link>
  );
}
