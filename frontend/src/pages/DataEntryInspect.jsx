import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { MagnifyingGlass, ArrowsClockwise, Users, Kanban, Check } from "@phosphor-icons/react";

export default function DataEntryInspect() {
  const [stats, setStats] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const loadStats = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/data-entry-stats");
      setStats(data || []);
    } catch (e) {
      toast.error("Failed to load statistics: " + errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const filteredStats = stats.filter(
    (u) =>
      u.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.username?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totalLeadsUploaded = stats.reduce((acc, u) => acc + (u.leads_uploaded || 0), 0);

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Analytics</div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl text-gray-900">Data Entry Stats</h1>
          <p className="text-sm text-gray-500 mt-1">
            Monitor and inspect the quantity of leads uploaded by each Data Entry role user.
          </p>
        </div>
        <button
          onClick={loadStats}
          disabled={loading}
          className="border border-gray-300 hover:bg-gray-100 bg-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1.5 disabled:opacity-50"
        >
          <ArrowsClockwise size={12} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Summary Dashboard widgets */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-gray-200 bg-white p-5 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 bg-blue-50 text-[#002FA7] flex items-center justify-center rounded-full shrink-0">
            <Users size={24} />
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase font-semibold">Data Entry Staff</div>
            <div className="text-2xl font-black font-chivo text-gray-900 mt-0.5">{stats.length}</div>
          </div>
        </div>

        <div className="border border-gray-200 bg-white p-5 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 bg-green-50 text-green-700 flex items-center justify-center rounded-full shrink-0">
            <Kanban size={24} />
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase font-semibold">Total Leads Imported</div>
            <div className="text-2xl font-black font-chivo text-gray-900 mt-0.5">{totalLeadsUploaded}</div>
          </div>
        </div>
      </div>

      {/* Search Filter and List */}
      <div className="border border-gray-200 bg-white p-6 space-y-4 shadow-sm">
        <div className="relative">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name or username..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-gray-300 text-sm focus:outline-none focus:border-[#002FA7]"
          />
        </div>

        {/* Desktop View */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500 font-bold border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3">Staff Member</th>
                <th className="text-left px-4 py-3">Username</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-right px-4 py-3">Leads Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {filteredStats.map((u) => (
                <tr key={u.id} className="border-b border-gray-150 hover:bg-gray-50">
                  <td className="px-4 py-4 font-semibold text-gray-900">{u.name}</td>
                  <td className="px-4 py-4 font-mono text-xs text-gray-500">@{u.username}</td>
                  <td className="px-4 py-4">
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 border ${
                        u.active
                          ? "bg-green-50 text-green-700 border-green-200"
                          : "bg-red-50 text-red-700 border-red-200"
                      }`}
                    >
                      {u.active ? <Check size={10} /> : null}
                      {u.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right font-chivo font-bold text-gray-900">{u.leads_uploaded}</td>
                </tr>
              ))}
              {filteredStats.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center py-8 text-xs text-gray-400 uppercase tracking-widest">
                    No data entry staff found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile View */}
        <div className="md:hidden space-y-3">
          {filteredStats.map((u) => (
            <div key={u.id} className="border border-gray-200 bg-gray-50 p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-gray-900">{u.name}</div>
                  <div className="text-xs font-mono text-gray-500">@{u.username}</div>
                </div>
                <span
                  className={`inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 border ${
                    u.active
                      ? "bg-green-50 text-green-700 border-green-200"
                      : "bg-red-50 text-red-700 border-red-200"
                  }`}
                >
                  {u.active ? "Active" : "Inactive"}
                </span>
              </div>
              <div className="flex justify-between items-baseline pt-2 border-t border-gray-200">
                <span className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">Leads Uploaded</span>
                <span className="text-xl font-bold font-chivo text-gray-900">{u.leads_uploaded}</span>
              </div>
            </div>
          ))}
          {filteredStats.length === 0 && (
            <div className="text-center py-8 text-xs text-gray-400 uppercase tracking-widest">
              No data entry staff found
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
