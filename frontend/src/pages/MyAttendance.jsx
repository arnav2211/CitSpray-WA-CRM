import React, { useCallback, useEffect, useState } from "react";
import { CaretLeft, CaretRight, Fingerprint, WarningCircle, ArrowClockwise } from "@phosphor-icons/react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { fmtPunch, fmtDay } from "@/components/AttendanceBanner";

/* My Attendance: the employee's own punches and day status, month by month.
   Attendance only - the API never sends salary, so nothing of it can show here. */

const TONE = {
  present: "text-green-700", excused_present: "text-green-700", wfh: "text-green-700", paid_leave: "text-green-700",
  half_day: "text-[#B36200]", missing_punch_out: "text-[#E60000]", early_exit: "text-[#E60000]",
  absent_informed: "text-[#E60000]", absent_uninformed: "text-[#E60000]", leave_approved: "text-[#002FA7]",
  weekly_off: "text-gray-400", weekly_off_unpaid: "text-gray-400", holiday: "text-gray-500", pending_today: "text-[#B36200]",
};

function shiftMonth(m, n) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(m) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

export default function MyAttendance() {
  const [month, setMonth] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (m) => {
    setLoading(true);
    try {
      const { data: d } = await api.get("/attendance/me", { params: m ? { month: m } : {} });
      setData(d);
      if (!m) setMonth(d.month);
    } catch (e) {
      toast.error(errMsg(e, "Could not load attendance"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(month); }, [month, load]);

  const t = data?.today_punch || {};
  const c = data?.counts || {};
  const thisMonth = data?.today?.slice(0, 7);
  const stats = [
    ["Present", (c.present || 0)],
    ["Half days", c.half_day || 0],
    ["Leave", c.leave_approved || 0],
    ["Absent", (c.absent_informed || 0) + (c.absent_uninformed || 0)],
    ["Late", c.late || 0],
    ["No punch-out", c.missing_punch_out || 0],
  ];

  return (
    <div className="p-4 md:p-8 max-w-4xl" data-testid="my-attendance">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h1 className="font-chivo font-black text-2xl md:text-3xl flex items-center gap-2">
          <Fingerprint size={28} weight="bold" /> My Attendance
        </h1>
        <button onClick={() => load(month)} className="text-gray-500 hover:text-gray-900 p-2" title="Refresh">
          <ArrowClockwise size={18} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {data && (
        <div className="border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-x-8 gap-y-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Today</div>
            <div className="font-bold text-lg">
              {t.checked_in ? (
                <span className="text-green-700">Punched in {fmtPunch(t.check_in_time)}</span>
              ) : data.on_leave_today ? (
                <span className="text-gray-600">On leave</span>
              ) : (
                <span className="text-[#E60000]">Not punched in</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Punch-out</div>
            <div className="font-bold text-lg">{t.checked_out ? fmtPunch(t.check_out_time) : "—"}</div>
          </div>
        </div>
      )}

      {data?.missing_punch_out?.length > 0 && (
        <div className="bg-[#FFE9E9] border border-[#E60000]/40 text-[#B00000] p-3 mb-4 text-sm flex gap-2">
          <WarningCircle size={20} weight="fill" className="shrink-0" />
          <div>
            <b>Missed punch-out:</b>{" "}
            {data.missing_punch_out.map((m) => fmtDay(m.date)).join(", ")}. Each counts as a half day until it is fixed.
            Talk to the admin today and get it fixed immediately.
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        <button onClick={() => setMonth(shiftMonth(month, -1))} disabled={!month}
          className="border border-gray-300 p-1.5 hover:bg-gray-50 disabled:opacity-40" data-testid="att-prev">
          <CaretLeft size={14} weight="bold" />
        </button>
        <div className="font-bold min-w-[150px] text-center">{month ? monthLabel(month) : ""}</div>
        <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={!month || month >= thisMonth}
          className="border border-gray-300 p-1.5 hover:bg-gray-50 disabled:opacity-40" data-testid="att-next">
          <CaretRight size={14} weight="bold" />
        </button>
      </div>

      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
        {stats.map(([k, v]) => (
          <div key={k} className="border border-gray-200 p-2 text-center">
            <div className="font-chivo font-black text-xl">{v}</div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{k}</div>
          </div>
        ))}
      </div>

      <div className="border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
            <tr>
              <th className="text-left px-3 py-2">Date</th>
              <th className="text-left px-3 py-2">In</th>
              <th className="text-left px-3 py-2">Out</th>
              <th className="text-left px-3 py-2">Hours</th>
              <th className="text-left px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {(data?.days || []).map((d) => (
              <tr key={d.date} className="border-t border-gray-100 align-top">
                <td className="px-3 py-2 whitespace-nowrap font-medium">{fmtDay(d.date)}</td>
                <td className="px-3 py-2 font-mono text-xs">{d.punch_in ? fmtPunch(d.punch_in) : "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{d.punch_out ? fmtPunch(d.punch_out) : "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{d.work_hours != null ? Number(d.work_hours).toFixed(1) : "—"}</td>
                <td className="px-3 py-2">
                  <div className={`font-bold ${TONE[d.status] || "text-gray-700"}`}>{d.label}</div>
                  {d.flags?.length > 0 && <div className="text-[11px] text-[#B36200]">{d.flags.join(" · ")}</div>}
                  {d.admin_note && <div className="text-[11px] text-gray-600">Admin: {d.admin_note}</div>}
                </td>
              </tr>
            ))}
            {data && !data.days?.length && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-400 italic">No attendance for this month.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
