import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LineChart, Line, PieChart, Pie, Cell, Legend,
} from "recharts";

const COLORS = ["#002FA7", "#008A00", "#FFCC00", "#E60000", "#0F172A"];

export default function Reports() {
  const [data, setData] = useState(null);
  useEffect(() => { (async () => { try { const r = await api.get("/reports/overview"); setData(r.data); } catch (e) { toast.error(errMsg(e)); } })(); }, []);
  if (!data) return <div className="p-8 text-xs uppercase tracking-widest text-gray-500">Loading…</div>;

  const byStatus = Object.entries(data.by_status || {}).map(([k, v]) => ({ name: k, value: v }));
  const bySource = Object.entries(data.by_source || {}).map(([k, v]) => ({ name: k, value: v }));

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Analytics</div>
        <h1 className="font-chivo font-black text-2xl md:text-4xl">Reports</h1>
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
        <div className="px-5 py-3 border-b border-gray-200 text-[10px] uppercase tracking-widest text-gray-500 font-bold">Detailed Executive Breakdown</div>
        {/* Mobile cards */}
        <div className="md:hidden divide-y divide-gray-200">
          {data.per_executive.map((e) => (
            <div key={e.id} className="p-4" data-testid={`exec-card-${e.username}`}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{e.name}</div>
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
              <tr key={e.id} className="border-t border-gray-200" data-testid={`exec-row-${e.username}`}>
                <td className="px-4 py-3 font-semibold">
                  {e.name} <span className="text-xs text-gray-500 font-mono">@{e.username}</span>
                </td>
                <td className="px-3 py-3 text-right font-mono">{e.leads}</td>
                <td className="px-3 py-3 text-right font-mono">{e.qualified}</td>
                <td className="px-3 py-3 text-right font-mono text-[#008A00]">{e.converted}</td>
                <td className="px-3 py-3 text-right font-mono text-[#E60000]">{e.lost}</td>
                <td className="px-3 py-3 text-right font-mono">{e.conversion_rate}</td>
                <td className="px-3 py-3 text-right font-mono border-l border-gray-200">{e.calls_total}</td>
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
