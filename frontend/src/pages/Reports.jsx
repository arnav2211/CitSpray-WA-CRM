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
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
            <tr>
              <th className="text-left px-5 py-2">Executive</th>
              <th className="text-right px-5 py-2">Leads</th>
              <th className="text-right px-5 py-2">Converted</th>
              <th className="text-right px-5 py-2">Conversion %</th>
              <th className="text-right px-5 py-2">Avg Response (s)</th>
            </tr>
          </thead>
          <tbody>
            {data.per_executive.map((e) => (
              <tr key={e.id} className="border-t border-gray-200">
                <td className="px-5 py-3 font-semibold">{e.name} <span className="text-xs text-gray-500 font-mono">@{e.username}</span></td>
                <td className="px-5 py-3 text-right font-mono">{e.leads}</td>
                <td className="px-5 py-3 text-right font-mono text-[#008A00]">{e.converted}</td>
                <td className="px-5 py-3 text-right font-mono">{e.leads ? ((e.converted / e.leads) * 100).toFixed(1) : "0.0"}</td>
                <td className="px-5 py-3 text-right font-mono">{e.avg_response_seconds || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
