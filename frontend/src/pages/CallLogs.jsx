import React, { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { 
  Phone, 
  PhoneCall, 
  CalendarBlank, 
  User, 
  Funnel, 
  ArrowClockwise,
  PhoneDisconnect,
  XCircle,
  ChatTeardropText
} from "@phosphor-icons/react";
import { toast } from "sonner";

const OUTCOME_LABELS = {
  connected: "Connected",
  no_response: "No Response (PNR)",
  rejected: "Rejected",
  not_reachable: "Not Reachable",
  busy: "Busy",
  invalid: "Invalid Number",
  initiated: "Dialing/Started"
};

const OUTCOME_COLOR = {
  connected: "bg-emerald-100 text-emerald-800 border-emerald-200",
  no_response: "bg-red-100 text-red-800 border-red-200",
  rejected: "bg-rose-100 text-rose-800 border-rose-200",
  not_reachable: "bg-amber-100 text-amber-800 border-amber-200",
  busy: "bg-orange-100 text-orange-800 border-orange-200",
  invalid: "bg-gray-100 text-gray-800 border-gray-200",
  initiated: "bg-blue-100 text-blue-800 border-blue-200"
};

export default function CallLogs() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  
  const [logs, setLogs] = useState([]);
  const [executives, setExecutives] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Filters
  const [dateRange, setDateRange] = useState("today"); // today, yesterday, month, custom
  const [selectedMonth, setSelectedMonth] = useState(""); // YYYY-MM
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedOutcome, setSelectedOutcome] = useState("all");
  const [selectedExec, setSelectedExec] = useState("all");
  
  // Load active executives (only for admins)
  useEffect(() => {
    if (isAdmin) {
      api.get("/users")
        .then(res => {
          const execList = (res.data || []).filter(u => u.role === "executive");
          setExecutives(execList);
        })
        .catch(err => {
          console.error("Failed to load executives", err);
        });
    }
  }, [isAdmin]);
  
  // Build query and load call logs
  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      
      // 1. Date Range
      if (dateRange === "today") {
        const todayStr = new Date().toISOString().split("T")[0];
        params.start = todayStr + "T00:00:00.000Z";
        params.end = todayStr + "T23:59:59.999Z";
      } else if (dateRange === "yesterday") {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yestStr = yesterday.toISOString().split("T")[0];
        params.start = yestStr + "T00:00:00.000Z";
        params.end = yestStr + "T23:59:59.999Z";
      } else if (dateRange === "month" && selectedMonth) {
        params.start = `${selectedMonth}-01T00:00:00.000Z`;
        // Find last day of month
        const [yr, mn] = selectedMonth.split("-").map(Number);
        const lastDay = new Date(yr, mn, 0).getDate();
        params.end = `${selectedMonth}-${String(lastDay).padStart(2, "0")}T23:59:59.999Z`;
      } else if (dateRange === "custom" && startDate && endDate) {
        params.start = startDate + "T00:00:00.000Z";
        params.end = endDate + "T23:59:59.999Z";
      }
      
      // 2. Outcome Filter
      if (selectedOutcome !== "all") {
        params.outcome = selectedOutcome;
      }
      
      // 3. Executive Filter (for admin)
      if (isAdmin && selectedExec !== "all") {
        params.by_user_id = selectedExec;
      }
      
      const res = await api.get("/calls", { params });
      setLogs(res.data || []);
    } catch (err) {
      toast.error("Failed to load call logs");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [dateRange, selectedMonth, startDate, endDate, selectedOutcome, selectedExec, isAdmin]);
  
  // Trigger load on filter change
  useEffect(() => {
    // If selected month is empty, initialize to current month
    if (dateRange === "month" && !selectedMonth) {
      const now = new Date();
      setSelectedMonth(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
      return;
    }
    loadLogs();
  }, [loadLogs, dateRange, selectedMonth, startDate, endDate, selectedOutcome, selectedExec]);
  
  const formatDuration = (sec) => {
    if (!sec || sec <= 0) return "—";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };
  
  const formatIST = (isoString) => {
    if (!isoString) return "";
    try {
      const d = new Date(isoString);
      return d.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
      });
    } catch {
      return isoString;
    }
  };
  
  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto" data-testid="call-logs-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-chivo font-bold text-gray-900 flex items-center gap-2">
            <PhoneCall size={26} className="text-[#002FA7]" /> Call Logs
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            {isAdmin ? "Global list of all executive call logs and sync logs." : "Logs of calls you have made and synced."}
          </p>
        </div>
        <button
          onClick={loadLogs}
          className="flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs border border-gray-300 bg-white font-semibold text-gray-700 hover:bg-gray-50 transition active:scale-95 self-start"
        >
          <ArrowClockwise size={14} /> Refresh Feed
        </button>
      </div>
      
      {/* Filters Bar */}
      <div className="bg-gray-50 border border-gray-200 p-4 grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Date Range Option */}
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1">
            <CalendarBlank size={12} /> Date Range
          </label>
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="w-full text-xs border border-gray-300 p-2 bg-white"
          >
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="month">Select Month</option>
            <option value="custom">Custom Range</option>
          </select>
        </div>
        
        {/* Contextual Date Selectors */}
        {dateRange === "month" && (
          <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
            <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Month
            </label>
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="w-full text-xs border border-gray-300 p-2 bg-white"
            />
          </div>
        )}
        
        {dateRange === "custom" && (
          <>
            <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
              <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full text-xs border border-gray-300 p-2 bg-white"
              />
            </div>
            <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
              <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full text-xs border border-gray-300 p-2 bg-white"
              />
            </div>
          </>
        )}
        
        {/* Outcome Filter */}
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1">
            <Funnel size={12} /> Call Outcome
          </label>
          <select
            value={selectedOutcome}
            onChange={(e) => setSelectedOutcome(e.target.value)}
            className="w-full text-xs border border-gray-300 p-2 bg-white"
          >
            <option value="all">All Outcomes</option>
            {Object.entries(OUTCOME_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        
        {/* Executive Filter (Admin Only) */}
        {isAdmin && (
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1">
              <User size={12} /> Executive
            </label>
            <select
              value={selectedExec}
              onChange={(e) => setSelectedExec(e.target.value)}
              className="w-full text-xs border border-gray-300 p-2 bg-white"
            >
              <option value="all">All Executives</option>
              {executives.map(ex => (
                <option key={ex.id} value={ex.id}>{ex.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      
      {/* Logs Content */}
      <div className="bg-white border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 space-y-2">
            <div className="w-8 h-8 border-2 border-[#002FA7] border-t-transparent rounded-full animate-spin"></div>
            <p className="text-xs text-gray-500">Loading call logs...</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
            <PhoneDisconnect size={40} className="text-gray-300" />
            <div>
              <p className="text-sm font-semibold text-gray-700">No call logs found</p>
              <p className="text-xs text-gray-500 mt-0.5">Try adjusting your filters or date range.</p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                  <th className="px-6 py-3.5">Lead / Customer</th>
                  <th className="px-6 py-3.5">Executive</th>
                  <th className="px-6 py-3.5">Date &amp; Time</th>
                  <th className="px-6 py-3.5">Direction</th>
                  <th className="px-6 py-3.5">Outcome</th>
                  <th className="px-6 py-3.5">Duration</th>
                  <th className="px-6 py-3.5">Notes &amp; Summaries</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.map((log) => (
                  <tr 
                    key={log.id} 
                    className="hover:bg-gray-50/50 transition-colors"
                    data-testid={`call-log-row-${log.id}`}
                  >
                    <td className="px-6 py-4">
                      {log.lead_id ? (
                        <Link 
                          to={`/leads/${log.lead_id}`} 
                          className="text-xs font-semibold text-blue-600 hover:underline font-chivo"
                        >
                          Lead Link
                        </Link>
                      ) : (
                        <span className="text-xs font-semibold text-gray-700">Orphan Call</span>
                      )}
                      <div className="text-[10px] font-mono text-gray-400 mt-0.5">{log.phone}</div>
                    </td>
                    <td className="px-6 py-4 text-xs font-medium text-gray-700">
                      {log.by_user_name}
                    </td>
                    <td className="px-6 py-4 text-xs text-gray-500 font-mono">
                      {formatIST(log.at)}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-[9px] uppercase font-bold px-2 py-0.5 rounded ${
                        log.direction === "incoming" ? "bg-blue-50 text-blue-700 border border-blue-100" : "bg-gray-50 text-gray-700 border border-gray-100"
                      }`}>
                        {log.direction || "outgoing"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-[9px] uppercase font-bold px-2 py-0.5 rounded border ${
                        OUTCOME_COLOR[log.outcome] || "bg-gray-100 text-gray-800"
                      }`}>
                        {OUTCOME_LABELS[log.outcome] || log.outcome}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-xs font-mono text-gray-600">
                      {formatDuration(log.duration_seconds)}
                    </td>
                    <td className="px-6 py-4 max-w-xs">
                      {log.summary ? (
                        <div className="text-xs text-gray-600 bg-gray-50 border border-gray-100 p-2 rounded whitespace-pre-wrap flex gap-1 items-start">
                          <ChatTeardropText size={14} className="text-gray-400 shrink-0 mt-0.5" />
                          <span>{log.summary}</span>
                        </div>
                      ) : (
                        <span className="text-[10px] text-gray-400 italic">No notes logged</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
