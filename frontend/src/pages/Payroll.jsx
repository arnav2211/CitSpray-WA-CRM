import React, { useEffect, useMemo, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import {
  Calendar, FileText, Printer, Trash, CheckCircle, Warning, XCircle, Spinner,
  Clock, Buildings, Gear, UsersThree, CaretDown, CaretUp, Flag, Pencil, Eye, EyeSlash, Receipt,
} from "@phosphor-icons/react";

/* ---------------- date helpers (pay cycles are joining-day based) ---------------- */
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dim = (y, m0) => new Date(y, m0 + 1, 0).getDate();

function anchorFor(year, m0, day) {
  return new Date(year, m0, Math.min(day, dim(year, m0)));
}
function addMonthsAnchor(d, n, day) {
  const m0 = d.getMonth() + n;
  const y = d.getFullYear() + Math.floor(m0 / 12);
  const m = ((m0 % 12) + 12) % 12;
  return anchorFor(y, m, day);
}
/** offset 0 = running cycle, -1 = last completed, etc. */
function cycleFor(joiningDate, offset = 0) {
  const jd = new Date(joiningDate + "T00:00:00");
  const day = jd.getDate();
  const today = new Date();
  let anchor = anchorFor(today.getFullYear(), today.getMonth(), day);
  if (anchor > today) anchor = addMonthsAnchor(anchor, -1, day);
  anchor = addMonthsAnchor(anchor, offset, day);
  const next = addMonthsAnchor(anchor, 1, day);
  const end = new Date(next.getTime() - 86400000);
  const payDate = new Date(next.getTime() + 8 * 86400000); // joining day + 8
  return { start: fmt(anchor), end: fmt(end), payDate: fmt(payDate) };
}

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/* Privacy mode: hide every salary figure so the page can be shown to an
   executive (attendance stays visible). Toggled by the eye in the header. */
const HideMoneyContext = React.createContext(false);
function useMoney() {
  const hidden = React.useContext(HideMoneyContext);
  return (n) => (hidden ? "₹ ●●●●" : inr(n));
}

const STATUS_STYLE = {
  present: "bg-emerald-50 text-emerald-700 border-emerald-200",
  excused_present: "bg-emerald-50 text-emerald-700 border-emerald-200",
  wfh: "bg-sky-50 text-sky-700 border-sky-200",
  half_day: "bg-amber-50 text-amber-700 border-amber-200",
  missing_punch_out: "bg-amber-50 text-amber-800 border-amber-300",
  early_exit: "bg-orange-50 text-orange-700 border-orange-200",
  leave_approved: "bg-blue-50 text-blue-700 border-blue-200",
  paid_leave: "bg-blue-50 text-blue-700 border-blue-200",
  absent_informed: "bg-orange-50 text-orange-700 border-orange-200",
  absent_uninformed: "bg-red-50 text-red-700 border-red-200",
  weekly_off: "bg-gray-50 text-gray-500 border-gray-200",
  weekly_off_unpaid: "bg-red-50 text-red-600 border-red-200",
  holiday: "bg-violet-50 text-violet-700 border-violet-200",
  not_joined: "bg-gray-50 text-gray-400 border-gray-100",
  future: "bg-gray-50 text-gray-300 border-gray-100",
  pending_today: "bg-gray-50 text-gray-500 border-gray-200",
};
const STATUS_LABEL = {
  present: "Present", excused_present: "Present*", wfh: "WFH", half_day: "Half Day",
  missing_punch_out: "No Punch-Out", early_exit: "Early Exit", leave_approved: "Leave",
  paid_leave: "Paid Leave", absent_informed: "Informed Abs", absent_uninformed: "Absent",
  weekly_off: "Sunday", weekly_off_unpaid: "Sun Unpaid", holiday: "Holiday", not_joined: "—", future: "", pending_today: "Awaiting",
};

const OVERRIDES = [
  ["auto", "Auto (from machine)"],
  ["present", "Present — no cut"],
  ["wfh", "Work From Home — no cut"],
  ["paid", "Paid Leave / Comp-off — no cut"],
  ["half_day", "Half Day — 0.5 day cut"],
  ["leave", "Approved Leave — 1 day cut"],
  ["informed", "Informed Absence — 1 day cut"],
  ["uninformed", "Uninformed Absence — 2 days cut"],
];

/* =================================================================== */
export default function PayrollPage() {
  const [tab, setTab] = useState("register"); // register | today | holidays | settings
  // Hidden by default so the page is safe to open in front of an executive;
  // remembers the last choice.
  const [hideMoney, setHideMoney] = useState(() => localStorage.getItem("payroll_hide_money") !== "0");
  const toggleMoney = () => {
    setHideMoney((h) => {
      localStorage.setItem("payroll_hide_money", h ? "0" : "1");
      return !h;
    });
  };
  return (
    <div className="p-4 md:p-8 space-y-5 font-chivo text-gray-900 print:p-0">
      <div className="flex items-center justify-between gap-4 flex-wrap print:hidden">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Admin Portal</div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Payroll &amp; Attendance</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={toggleMoney} data-testid="payroll-money-toggle"
            title={hideMoney ? "Salary amounts are hidden — click to reveal" : "Salary amounts are visible — click to hide before showing this screen to an employee"}
            className={`flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold px-3 py-2 border ${hideMoney ? "border-gray-300 bg-gray-100 text-gray-600" : "bg-[#E67E00] border-[#E67E00] text-white"}`}>
            {hideMoney ? <EyeSlash size={15} weight="bold" /> : <Eye size={15} weight="bold" />}
            {hideMoney ? "Salaries Hidden" : "Salaries Visible"}
          </button>
          <div className="flex gap-1 border border-gray-200 bg-white p-1">
            {[["register", "Payroll Register", Calendar], ["today", "Today Live", Clock], ["holidays", "Holidays", Buildings], ["settings", "Rules & WFH", Gear]].map(([k, label, Icon]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold px-3 py-2 ${tab === k ? "bg-[#002FA7] text-white" : "text-gray-600 hover:bg-gray-50"}`}>
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <HideMoneyContext.Provider value={hideMoney}>
        {tab === "register" && <RegisterTab />}
        {tab === "today" && <TodayTab />}
        {tab === "holidays" && <HolidaysTab />}
        {tab === "settings" && <SettingsTab />}
      </HideMoneyContext.Provider>
    </div>
  );
}

/* ======================= REGISTER (payroll) ======================= */
function RegisterTab() {
  const money = useMoney();
  const [mode, setMode] = useState("cycle"); // cycle | month | custom
  const [cycleOffset, setCycleOffset] = useState(-1); // -1 last completed, 0 running
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [openUser, setOpenUser] = useState(null);   // expanded row user_id
  const [printTarget, setPrintTarget] = useState(null); // "register" | "sheet" | "voucher"
  const [sheetUser, setSheetUser] = useState(null);     // employee for the sheet modal
  const [sheetPrintData, setSheetPrintData] = useState(null);
  const [voucherData, setVoucherData] = useState(null); // employee row for the A5 voucher

  const load = async () => {
    setLoading(true);
    try {
      if (mode === "cycle") {
        const { data: users } = await api.get("/users");
        const emps = users.filter((u) => u.role !== "admin" && u.active !== false &&
          !["scanner", "test_user"].includes(u.username) && (u.employee_code || u.role === "executive"));
        const list = [];
        for (const emp of emps) {
          const jd = emp.joining_date || fmt(new Date());
          const cyc = cycleFor(jd, cycleOffset);
          try {
            const { data } = await api.get("/payroll/calculate", {
              params: { start_date: cyc.start, end_date: cyc.end, user_id: emp.id },
            });
            if (data.payroll?.length) {
              list.push({ ...data.payroll[0], period_start: cyc.start, period_end: cyc.end, pay_date: cyc.payDate });
            }
          } catch { /* per-user failure shouldn't kill the register */ }
        }
        setRows(list);
      } else {
        let start, end;
        if (mode === "month") {
          const [y, m] = selectedMonth.split("-");
          start = `${y}-${m}-01`;
          end = `${y}-${m}-${String(dim(Number(y), Number(m) - 1)).padStart(2, "0")}`;
        } else {
          if (!customStart || !customEnd) { setLoading(false); return; }
          start = customStart; end = customEnd;
        }
        const { data } = await api.get("/payroll/calculate", { params: { start_date: start, end_date: end } });
        setRows((data.payroll || []).map((p) => ({ ...p, period_start: start, period_end: end })));
      }
    } catch (e) {
      toast.error(errMsg(e, "Payroll calculation failed"));
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [mode, cycleOffset, selectedMonth, customStart, customEnd]);

  const override = async (userId, date, status) => {
    try {
      await api.post("/payroll/adjust", { user_id: userId, date, status });
      toast.success("Day updated — salary recalculated");
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const editPunch = async (userId, date, checkIn, checkOut) => {
    try {
      await api.post("/attendance/edit", {
        user_id: userId, date,
        check_in: checkIn || null, check_out: checkOut || null,
      });
      toast.success("Punch times updated");
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const markPaid = async (p, paid) => {
    try {
      await api.post("/payroll/mark-paid", {
        user_id: p.user_id, period_start: p.period_start, period_end: p.period_end,
        paid, amount: p.final_salary_payout,
      });
      toast.success(paid ? `Marked PAID: ${p.name} (${inr(p.final_salary_payout)})` : `Unmarked: ${p.name}`);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const clearPunchOut = async (userId, date, name) => {
    if (!window.confirm(`Remove the punch-OUT for ${name} on ${date}?\n\nUse this when a punch-out was made by mistake — the day goes back to "still in office" and salary recalculates.`)) return;
    try {
      await api.post("/attendance/edit", { user_id: userId, date, clear_check_out: true });
      toast.success("Punch-out removed");
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const doPrint = (target) => {
    setPrintTarget(target);
    setTimeout(() => { window.print(); setTimeout(() => setPrintTarget(null), 500); }, 150);
  };

  const printVoucher = (p) => {
    setVoucherData(p);
    doPrint("voucher");
  };

  const totals = useMemo(() => ({
    gross: rows.reduce((s, r) => s + (r.pro_rated_target_salary || 0), 0),
    ded: rows.reduce((s, r) => s + (r.total_deductions || 0), 0),
    net: rows.reduce((s, r) => s + (r.final_salary_payout || 0), 0),
    flagged: rows.filter((r) => (r.flags || []).length > 0).length,
  }), [rows]);

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="bg-white border border-gray-200 p-4 flex flex-wrap items-end gap-4 print:hidden">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1.5">Salary Period</div>
          <div className="flex gap-1">
            {[["cycle", "Pay Cycle (per joining date)"], ["month", "Calendar Month"], ["custom", "Custom"]].map(([k, label]) => (
              <button key={k} onClick={() => setMode(k)}
                className={`text-[10px] uppercase tracking-widest font-bold px-3 py-1.5 border ${mode === k ? "bg-[#002FA7] border-[#002FA7] text-white" : "border-gray-200 hover:bg-gray-50 text-gray-600"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {mode === "cycle" && (
          <div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1.5">Cycle</div>
            <select value={cycleOffset} onChange={(e) => setCycleOffset(Number(e.target.value))}
              className="border border-gray-300 px-2 py-1.5 text-sm bg-white">
              <option value={0}>Current (running) cycle</option>
              <option value={-1}>Last completed cycle (payable now)</option>
              <option value={-2}>2 cycles back</option>
              <option value={-3}>3 cycles back</option>
            </select>
          </div>
        )}
        {mode === "month" && (
          <input type="month" value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}
            className="border border-gray-300 px-3 py-1.5 text-sm bg-white" />
        )}
        {mode === "custom" && (
          <div className="flex gap-2">
            <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="border border-gray-300 px-2 py-1.5 text-sm bg-white" />
            <input type="date" value={customEnd} min={customStart} onChange={(e) => setCustomEnd(e.target.value)} className="border border-gray-300 px-2 py-1.5 text-sm bg-white" />
          </div>
        )}
        <div className="ml-auto">
          <button onClick={() => doPrint("register")}
            className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 text-xs uppercase tracking-widest font-bold flex items-center gap-1.5">
            <Printer size={16} /> Print Register
          </button>
        </div>
      </div>

      {/* Summary cards */}
      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 print:hidden">
          {[["Employees", rows.length, ""], ["Gross (period)", money(totals.gross), ""], ["Deductions", `-${money(totals.ded)}`, "text-red-600"], ["Net Payout", money(totals.net), "text-[#002FA7]"]].map(([label, val, cls]) => (
            <div key={label} className="bg-white border border-gray-200 p-4">
              <div className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">{label}</div>
              <div className={`font-black text-xl md:text-2xl mt-1 font-mono ${cls}`}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center py-14 gap-3">
          <Spinner size={30} className="animate-spin text-[#002FA7]" />
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Calculating payroll…</div>
        </div>
      )}

      {/* Register table */}
      {!loading && rows.length > 0 && (
        <div className={`bg-white border border-gray-200 overflow-x-auto ${printTarget && printTarget !== "register" ? "print:hidden" : ""}`}>
          <div className="hidden print:block px-4 pt-4 pb-2 border-b-2 border-gray-900">
            <div className="font-black text-2xl uppercase">CitSpray — Salary Register</div>
            <div className="text-[10px] font-mono text-gray-600">
              Generated {new Date().toLocaleString("en-IN")} · Daily rate = Base ÷ days in cycle
            </div>
          </div>
          <table className="w-full text-sm text-left min-w-[900px]">
            <thead className="bg-gray-50 text-[10px] uppercase font-bold text-gray-500 border-b border-gray-200">
              <tr>
                <th className="px-3 py-3">Employee</th>
                <th className="px-3 py-3">Period</th>
                <th className="px-3 py-3 text-right">Base</th>
                <th className="px-3 py-3 text-center">P</th>
                <th className="px-3 py-3 text-center">½</th>
                <th className="px-3 py-3 text-center">Lv</th>
                <th className="px-3 py-3 text-center">Abs</th>
                <th className="px-3 py-3 text-center">Sun</th>
                <th className="px-3 py-3 text-center">Late</th>
                <th className="px-3 py-3 text-right">Cut</th>
                <th className="px-3 py-3 text-right">Net Pay</th>
                <th className="px-3 py-3">Pay Date</th>
                <th className="px-3 py-3 text-center">Paid</th>
                <th className="px-3 py-3 print:hidden"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <React.Fragment key={p.user_id}>
                  <tr className={`border-t border-gray-100 hover:bg-gray-50/60 ${openUser === p.user_id ? "bg-blue-50/40" : ""}`}>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold">{p.name}</span>
                        {(p.flags || []).length > 0 && (
                          <span title={p.flags.join("\n")}><Flag size={13} weight="fill" className="text-[#E60000]" /></span>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-400">
                        {p.department || p.role}{p.employee_code ? ` · #${p.employee_code}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-gray-600 whitespace-nowrap">{p.period_start}<br />{p.period_end}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{money(p.base_salary)}</td>
                    <td className="px-3 py-2.5 text-center font-bold text-emerald-700">{p.counts.present}</td>
                    <td className="px-3 py-2.5 text-center text-amber-700">{p.counts.half_day + (p.counts.missing_punch_out || 0)}</td>
                    <td className="px-3 py-2.5 text-center text-blue-700">{p.counts.leave_approved + (p.counts.absent_informed || 0)}</td>
                    <td className="px-3 py-2.5 text-center text-red-600 font-bold">{p.counts.absent_uninformed}</td>
                    <td className="px-3 py-2.5 text-center whitespace-nowrap">
                      <span className="text-gray-600">{p.counts.weekly_off}</span>
                      {(p.counts.sunday_unpaid || 0) > 0 && (
                        <span className="ml-0.5 text-red-600 font-bold" title="Unpaid Sundays (worked under 5 days that week)">+{p.counts.sunday_unpaid}✗</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center text-gray-500">{p.counts.late || 0}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-red-600">-{money(p.total_deductions)}</td>
                    <td className="px-3 py-2.5 text-right font-mono font-black text-[#002FA7] print:text-black">{money(p.final_salary_payout)}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">{p.pay_date || "—"}</td>
                    <td className="px-3 py-2.5 text-center whitespace-nowrap">
                      {mode !== "cycle" ? (
                        <span className="text-gray-300 text-xs" title="Switch to Pay Cycle mode to record payments">—</span>
                      ) : p.payment?.paid ? (
                        <button onClick={() => window.confirm(`Unmark salary as paid for ${p.name}?`) && markPaid(p, false)}
                          title={`Paid ${p.payment.paid_at ? p.payment.paid_at.slice(0, 10) : ""} — click to undo`}
                          className="px-2 py-0.5 bg-emerald-600 text-white text-[10px] font-black uppercase tracking-wider rounded-sm">
                          ✓ Paid
                        </button>
                      ) : (
                        <button onClick={() => window.confirm(`Mark ${inr(p.final_salary_payout)} salary as PAID to ${p.name} for ${p.period_start} → ${p.period_end}?`) && markPaid(p, true)}
                          className="px-2 py-0.5 border border-gray-300 text-gray-500 hover:border-emerald-600 hover:text-emerald-700 text-[10px] font-bold uppercase tracking-wider rounded-sm">
                          Mark
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2.5 print:hidden whitespace-nowrap">
                      <button onClick={() => setOpenUser(openUser === p.user_id ? null : p.user_id)}
                        className="text-[10px] uppercase font-bold text-[#002FA7] hover:underline mr-2 inline-flex items-center gap-0.5">
                        {openUser === p.user_id ? <CaretUp size={12} /> : <CaretDown size={12} />} Days
                      </button>
                      <button onClick={() => setSheetUser(p)} title="Salary sheet for this employee's own pay cycle (view + print)"
                        className="text-[10px] uppercase font-bold text-emerald-700 hover:underline inline-flex items-center gap-0.5">
                        <Printer size={13} /> Sheet
                      </button>
                      <button onClick={() => printVoucher(p)} title="Print A5 salary voucher for the employee to sign"
                        className="ml-2 text-[10px] uppercase font-bold text-[#7C3AED] hover:underline inline-flex items-center gap-0.5"
                        data-testid={`voucher-btn-${p.user_id}`}>
                        <Receipt size={13} /> Voucher
                      </button>
                    </td>
                  </tr>
                  {openUser === p.user_id && (
                    <tr className="print:hidden">
                      <td colSpan={14} className="bg-gray-50/80 px-4 py-4 border-t border-gray-200">
                        <DayGrid p={p} onOverride={override} onEditPunch={editPunch} onClearPunchOut={clearPunchOut} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-gray-300 bg-gray-50 font-bold">
              <tr>
                <td className="px-3 py-2.5" colSpan={9}>TOTAL</td>
                <td className="px-3 py-2.5 text-right font-mono text-red-600">-{money(totals.ded)}</td>
                <td className="px-3 py-2.5 text-right font-mono font-black">{money(totals.net)}</td>
                <td colSpan={3}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="text-center py-16 border border-dashed border-gray-300 bg-gray-50/50">
          <FileText size={44} className="mx-auto text-gray-300 mb-2" />
          <div className="font-bold text-gray-600 text-sm">No payroll data for this period</div>
        </div>
      )}

      {/* Per-employee salary sheet: on-screen modal + print target */}
      {sheetUser && (
        <EmployeeSheetModal
          userMeta={sheetUser}
          onClose={() => setSheetUser(null)}
          onPrint={(data) => { setSheetPrintData(data); doPrint("sheet"); }}
          onVoucher={(data) => printVoucher(data)}
          onOverride={override}
          onEditPunch={editPunch}
          onClearPunchOut={clearPunchOut}
        />
      )}
      {printTarget === "sheet" && sheetPrintData && <PrintSheet p={sheetPrintData} />}
      {printTarget === "voucher" && voucherData && <SalaryVoucher p={voucherData} />}

      <PrintStyles a5={printTarget === "voucher"} />
    </div>
  );
}

function DayGrid({ p, onOverride, onEditPunch, onClearPunchOut }) {
  const money = useMoney();
  const [editDay, setEditDay] = useState(null);
  const [inVal, setInVal] = useState("");
  const [outVal, setOutVal] = useState("");
  const days = (p.daily_breakdown || []).filter((d) => d.status !== "future");

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-widest font-bold text-gray-500">
          {p.name} — day-by-day ({p.period_start} → {p.period_end}) · daily rate {money(p.daily_rate)}
        </div>
        {(p.flags || []).length > 0 && (
          <div className="text-[11px] text-[#E60000] font-semibold flex items-center gap-1">
            <Flag size={12} weight="fill" /> {p.flags.join(" · ")}
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 max-h-[340px] overflow-y-auto pr-1">
        {days.map((day) => {
          const isOverride = (day.details || "").includes("Admin");
          const sel = !isOverride ? "auto" :
            day.status === "excused_present" ? "present" :
            day.status === "wfh" ? "wfh" :
            day.status === "paid_leave" ? "paid" :
            day.status === "half_day" ? "half_day" :
            day.status === "absent_informed" ? "informed" :
            day.status === "absent_uninformed" ? "uninformed" :
            day.status === "leave_approved" ? "leave" : "auto";
          const editable = !["not_joined"].includes(day.status);
          return (
            <div key={day.date} className="bg-white border border-gray-200 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-mono text-xs font-black">{day.date}</span>
                  <span className="ml-1.5 text-[10px] text-gray-400">{day.weekday.slice(0, 3)}</span>
                </div>
                <span className={`px-1.5 py-0.5 border text-[9px] font-bold uppercase rounded-sm ${STATUS_STYLE[day.status] || ""}`}>
                  {STATUS_LABEL[day.status] ?? day.status}
                </span>
              </div>
              <div className="text-[10px] text-gray-500 leading-snug min-h-[24px]">{day.details}</div>
              <div className="flex items-center justify-between text-[10px] font-mono text-gray-600">
                {editDay === day.date ? (
                  <div className="flex items-center gap-1 w-full">
                    <input type="time" value={inVal} onChange={(e) => setInVal(e.target.value)} className="border border-gray-300 px-1 py-0.5 text-[10px] w-[74px]" />
                    <input type="time" value={outVal} onChange={(e) => setOutVal(e.target.value)} className="border border-gray-300 px-1 py-0.5 text-[10px] w-[74px]" />
                    <button onClick={() => { onEditPunch(p.user_id, day.date, inVal, outVal); setEditDay(null); }}
                      className="text-[9px] font-bold text-white bg-[#002FA7] px-1.5 py-1 uppercase">Save</button>
                    <button onClick={() => setEditDay(null)} className="text-[9px] text-gray-400 uppercase font-bold">✕</button>
                  </div>
                ) : (
                  <>
                    <span>In {day.punch_in || "--:--"} · Out {day.punch_out || "--:--"}{day.work_hours != null ? ` · ${day.work_hours}h` : ""}</span>
                    <span className="flex items-center gap-1">
                      {day.punch_out && onClearPunchOut && (
                        <button title="Remove this punch-out (done by mistake)"
                          onClick={() => onClearPunchOut(p.user_id, day.date, p.name)}
                          className="text-gray-300 hover:text-[#E60000]" data-testid={`clear-out-${day.date}`}>
                          <XCircle size={13} weight="bold" />
                        </button>
                      )}
                      {editable && (
                        <button title="Edit punch times" onClick={() => { setEditDay(day.date); setInVal(day.punch_in || ""); setOutVal(day.punch_out || ""); }}
                          className="text-gray-300 hover:text-[#002FA7]"><Pencil size={12} /></button>
                      )}
                    </span>
                  </>
                )}
              </div>
              {editable && (
                <select value={sel} onChange={(e) => onOverride(p.user_id, day.date, e.target.value)}
                  className="w-full text-[11px] border border-gray-300 rounded-sm px-1 py-1 bg-white">
                  {OVERRIDES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              )}
              {(day.flags || []).length > 0 && (
                <div className="text-[9px] text-[#E60000] font-bold">{day.flags.join(" · ")}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Deduction/earning breakdown grouped by reason (full transparency) ---- */
const DEDUCTION_LABEL = {
  absent_uninformed: "Uninformed absence — 2 days' salary cut per day",
  leave_approved: "Approved leave — 1 day's salary cut per day",
  absent_informed: "Informed absence — 1 day's salary cut per day",
  half_day: "Half day (left between 3 PM and 7 PM) — ½ day cut",
  early_exit: "Left before 3 PM — full day cut",
  missing_punch_out: "Missing punch-out — counted as half day",
  weekly_off_unpaid: "Unpaid Sunday — over quota (1 per 5 worked days) or leave on both sides",
};

function breakdownGroups(days) {
  const g = {};
  days.forEach((d) => {
    if ((d.deduction || 0) > 0) {
      if (!g[d.status]) g[d.status] = { count: 0, amt: 0 };
      g[d.status].count += 1;
      g[d.status].amt += d.deduction;
    }
  });
  return Object.entries(g).sort((a, b) => b[1].amt - a[1].amt);
}

/* ---- Calendar view of one period's attendance ---- */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function AttendanceCalendar({ p }) {
  const days = (p.daily_breakdown || []).filter((d) => d.status !== "future");
  if (!days.length) return null;
  const byDate = Object.fromEntries((p.daily_breakdown || []).map((d) => [d.date, d]));
  const start = new Date(p.period_start + "T00:00:00");
  const end = new Date(p.period_end + "T00:00:00");
  const cur = new Date(start);
  cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7)); // back to Monday
  const weeks = [];
  while (cur <= end) {
    const week = [];
    for (let i = 0; i < 7; i++) { week.push(fmt(cur)); cur.setDate(cur.getDate() + 1); }
    weeks.push(week);
  }
  const legend = [
    ["present", "Present"], ["half_day", "Half Day"], ["missing_punch_out", "No Punch-Out"],
    ["early_exit", "Early Exit"], ["leave_approved", "Leave"], ["absent_uninformed", "Absent"],
    ["weekly_off", "Sunday Paid"], ["weekly_off_unpaid", "Sunday Unpaid"], ["holiday", "Holiday"], ["wfh", "WFH"],
  ];
  return (
    <div className="mb-4">
      <div className="grid grid-cols-7 gap-px bg-gray-300 border border-gray-300 text-[9px]">
        {WEEKDAYS.map((w) => (
          <div key={w} className="bg-gray-100 text-center font-bold uppercase tracking-wider py-1">{w}</div>
        ))}
        {weeks.flat().map((date) => {
          const d = byDate[date];
          const inPeriod = date >= p.period_start && date <= p.period_end;
          const dt = new Date(date + "T00:00:00");
          const dayLabel = `${dt.getDate()}${dt.getDate() === 1 || date === p.period_start ? " " + MONTHS[dt.getMonth()] : ""}`;
          if (!inPeriod || !d || ["not_joined"].includes(d.status)) {
            return <div key={date} className="bg-gray-50 min-h-[52px] p-1 text-gray-300 font-mono">{inPeriod ? dayLabel : ""}</div>;
          }
          if (d.status === "future") {
            return <div key={date} className="bg-white min-h-[52px] p-1 text-gray-300 font-mono">{dayLabel}</div>;
          }
          return (
            <div key={date} className={`min-h-[52px] p-1 border-0 ${STATUS_STYLE[d.status] || "bg-white"}`}
              title={`${date}: ${d.details || STATUS_LABEL[d.status] || d.status}`}>
              <div className="flex items-center justify-between">
                <span className="font-mono font-black">{dayLabel}</span>
                {(d.flags || []).length > 0 && <span title={d.flags.join("\n")}>⚑</span>}
              </div>
              <div className="font-bold leading-tight truncate">{STATUS_LABEL[d.status] ?? d.status}</div>
              {(d.punch_in || d.punch_out) && (
                <div className="font-mono text-[8px] leading-tight">{d.punch_in || "--"}–{d.punch_out || "--"}</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {legend.map(([s, label]) => (
          <span key={s} className={`px-1.5 py-0.5 border text-[8px] font-bold uppercase rounded-sm ${STATUS_STYLE[s]}`}>{label}</span>
        ))}
      </div>
    </div>
  );
}

/* Shared salary-sheet body: shown on screen to the admin AND used for print */
function SalarySheetContent({ p }) {
  const money = useMoney();
  const days = (p.daily_breakdown || []).filter((d) => !["future", "not_joined"].includes(d.status));
  const groups = breakdownGroups(days);
  const paidDays = days.filter((d) => (d.earning || 0) > 0).length;
  const totalHours = days.reduce((s, d) => s + (d.work_hours || 0), 0);
  const c = p.counts || {};
  return (
    <div className="bg-white text-black">
      <div className="border-b-2 border-black pb-3 mb-3">
        <div className="font-black text-xl md:text-2xl uppercase">CitSpray — Attendance &amp; Salary Sheet</div>
        <div className="text-[11px] font-mono mt-1 leading-relaxed">
          <b>{p.name}</b> · {p.department || p.role}{p.employee_code ? ` · Machine ID ${p.employee_code}` : ""} · Joined {p.joining_date}<br />
          Salary period: <b>{p.period_start} → {p.period_end}</b> (joining-date cycle) · Pay date: <b>{p.pay_date || "—"}</b> · Generated {new Date().toLocaleDateString("en-IN")}
        </div>
      </div>

      {/* Attendance summary chips */}
      <div className="text-[11px] mb-3 font-mono flex items-center justify-between gap-3 flex-wrap">
        <span>
          Present: <b>{c.present}</b> · Half days: <b>{(c.half_day || 0) + (c.missing_punch_out || 0)}</b> ·
          Approved leave: <b>{c.leave_approved || 0}</b> · Uninformed absent: <b>{c.absent_uninformed || 0}</b> ·
          Sundays paid: <b>{c.weekly_off || 0}</b> · Sundays unpaid: <b>{c.sunday_unpaid || 0}</b> ·
          Late arrivals (after 10:30): <b>{c.late || 0}</b> · Total worked: <b>{totalHours.toFixed(1)}h</b>
        </span>
        {p.payment?.paid && (
          <span className="border-2 border-emerald-600 text-emerald-700 font-black px-2 py-0.5 uppercase tracking-widest text-[10px] rotate-[-2deg]">
            SALARY PAID {p.payment.paid_at ? `· ${p.payment.paid_at.slice(0, 10)}` : ""}
          </span>
        )}
      </div>

      {/* Calendar view */}
      <AttendanceCalendar p={p} />

      {/* Day-by-day attendance */}
      <table className="w-full text-[11px] border-collapse mb-4">
        <thead>
          <tr className="border-b-2 border-black text-left uppercase text-[9px]">
            <th className="py-1 pr-2">Date</th><th className="py-1 pr-2">Day</th>
            <th className="py-1 pr-2">In</th><th className="py-1 pr-2">Out</th>
            <th className="py-1 pr-2">Hours</th><th className="py-1 pr-2">Status</th>
            <th className="py-1 pr-2">Remark</th>
            <th className="py-1 pr-2 text-right">Earned</th><th className="py-1 text-right">Cut</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date} className="border-b border-gray-300">
              <td className="py-0.5 pr-2 font-mono">{d.date}</td>
              <td className="py-0.5 pr-2">{d.weekday.slice(0, 3)}</td>
              <td className="py-0.5 pr-2 font-mono">{d.punch_in || "—"}</td>
              <td className="py-0.5 pr-2 font-mono">{d.punch_out || "—"}</td>
              <td className="py-0.5 pr-2 font-mono">{d.work_hours ?? "—"}</td>
              <td className="py-0.5 pr-2 whitespace-nowrap">{STATUS_LABEL[d.status] ?? d.status}</td>
              <td className="py-0.5 pr-2 text-[9px] text-gray-700 max-w-[220px]">{d.details}</td>
              <td className="py-0.5 pr-2 text-right font-mono">{d.earning ? money(d.earning) : "—"}</td>
              <td className="py-0.5 text-right font-mono">{d.deduction ? `-${money(d.deduction)}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Salary calculation, line by line */}
      <div className="border-2 border-black p-3 mb-4">
        <div className="font-black text-xs uppercase tracking-widest mb-2">How this salary was calculated</div>
        <table className="w-full text-[12px] font-mono">
          <tbody>
            <tr><td className="py-0.5">Monthly base salary</td><td className="text-right">{money(p.base_salary)}</td></tr>
            <tr className="border-b border-gray-400">
              <td className="py-0.5">Daily rate = {money(p.base_salary)} ÷ {p.cycle_days ?? "—"} days in cycle</td>
              <td className="text-right">{money(p.daily_rate)} / day</td>
            </tr>
            <tr>
              <td className="py-0.5">Period gross ({days.filter((d) => d.status !== "pending_today").length} days × {money(p.daily_rate)}; {paidDays} paid)</td>
              <td className="text-right">{money(p.pro_rated_target_salary)}</td>
            </tr>
            {groups.map(([status, g]) => (
              <tr key={status} className="text-red-700">
                <td className="py-0.5 pl-3">− {DEDUCTION_LABEL[status] || status}: {g.count} day(s)</td>
                <td className="text-right">-{money(g.amt)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-black font-black text-base">
              <td className="py-1">NET PAYABLE on {p.pay_date || "pay date"}</td>
              <td className="text-right">{money(p.final_salary_payout)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {(p.flags || []).length > 0 && (
        <div className="text-[10px] mb-3"><b>Notes for admin:</b> {p.flags.join(" · ")}</div>
      )}

      {/* Rules legend for transparency */}
      <div className="text-[9px] text-gray-700 leading-relaxed border-t border-gray-400 pt-2">
        <b>Company rules:</b> Office Mon–Sat 10:30 AM – 7:00 PM. Arrival allowed till 11:00 AM (later arrivals are flagged, no cut).
        Leaving after 3 PM but before 7 PM = half day (½ day cut). Leaving before 3 PM = full day cut.
        Approved leave = 1 day's salary cut per day; absence without approval = 2 days' cut per day.
        Paid Sundays are earned by total days worked in the period: every 5 worked days pays 1 Sunday
        (20 days → 4 Sundays, 15 → 3, …). A Sunday with leave/absence on both the day before and after is unpaid.
        Declared company holidays are fully paid. Daily rate = Base ÷ number of days in the salary cycle.
      </div>

      <div className="flex justify-between mt-14 pt-6 text-center text-[10px] font-bold uppercase tracking-widest">
        <div className="w-1/3 border-t border-black pt-1 mx-4">Employee Signature</div>
        <div className="w-1/3 border-t border-black pt-1 mx-4">Authorized Signatory</div>
      </div>
    </div>
  );
}

/* Print-only wrapper */
function PrintSheet({ p }) {
  return <div className="hidden print:block"><SalarySheetContent p={p} /></div>;
}

/* ---- Amount in words (Indian numbering: lakh / crore) ---- */
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigits(n) {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`;
}
function amountInWords(num) {
  let n = Math.floor(Math.abs(Number(num) || 0));
  if (n === 0) return "Zero Rupees Only";
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const hundred = Math.floor(n / 100); n %= 100;
  if (crore) parts.push(`${twoDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (n) parts.push(twoDigits(n));
  return `${parts.join(" ")} Rupees Only`;
}

/* ---- A5 salary voucher: employee signs to confirm they received the salary ---- */
function SalaryVoucher({ p }) {
  const c = p.counts || {};
  const paidOn = p.payment?.paid_at ? String(p.payment.paid_at).slice(0, 10) : "____________";
  return (
    <div className="hidden print:block voucher-page bg-white text-black" data-testid="salary-voucher">
      <div className="border-2 border-black p-4" style={{ minHeight: "180mm" }}>
        <div className="text-center border-b-2 border-black pb-2 mb-3">
          <div className="font-black text-lg uppercase tracking-wide">CitSpray / Mangalam Agro</div>
          <div className="text-[11px] uppercase tracking-widest font-bold mt-0.5">Salary Payment Voucher</div>
        </div>

        <table className="w-full text-[12px] mb-3">
          <tbody>
            <tr>
              <td className="py-1 font-bold w-[38%]">Voucher No.</td>
              <td className="py-1 font-mono">SAL/{(p.employee_code || p.user_id || "").toString().slice(-6)}/{String(p.period_end || "").replace(/-/g, "").slice(0, 6)}</td>
            </tr>
            <tr><td className="py-1 font-bold">Employee Name</td><td className="py-1 font-bold">{p.name}</td></tr>
            <tr>
              <td className="py-1 font-bold">Designation / Dept</td>
              <td className="py-1">{p.department || p.role || "—"}{p.employee_code ? ` · ID ${p.employee_code}` : ""}</td>
            </tr>
            <tr><td className="py-1 font-bold">Salary Period</td><td className="py-1 font-mono">{p.period_start} to {p.period_end}</td></tr>
            <tr><td className="py-1 font-bold">Payment Date</td><td className="py-1 font-mono">{paidOn}</td></tr>
          </tbody>
        </table>

        <table className="w-full text-[12px] border-collapse border border-black mb-3">
          <tbody>
            <tr className="border-b border-black">
              <td className="py-1.5 px-2 border-r border-black">Monthly base salary</td>
              <td className="py-1.5 px-2 text-right font-mono">{inr(p.base_salary)}</td>
            </tr>
            <tr className="border-b border-black">
              <td className="py-1.5 px-2 border-r border-black">
                Present {c.present || 0} · Half {(c.half_day || 0) + (c.missing_punch_out || 0)} · Leave {c.leave_approved || 0} · Absent {c.absent_uninformed || 0}
              </td>
              <td className="py-1.5 px-2 text-right font-mono">{inr(p.pro_rated_target_salary)}</td>
            </tr>
            <tr className="border-b border-black">
              <td className="py-1.5 px-2 border-r border-black">Less: deductions</td>
              <td className="py-1.5 px-2 text-right font-mono">-{inr(p.total_deductions)}</td>
            </tr>
            <tr className="bg-gray-100">
              <td className="py-2 px-2 border-r border-black font-black uppercase">Net amount paid</td>
              <td className="py-2 px-2 text-right font-mono font-black text-base">{inr(p.final_salary_payout)}</td>
            </tr>
          </tbody>
        </table>

        <div className="text-[11px] mb-4">
          <span className="font-bold">Amount in words: </span>
          <span className="italic">{amountInWords(p.final_salary_payout)}</span>
        </div>

        <div className="text-[10px] leading-relaxed border border-black p-2 mb-6">
          I, <b>{p.name}</b>, acknowledge that I have received the above amount of
          <b> {inr(p.final_salary_payout)}</b> as full and final salary for the period
          <b> {p.period_start} to {p.period_end}</b>, and I have no further claim for this period.
        </div>

        <div className="flex justify-between gap-6 mt-12 text-center text-[10px] font-bold uppercase tracking-widest">
          <div className="w-1/2 border-t border-black pt-1">Employee Signature<br /><span className="font-normal normal-case tracking-normal">({p.name})</span></div>
          <div className="w-1/2 border-t border-black pt-1">Authorised Signatory</div>
        </div>
      </div>
    </div>
  );
}

/* On-screen modal for the admin: employee's own joining-date cycle + print */
function EmployeeSheetModal({ userMeta, onClose, onPrint, onVoucher, onOverride, onEditPunch, onClearPunchOut }) {
  const [offset, setOffset] = useState(-1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  // Local salary visibility for this sheet only (independent of the page-level eye)
  const [showMoney, setShowMoney] = useState(false);
  const [editDays, setEditDays] = useState(false);
  const bump = () => setRefresh((r) => r + 1);

  useEffect(() => {
    let stop = false;
    (async () => {
      setLoading(true);
      try {
        const jd = userMeta.joining_date || fmt(new Date());
        const cyc = cycleFor(jd, offset);
        const { data: res } = await api.get("/payroll/calculate", {
          params: { start_date: cyc.start, end_date: cyc.end, user_id: userMeta.user_id },
        });
        if (!stop && res.payroll?.length) {
          setData({ ...res.payroll[0], period_start: cyc.start, period_end: cyc.end, pay_date: cyc.payDate });
        }
      } catch (e) { toast.error(errMsg(e, "Failed to load salary sheet")); }
      finally { if (!stop) setLoading(false); }
    })();
    return () => { stop = true; };
  }, [offset, userMeta, refresh]);

  const togglePaid = async () => {
    if (!data) return;
    const paid = !data.payment?.paid;
    const msg = paid
      ? `Mark ${inr(data.final_salary_payout)} salary as PAID to ${data.name} for ${data.period_start} → ${data.period_end}?`
      : `Unmark salary as paid for ${data.name}?`;
    if (!window.confirm(msg)) return;
    try {
      await api.post("/payroll/mark-paid", {
        user_id: data.user_id, period_start: data.period_start, period_end: data.period_end,
        paid, amount: data.final_salary_payout,
      });
      toast.success(paid ? "Salary marked as paid" : "Payment unmarked");
      setRefresh((r) => r + 1);
    } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3 print:hidden" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="bg-white w-full max-w-4xl max-h-[92vh] flex flex-col border border-gray-900">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 bg-gray-50">
          <div className="font-chivo font-black text-sm uppercase">{userMeta.name} — Salary Sheet</div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <select value={offset} onChange={(e) => setOffset(Number(e.target.value))}
              className="border border-gray-300 px-2 py-1.5 text-xs bg-white">
              <option value={0}>Current (running) cycle</option>
              <option value={-1}>Last completed cycle (payable now)</option>
              <option value={-2}>2 cycles back</option>
              <option value={-3}>3 cycles back</option>
            </select>
            <button onClick={() => setShowMoney((v) => !v)} data-testid="sheet-money-toggle"
              title={showMoney ? "Hide salary amounts" : "Show salary amounts"}
              className={`px-2.5 py-1.5 text-[10px] uppercase tracking-widest font-bold border flex items-center gap-1 ${showMoney ? "bg-[#E67E00] border-[#E67E00] text-white" : "border-gray-300 text-gray-600"}`}>
              {showMoney ? <Eye size={14} weight="bold" /> : <EyeSlash size={14} weight="bold" />}
              {showMoney ? "Salary shown" : "Salary hidden"}
            </button>
            <button onClick={() => setEditDays((v) => !v)} data-testid="sheet-edit-toggle"
              title="Edit attendance days without leaving this sheet"
              className={`px-2.5 py-1.5 text-[10px] uppercase tracking-widest font-bold border flex items-center gap-1 ${editDays ? "bg-[#002FA7] border-[#002FA7] text-white" : "border-gray-300 text-gray-600"}`}>
              <Pencil size={13} weight="bold" /> {editDays ? "Editing" : "Edit days"}
            </button>
            <button onClick={togglePaid} disabled={!data}
              className={`px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50 ${data?.payment?.paid ? "bg-emerald-600 text-white" : "border border-gray-300 text-gray-600 hover:border-emerald-600 hover:text-emerald-700"}`}>
              {data?.payment?.paid ? "✓ Salary Paid" : "Mark Salary Paid"}
            </button>
            <button onClick={() => data && onVoucher && onVoucher(data)} disabled={!data}
              title="Print A5 voucher for the employee to sign on receiving salary"
              className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50"
              data-testid="sheet-voucher-btn">
              <Receipt size={14} /> Voucher
            </button>
            <button onClick={() => data && onPrint(data)} disabled={!data}
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50">
              <Printer size={14} /> Print
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-900 text-sm font-bold px-1">✕</button>
          </div>
        </div>
        <div className="overflow-y-auto p-5">
          {loading ? (
            <div className="py-14 text-center"><Spinner size={26} className="animate-spin inline text-[#002FA7]" /></div>
          ) : data ? (
            <HideMoneyContext.Provider value={!showMoney}>
              {editDays && (
                <div className="mb-5 border border-[#002FA7] bg-[#F5F8FF] p-3">
                  <div className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7] mb-2">
                    Edit attendance — changes recalculate this sheet instantly
                  </div>
                  <DayGrid
                    p={data}
                    onOverride={async (uid, date, status) => { await onOverride?.(uid, date, status); bump(); }}
                    onEditPunch={async (uid, date, ci, co) => { await onEditPunch?.(uid, date, ci, co); bump(); }}
                    onClearPunchOut={async (uid, date, nm) => { await onClearPunchOut?.(uid, date, nm); bump(); }}
                  />
                </div>
              )}
              <SalarySheetContent p={data} />
            </HideMoneyContext.Provider>
          ) : (
            <div className="py-10 text-center text-sm text-gray-400">No data for this cycle</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ======================= TODAY (live attendance) ======================= */
function TodayTab() {
  const [data, setData] = useState(null);
  const load = async () => {
    try {
      const { data } = await api.get("/attendance/today");
      setData(data);
    } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  const clearOutToday = async (e) => {
    if (!window.confirm(`Remove ${e.name}'s punch-OUT for today (${data.date})?\n\nUse this when they punched out by mistake — they go back to "In Office" and start receiving leads again.`)) return;
    try {
      await api.post("/attendance/edit", { user_id: e.user_id, date: data.date, clear_check_out: true });
      toast.success(`${e.name} is back to In Office`);
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  if (!data) return <div className="py-14 text-center"><Spinner size={28} className="animate-spin inline text-[#002FA7]" /></div>;
  return (
    <div className="space-y-3">
      <div className="text-xs text-gray-500 font-semibold">
        {data.date} · Office is <b className={data.office_open ? "text-emerald-600" : "text-red-600"}>{data.office_open ? "OPEN" : "CLOSED"}</b> · refreshes every 30s
      </div>
      <div className="bg-white border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm text-left min-w-[700px]">
          <thead className="bg-gray-50 text-[10px] uppercase font-bold text-gray-500 border-b border-gray-200">
            <tr>
              <th className="px-4 py-2.5">Employee</th>
              <th className="px-4 py-2.5">Dept</th>
              <th className="px-4 py-2.5">Punch In</th>
              <th className="px-4 py-2.5">Punch Out</th>
              <th className="px-4 py-2.5 text-center">Status</th>
              <th className="px-4 py-2.5 text-center">Getting Leads?</th>
            </tr>
          </thead>
          <tbody>
            {data.employees.map((e) => (
              <tr key={e.user_id} className="border-t border-gray-100 hover:bg-gray-50/50">
                <td className="px-4 py-2.5">
                  <span className="font-semibold">{e.name}</span>
                  <span className="ml-1.5 text-[10px] text-gray-400 font-mono">{e.employee_code ? `#${e.employee_code}` : ""}</span>
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-500 capitalize">{e.department || e.role}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{e.check_in ? e.check_in.slice(11, 16) : "—"}</td>
                <td className="px-4 py-2.5 font-mono text-xs">
                  {e.check_out ? (
                    <span className="flex items-center gap-1.5">
                      {e.check_out.slice(11, 16)}
                      <button onClick={() => clearOutToday(e)} title="Punched out by mistake? Remove this punch-out"
                        className="text-gray-300 hover:text-[#E60000]" data-testid={`today-clear-out-${e.user_id}`}>
                        <XCircle size={14} weight="bold" />
                      </button>
                    </span>
                  ) : "—"}
                </td>
                <td className="px-4 py-2.5 text-center">
                  {e.on_leave ? <span className="px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-bold uppercase rounded-sm">On Leave</span>
                    : e.check_out ? <span className="px-2 py-0.5 bg-gray-100 text-gray-500 border border-gray-200 text-[10px] font-bold uppercase rounded-sm">Punched Out</span>
                    : e.check_in ? <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold uppercase rounded-sm">In Office</span>
                    : <span className="px-2 py-0.5 bg-red-50 text-red-600 border border-red-200 text-[10px] font-bold uppercase rounded-sm">Not In</span>}
                </td>
                <td className="px-4 py-2.5 text-center">
                  {e.available_for_leads == null ? <span className="text-gray-300 text-xs">n/a</span>
                    : e.available_for_leads ? <CheckCircle size={16} weight="fill" className="inline text-emerald-500" />
                    : <XCircle size={16} weight="fill" className="inline text-red-400" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ======================= HOLIDAYS ======================= */
function HolidaysTab() {
  const [holidays, setHolidays] = useState([]);
  const [form, setForm] = useState({ date: "", name: "", holiday_type: "full", early_off_time: "17:00" });

  const load = async () => {
    try {
      const { data } = await api.get("/holidays");
      setHolidays(data.sort((a, b) => b.date.localeCompare(a.date)));
    } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    try {
      await api.post("/holidays", { ...form, early_off_time: form.holiday_type === "early_off" ? form.early_off_time : null });
      toast.success(form.holiday_type === "full" ? "Holiday added (paid day for everyone)" : "Early-off day added");
      setForm({ date: "", name: "", holiday_type: "full", early_off_time: "17:00" });
      load();
    } catch (e2) { toast.error(errMsg(e2)); }
  };

  const remove = async (id) => {
    if (!window.confirm("Remove this holiday?")) return;
    try { await api.delete(`/holidays/${id}`); load(); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <form onSubmit={add} className="bg-white border border-gray-200 p-5 space-y-3 h-fit">
        <h3 className="font-bold text-xs uppercase tracking-wider text-gray-500">Declare Holiday / Early Off</h3>
        <input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}
          className="w-full border border-gray-300 px-2 py-2 text-sm bg-white" />
        <input type="text" required placeholder="Name (e.g. Diwali / Early closing)" value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="w-full border border-gray-300 px-2 py-2 text-sm bg-white" />
        <div className="flex gap-1">
          {[["full", "Full Day Holiday (paid)"], ["early_off", "Early Off (leave early, full pay)"]].map(([v, l]) => (
            <button type="button" key={v} onClick={() => setForm({ ...form, holiday_type: v })}
              className={`flex-1 text-[10px] uppercase tracking-wider font-bold px-2 py-2 border ${form.holiday_type === v ? "bg-[#002FA7] border-[#002FA7] text-white" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
              {l}
            </button>
          ))}
        </div>
        {form.holiday_type === "early_off" && (
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Allowed to leave from</label>
            <input type="time" required value={form.early_off_time} onChange={(e) => setForm({ ...form, early_off_time: e.target.value })}
              className="w-full border border-gray-300 px-2 py-2 text-sm bg-white" />
            <div className="text-[10px] text-gray-400 mt-1">Punch-outs at/after this time count as a full day.</div>
          </div>
        )}
        <button type="submit" className="w-full bg-[#002FA7] hover:bg-[#002288] text-white text-[11px] font-bold uppercase tracking-widest py-2.5">Add</button>
      </form>

      <div className="lg:col-span-2 bg-white border border-gray-200">
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="font-bold text-xs uppercase tracking-wider text-gray-500">Declared Holidays</h3>
        </div>
        <table className="w-full text-sm text-left">
          <thead className="bg-gray-50 text-[10px] uppercase font-bold text-gray-500 border-b border-gray-200">
            <tr><th className="px-4 py-2">Date</th><th className="px-4 py-2">Name</th><th className="px-4 py-2">Type</th><th className="px-4 py-2 text-right"></th></tr>
          </thead>
          <tbody>
            {holidays.map((h) => (
              <tr key={h.id} className="border-t border-gray-100 hover:bg-gray-50/50">
                <td className="px-4 py-2 font-mono text-xs font-bold">{h.date}</td>
                <td className="px-4 py-2 text-gray-700">{h.name}</td>
                <td className="px-4 py-2">
                  {(h.holiday_type || "full") === "full"
                    ? <span className="px-2 py-0.5 bg-violet-50 text-violet-700 border border-violet-200 text-[10px] font-bold uppercase rounded-sm">Full Day</span>
                    : <span className="px-2 py-0.5 bg-sky-50 text-sky-700 border border-sky-200 text-[10px] font-bold uppercase rounded-sm">Early Off {h.early_off_time}</span>}
                </td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => remove(h.id)} className="text-gray-400 hover:text-[#E60000] p-1"><Trash size={14} /></button>
                </td>
              </tr>
            ))}
            {holidays.length === 0 && <tr><td colSpan="4" className="px-4 py-6 text-center text-gray-400 text-sm">No holidays declared</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ======================= SETTINGS (rules + WFH pool) ======================= */
function SettingsTab() {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get("/attendance/settings");
      setCfg(data);
    } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const save = async (patch) => {
    setSaving(true);
    try {
      const { data } = await api.put("/attendance/settings", patch);
      setCfg({ ...data, all_users: cfg.all_users });
      toast.success("Rules updated");
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  // Emergency switch for when the punch-in device can't reach the cloud: while
  // ON, nobody is blocked from the CRM and leads keep routing to everyone.
  const toggleBypass = async (enable) => {
    if (enable && !window.confirm(
      "Turn OFF attendance checks for EVERYONE?\n\n" +
      "Use this only when the punch-in device / WiFi is down.\n" +
      "While it is on, all executives can log in and receive leads even without punching in.\n\n" +
      "Remember to turn it back off once the device is working."
    )) return;
    setSaving(true);
    try {
      const { data } = await api.post("/attendance/bypass", { enabled: enable });
      setCfg({ ...data, all_users: cfg.all_users });
      toast.success(enable ? "Attendance bypassed for everyone" : "Attendance checks back ON");
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  if (!cfg) return <div className="py-14 text-center"><Spinner size={28} className="animate-spin inline text-[#002FA7]" /></div>;

  const execs = (cfg.all_users || []).filter((u) => u.role === "executive");
  const pool = cfg.wfh_pool_user_ids || [];
  const togglePool = (id) => {
    const next = pool.includes(id) ? pool.filter((x) => x !== id) : [...pool, id];
    save({ wfh_pool_user_ids: next });
  };

  const Row = ({ label, hint, children }) => (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-gray-100">
      <div>
        <div className="text-sm font-semibold text-gray-800">{label}</div>
        {hint && <div className="text-[11px] text-gray-400 mt-0.5 max-w-md">{hint}</div>}
      </div>
      {children}
    </div>
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl">
      <div className="bg-white border border-gray-200 p-5">
        <h3 className="font-bold text-xs uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
          <Gear size={15} className="text-[#002FA7]" /> Attendance Rules
        </h3>

        {cfg.attendance_bypass_all ? (
          <div className="mb-4 border-2 border-amber-500 bg-amber-50 p-3">
            <div className="flex items-start gap-2">
              <Warning size={18} weight="fill" className="text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-amber-900">Attendance bypassed for everyone</div>
                <div className="text-[11px] text-amber-800 mt-0.5 leading-relaxed">
                  Nobody is blocked from the CRM and leads route to all executives, punched in or not.
                  {cfg.bypass_enabled_by && <> Turned on by <b>{cfg.bypass_enabled_by}</b></>}
                  {cfg.bypass_enabled_at && <> on {new Date(cfg.bypass_enabled_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</>}.
                  <br />Punches are still <b>not</b> recorded &mdash; adjust payroll for these days once the device is back.
                  <br />This switch is for <b>today only</b>: it turns itself off at midnight. If the device is still down tomorrow, turn it on again.
                </div>
                <button onClick={() => toggleBypass(false)} disabled={saving}
                  className="mt-2 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50">
                  Turn bypass off
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mb-4 border border-dashed border-gray-300 p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-800">Punch-in device down?</div>
              <div className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">
                Bypass attendance for everyone so nobody is locked out and leads keep flowing. Lasts for today only &mdash; it switches itself off at midnight.
              </div>
            </div>
            <button onClick={() => toggleBypass(true)} disabled={saving}
              className="shrink-0 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border border-amber-500 text-amber-700 hover:bg-amber-50 disabled:opacity-50">
              Bypass all
            </button>
          </div>
        )}
        <Row label="Office timing" hint="Mon–Sat. Arrivals after start are 'late'; allowed till the grace time without penalty.">
          <div className="flex items-center gap-1 font-mono text-sm">
            <input type="time" value={cfg.office_start} onChange={(e) => save({ office_start: e.target.value })} className="border border-gray-300 px-1.5 py-1 text-xs" />
            <span className="text-gray-400">→</span>
            <input type="time" value={cfg.office_end} onChange={(e) => save({ office_end: e.target.value })} className="border border-gray-300 px-1.5 py-1 text-xs" />
          </div>
        </Row>
        <Row label="Arrival allowed till" hint="Coming after this time raises an admin flag (no salary cut).">
          <input type="time" value={cfg.late_grace_until} onChange={(e) => save({ late_grace_until: e.target.value })} className="border border-gray-300 px-1.5 py-1 text-xs font-mono" />
        </Row>
        <Row label="Half-day cutoff" hint="Leaving after this = half day. Leaving before this = full day cut.">
          <input type="time" value={cfg.half_day_cutoff} onChange={(e) => save({ half_day_cutoff: e.target.value })} className="border border-gray-300 px-1.5 py-1 text-xs font-mono" />
        </Row>
        <Row label="Late streak flag" hint="Flag admin when someone comes after office start this many working days in a row.">
          <input type="number" min={2} max={10} value={cfg.late_streak_threshold}
            onChange={(e) => save({ late_streak_threshold: Number(e.target.value) })}
            className="border border-gray-300 px-2 py-1 text-sm w-16 text-center" />
        </Row>
        <Row label="Reassign stale 'new' leads after (days)" hint="Leads still marked New get re-distributed round-robin after this many days.">
          <input type="number" min={1} max={14} value={cfg.stale_new_days}
            onChange={(e) => save({ stale_new_days: Number(e.target.value) })}
            className="border border-gray-300 px-2 py-1 text-sm w-16 text-center" />
        </Row>
        <Row label="Attendance-based lead routing" hint="When ON, executives who haven't punched in (or punched out early) get no new leads.">
          <button onClick={() => save({ attendance_routing_enabled: !cfg.attendance_routing_enabled })}
            className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border ${cfg.attendance_routing_enabled ? "bg-emerald-600 border-emerald-600 text-white" : "border-gray-300 text-gray-500"}`}>
            {cfg.attendance_routing_enabled ? "Enabled" : "Disabled"}
          </button>
        </Row>
      </div>

      <div className="bg-white border border-gray-200 p-5 h-fit">
        <h3 className="font-bold text-xs uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-1.5">
          <UsersThree size={15} className="text-[#002FA7]" /> After-Hours WFH Pool
        </h3>
        <div className="text-[11px] text-gray-400 mb-3 leading-relaxed">
          Outside office hours (evenings, Sundays, holidays) new leads are assigned <b>only</b> to these executives
          (e.g. Ankita &amp; Anmol working from home).
        </div>
        <div className="space-y-1">
          {execs.map((u) => (
            <label key={u.id} className="flex items-center gap-2.5 px-2 py-1.5 hover:bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={pool.includes(u.id)} onChange={() => togglePool(u.id)}
                className="accent-[#002FA7]" disabled={saving} />
              <span className="text-sm font-medium">{u.name}</span>
              <span className="text-[10px] text-gray-400 font-mono">@{u.username}</span>
            </label>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t border-gray-100">
          <button onClick={() => save({ wfh_afterhours_enabled: !cfg.wfh_afterhours_enabled })}
            className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border ${cfg.wfh_afterhours_enabled ? "bg-emerald-600 border-emerald-600 text-white" : "border-gray-300 text-gray-500"}`}>
            After-hours assignment: {cfg.wfh_afterhours_enabled ? "ON" : "OFF"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PrintStyles({ a5 = false }) {
  return (
    <style>{`
      @media print {
        body { background: white !important; color: black !important; }
        #root { margin: 0 !important; padding: 0 !important; }
        header, nav, aside, footer { display: none !important; }
        .border { border-color: #ddd !important; }
        .shadow-sm, .shadow-lg { box-shadow: none !important; }
      }
      ${a5 ? `
      /* Salary voucher prints on A5 — everything else is hidden */
      @page { size: A5 portrait; margin: 8mm; }
      @media print {
        body * { visibility: hidden !important; }
        .voucher-page, .voucher-page * { visibility: visible !important; }
        .voucher-page { position: absolute; left: 0; top: 0; width: 100%; }
        .voucher-page .border-2, .voucher-page .border { border-color: #000 !important; }
      }` : `@page { size: A4; margin: 10mm; }`}
    `}</style>
  );
}
