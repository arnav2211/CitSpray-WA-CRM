import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { Plus, Trash, UserMinus, ClockCounterClockwise, Warning, Calendar } from "@phosphor-icons/react";
import { EmployeeSheetModal, PrintSheet, SalaryVoucher, PrintStyles } from "./Payroll";

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deletingUser, setDeletingUser] = useState(null);
  const [offboarding, setOffboarding] = useState(null);
  // "Previous employees" panel state lives in the URL so Payroll can deep-link to it
  const [params, setParams] = useSearchParams();
  const showFormer = params.get("former") === "1";
  const setShowFormer = (v) => setParams(v ? { former: "1" } : {});

  const load = async () => {
    try { const { data } = await api.get("/users"); setUsers(data); } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const del = async (id) => {
    const targetUser = users.find(u => u.id === id);
    if (!targetUser) return;
    
    if (targetUser.role === "executive") {
      setDeletingUser(targetUser);
    } else {
      if (!window.confirm(`Delete ${targetUser.name}?`)) return;
      try {
        await api.delete(`/users/${id}`);
        toast.success("Deleted");
        load();
      } catch (e) {
        toast.error(errMsg(e));
      }
    }
  };

  const toggleActive = async (u) => {
    try { await api.patch(`/users/${u.id}`, { active: !u.active }); load(); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="p-4 md:p-8 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Team</div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Executives</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setShowFormer(!showFormer)}
            className={`px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 border ${showFormer ? "bg-gray-900 border-gray-900 text-white" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
            data-testid="former-toggle">
            <ClockCounterClockwise size={12} weight="bold" /> Previous employees
          </button>
          <button onClick={() => setShowNew(true)} className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="add-user-btn">
            <Plus size={12} weight="bold" /> Add User
          </button>
        </div>
      </div>

      {showFormer && <FormerEmployeesPanel onClose={() => setShowFormer(false)} />}

      {/* Mobile: card list */}
      <div className="md:hidden space-y-2">
        {users.map((u) => (
          <div key={u.id} className="border border-gray-200 bg-white p-3" data-testid={`user-card-${u.username}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold truncate">{u.name}</div>
                <div className="text-xs font-mono text-gray-500">@{u.username}</div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className="kbd">{u.role}</span>
                <span className={`text-[9px] uppercase tracking-widest font-bold ${u.company === "fragvansh" ? "text-[#7C3AED]" : "text-[#002FA7]"}`}>
                  {u.company === "fragvansh" ? "Fragvansh" : "CitSpray"}
                </span>
              </div>
            </div>
            <div className="text-xs text-gray-600 mt-2">
              {(u.working_hours || []).length === 0 ? "Always available" :
                u.working_hours.slice(0, 3).map((w, i) => <span key={i} className="inline-block mr-2">{WEEK[w.weekday]} {w.start}-{w.end}</span>)}
              {(u.working_hours || []).length > 3 && <span className="text-gray-400">+{u.working_hours.length - 3}</span>}
            </div>
            <div className="flex items-center justify-between mt-3">
              <button onClick={() => toggleActive(u)} className={`text-[10px] uppercase tracking-widest font-bold ${u.active ? "text-[#008A00]" : "text-[#E60000]"}`} data-testid={`toggle-active-mobile-${u.username}`}>
                {u.active ? "Active" : "Inactive"}
              </button>
              <div className="flex items-center gap-3">
                <button onClick={() => setEditing(u)} className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7]" data-testid={`edit-user-mobile-${u.username}`}>Edit</button>
                {u.role !== "admin" && (
                  <button onClick={() => setOffboarding(u)} title="Fired / resigned — remove from the team, keep attendance history"
                    className="text-[10px] uppercase tracking-widest font-bold text-[#E60000] flex items-center gap-1" data-testid={`offboard-user-mobile-${u.username}`}>
                    <UserMinus size={13} weight="bold" /> Fire / Resign
                  </button>
                )}
                {u.role !== "admin" && <button onClick={() => del(u.id)} className="text-[#E60000]" data-testid={`delete-user-mobile-${u.username}`}><Trash size={14} /></button>}
              </div>
            </div>
          </div>
        ))}
        {users.length === 0 && <div className="text-xs text-gray-400 text-center py-8">No users yet</div>}
      </div>

      {/* Desktop: table */}
      <div className="hidden md:block border border-gray-200 bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
            <tr>
              <th className="text-left px-4 py-3">Name</th>
              <th className="text-left px-4 py-3">Username</th>
              <th className="text-left px-4 py-3">Role</th>
              <th className="text-left px-4 py-3">Company</th>
              <th className="text-left px-4 py-3">Working Hours</th>
              <th className="text-left px-4 py-3">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-gray-200 hover:bg-gray-50" data-testid={`user-row-${u.username}`}>
                <td className="px-4 py-3 font-semibold">{u.name}</td>
                <td className="px-4 py-3 font-mono text-xs">@{u.username}</td>
                <td className="px-4 py-3"><span className="kbd">{u.role}</span></td>
                <td className="px-4 py-3">
                  <span className={`text-[10px] uppercase tracking-widest font-bold ${u.company === "fragvansh" ? "text-[#7C3AED]" : "text-[#002FA7]"}`}
                    data-testid={`user-company-${u.username}`}>
                    {u.company === "fragvansh" ? "Fragvansh" : "CitSpray"}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  {(u.working_hours || []).length === 0 ? "Always available" :
                    u.working_hours.map((w, i) => <span key={i} className="inline-block mr-2">{WEEK[w.weekday]} {w.start}-{w.end}</span>)}
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => toggleActive(u)} className={`text-[10px] uppercase tracking-widest font-bold ${u.active ? "text-[#008A00]" : "text-[#E60000]"}`} data-testid={`toggle-active-${u.username}`}>
                    {u.active ? "Active" : "Inactive"}
                  </button>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => setEditing(u)} className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7]" data-testid={`edit-user-${u.username}`}>Edit</button>
                  {u.role !== "admin" && (
                    <button onClick={() => setOffboarding(u)} title="Fired / resigned — remove from the team, keep attendance history"
                      className="text-[10px] uppercase tracking-widest font-bold text-[#E60000] inline-flex items-center gap-1 align-middle" data-testid={`offboard-user-${u.username}`}>
                      <UserMinus size={13} weight="bold" /> Fire / Resign
                    </button>
                  )}
                  {u.role !== "admin" && <button onClick={() => del(u.id)} className="text-[#E60000]" title="Delete permanently (no history kept)" data-testid={`delete-user-${u.username}`}><Trash size={14} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(showNew || editing) && (
        <UserModal user={editing} onClose={() => { setShowNew(false); setEditing(null); }} onSaved={() => { setShowNew(false); setEditing(null); load(); }} />
      )}

      {deletingUser && (
        <DeleteUserReassignModal
          user={deletingUser}
          users={users}
          onClose={() => setDeletingUser(null)}
          onDeleted={() => { setDeletingUser(null); load(); }}
        />
      )}

      {offboarding && (
        <OffboardModal
          user={offboarding}
          users={users}
          onClose={() => setOffboarding(null)}
          onDone={() => { setOffboarding(null); load(); }}
        />
      )}
    </div>
  );
}

/* ---------------- Fire / Resign: two warnings, then the backend does the clean-up ---------------- */
function OffboardModal({ user, users, onClose, onDone }) {
  const [step, setStep] = useState(1);
  const [reason, setReason] = useState("resigned");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const company = user.company || "citspray";
  const companyName = company === "fragvansh" ? "Fragvansh" : "CitSpray";
  const isExec = user.role === "executive";
  const others = users.filter((x) => x.role === "executive" && x.active && x.id !== user.id &&
    x.username !== "test_user" && (x.company || "citspray") === company);
  const keepUntil = new Date(); keepUntil.setFullYear(keepUntil.getFullYear() + 1);
  const keepUntilStr = keepUntil.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const verb = reason === "fired" ? "fire" : "remove";

  const confirm = async () => {
    setLoading(true);
    try {
      const { data } = await api.post(`/users/${user.id}/offboard`, { reason, note, confirm: true });
      const bits = [];
      if (data.leads_reassigned) bits.push(`${data.leads_reassigned} leads split between ${(data.targets || []).join(", ")}`);
      if (data.leads_unassigned) bits.push(`${data.leads_unassigned} leads are now unassigned`);
      if (data.followups_moved) bits.push(`${data.followups_moved} follow-ups moved`);
      toast.success(`${user.name} removed from the team${bits.length ? ". " + bits.join("; ") : ""}`, { duration: 9000 });
      onDone();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg bg-white border border-gray-900 p-6 max-h-[90vh] overflow-y-auto" data-testid="offboard-modal">
        {step === 1 ? (
          <>
            <div className="text-[10px] uppercase tracking-widest text-[#E60000] font-bold">Warning 1 of 2 · Fire / Resign</div>
            <h2 className="font-chivo font-black text-2xl mt-1 mb-1">Remove {user.name} from the team?</h2>
            <div className="text-xs text-gray-500 mb-4">@{user.username} · {user.role}{user.department ? ` · ${user.department}` : ""}{user.employee_code ? ` · machine ID ${user.employee_code}` : ""} · {companyName}</div>

            <div className="flex gap-2 mb-3">
              {[["resigned", "Resigned"], ["fired", "Fired"]].map(([k, label]) => (
                <button key={k} type="button" onClick={() => setReason(k)}
                  className={`flex-1 py-2 text-[10px] uppercase tracking-widest font-bold border ${reason === k ? "bg-gray-900 border-gray-900 text-white" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
                  data-testid={`offboard-reason-${k}`}>
                  {label}
                </button>
              ))}
            </div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the record (optional) — e.g. last working day, reason"
              className="w-full border border-gray-300 px-3 py-2 text-sm mb-4" rows={2} />

            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">What happens now</div>
            <ul className="text-sm text-gray-700 space-y-1.5 mb-5 list-disc pl-5">
              <li>Login is blocked immediately and they disappear from every list, dropdown, round-robin and WFH pool.</li>
              {isExec && (others.length > 0
                ? <li>All their leads and pending follow-ups are split equally between <b>{others.map((o) => o.name).join(", ")}</b>.</li>
                : <li className="text-[#B85F00] font-semibold">No other active executive in {companyName}: their leads become <b>unassigned</b> until you assign them to someone.</li>)}
              <li>Attendance and salary history stay under <b>Previous employees</b> until <b>{keepUntilStr}</b> (12 months), then are deleted automatically.</li>
            </ul>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100">Cancel</button>
              <button type="button" onClick={() => setStep(2)} className="border border-[#E60000] text-[#E60000] hover:bg-red-50 px-4 py-2 text-[10px] uppercase tracking-widest font-bold" data-testid="offboard-continue">
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-[10px] uppercase tracking-widest text-[#E60000] font-bold">Warning 2 of 2 · Final</div>
            <div className="mt-2 border-2 border-[#E60000] bg-red-50 p-4 flex gap-3">
              <Warning size={26} weight="fill" className="text-[#E60000] shrink-0" />
              <div>
                <div className="font-chivo font-black text-lg text-[#B00000] leading-tight">Are you sure you want to {verb} {user.name}?</div>
                <div className="text-sm text-[#7A0000] mt-1.5">
                  This runs immediately. {isExec && others.length > 0 ? "Their leads will already be with other executives — " : ""}
                  the only way back is <b>Re-activate</b> under Previous employees, and that does not return any leads.
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={() => setStep(1)} disabled={loading} className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100">No, go back</button>
              <button type="button" onClick={confirm} disabled={loading} className="bg-[#E60000] hover:bg-[#CC0000] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="offboard-confirm">
                {loading ? "Removing…" : `Yes, ${verb} ${user.name}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- Previous employees: history kept 12 months, same salary sheet as Payroll ---------------- */
function FormerEmployeesPanel({ onClose }) {
  const [rows, setRows] = useState(null);
  const [sheetUser, setSheetUser] = useState(null);
  const [printTarget, setPrintTarget] = useState(null);
  const [printData, setPrintData] = useState(null);

  const load = async () => {
    try { const { data } = await api.get("/users/former"); setRows(data); } catch (e) { toast.error(errMsg(e)); setRows([]); }
  };
  useEffect(() => { load(); }, []);

  const doPrint = (target, data) => {
    setPrintData(data); setPrintTarget(target);
    setTimeout(() => { window.print(); setTimeout(() => setPrintTarget(null), 500); }, 150);
  };
  const override = async (userId, date, status) => {
    try { await api.post("/payroll/adjust", { user_id: userId, date, status }); toast.success("Day updated"); } catch (e) { toast.error(errMsg(e)); }
  };
  const editPunch = async (userId, date, checkIn, checkOut) => {
    try { await api.post("/attendance/edit", { user_id: userId, date, check_in: checkIn || null, check_out: checkOut || null }); toast.success("Punch updated"); } catch (e) { toast.error(errMsg(e)); }
  };
  const clearPunchOut = async (userId, date) => {
    try { await api.post("/attendance/edit", { user_id: userId, date, clear_check_out: true }); toast.success("Punch-out cleared"); } catch (e) { toast.error(errMsg(e)); }
  };
  const rehire = async (u) => {
    if (!window.confirm(`Re-activate ${u.name}? They come back to the team with no leads assigned.`)) return;
    try { await api.patch(`/users/${u.id}`, { active: true }); toast.success(`${u.name} is back on the team`); load(); } catch (e) { toast.error(errMsg(e)); }
  };
  const d = (s) => (s ? new Date(s.length > 10 ? s : s + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");

  return (
    <div className="border border-gray-900 bg-white" data-testid="former-panel">
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-gray-200 bg-gray-50">
        <div>
          <div className="font-chivo font-black text-sm uppercase flex items-center gap-1.5"><ClockCounterClockwise size={15} /> Previous employees</div>
          <div className="text-[11px] text-gray-500 mt-0.5">Fired or resigned. Attendance &amp; salary history is kept for 12 months after leaving, then deleted automatically. They receive no leads and appear nowhere else.</div>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-900 text-sm font-bold px-1">✕</button>
      </div>
      {rows === null ? (
        <div className="p-6 text-xs text-gray-400">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-xs text-gray-400">Nobody has been removed yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
              <tr>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-left px-4 py-2">Role</th>
                <th className="text-left px-4 py-2">Machine ID</th>
                <th className="text-left px-4 py-2">Joined</th>
                <th className="text-left px-4 py-2">Left</th>
                <th className="text-left px-4 py-2">Attendance</th>
                <th className="text-left px-4 py-2">Records kept until</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="border-t border-gray-200 hover:bg-gray-50" data-testid={`former-row-${u.username}`}>
                  <td className="px-4 py-2">
                    <div className="font-semibold">{u.name}</div>
                    <div className="text-[10px] font-mono text-gray-400">@{u.username} · {u.company === "fragvansh" ? "Fragvansh" : "CitSpray"}</div>
                  </td>
                  <td className="px-4 py-2 text-xs">{u.role}{u.department ? <span className="text-gray-400"> · {u.department}</span> : null}</td>
                  <td className="px-4 py-2 font-mono text-xs">{u.employee_code || "—"}</td>
                  <td className="px-4 py-2 text-xs">{d(u.joining_date)}</td>
                  <td className="px-4 py-2 text-xs">
                    {d(u.left_at)}
                    <span className={`ml-1.5 text-[9px] uppercase tracking-widest font-bold ${u.left_reason === "fired" ? "text-[#E60000]" : "text-gray-500"}`}>{u.left_reason || "left"}</span>
                    {u.left_note && <div className="text-[10px] text-gray-400 max-w-[220px] truncate" title={u.left_note}>{u.left_note}</div>}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {u.attendance_days ? <>{u.attendance_days} days <span className="text-gray-400">({d(u.attendance_first)} → {d(u.attendance_last)})</span></> : <span className="text-gray-400">none</span>}
                  </td>
                  <td className="px-4 py-2 text-xs">{d(u.retain_until)}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap space-x-3">
                    <button onClick={() => setSheetUser({ user_id: u.id, name: u.name, joining_date: u.joining_date })}
                      className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7] inline-flex items-center gap-1" data-testid={`former-sheet-${u.username}`}>
                      <Calendar size={13} weight="bold" /> Attendance &amp; salary
                    </button>
                    <button onClick={() => rehire(u)} className="text-[10px] uppercase tracking-widest font-bold text-gray-500 hover:text-gray-900">Re-activate</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sheetUser && (
        <EmployeeSheetModal
          userMeta={sheetUser}
          onClose={() => setSheetUser(null)}
          onPrint={(data) => doPrint("sheet", data)}
          onVoucher={(data) => doPrint("voucher", data)}
          onOverride={override}
          onEditPunch={editPunch}
          onClearPunchOut={clearPunchOut}
        />
      )}
      {printTarget === "sheet" && printData && <PrintSheet p={printData} />}
      {printTarget === "voucher" && printData && <SalaryVoucher p={printData} />}
      {printTarget && <PrintStyles a5={printTarget === "voucher"} />}
    </div>
  );
}

function UserModal({ user, onClose, onSaved }) {
  const isEdit = Boolean(user);
  const [f, setF] = useState({
    username: user?.username || "",
    name: user?.name || "",
    password: "",
    role: user?.role || "executive",
    active: user?.active ?? true,
    working_hours: user?.working_hours || [],
    joining_date: user?.joining_date || new Date().toISOString().split("T")[0],
    base_salary: user?.base_salary || 0,
    bypass_attendance: user?.bypass_attendance ?? false,
    employee_code: user?.employee_code || "",
    department: user?.department || "",
    company: user?.company || "citspray",
  });
  const [loading, setLoading] = useState(false);

  const addSlot = () => setF({ ...f, working_hours: [...f.working_hours, { weekday: 1, start: "09:00", end: "18:00" }] });
  const removeSlot = (i) => setF({ ...f, working_hours: f.working_hours.filter((_, idx) => idx !== i) });
  const updSlot = (i, patch) => setF({ ...f, working_hours: f.working_hours.map((s, idx) => idx === i ? { ...s, ...patch } : s) });

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (isEdit) {
        const body = { 
          name: f.name, 
          role: f.role, 
          active: f.active, 
          working_hours: f.working_hours, 
          joining_date: f.joining_date, 
          base_salary: Number(f.base_salary),
          bypass_attendance: f.bypass_attendance,
          employee_code: f.employee_code || null,
          department: f.department || null,
          company: f.company
        };
        if (f.password) body.password = f.password;
        await api.patch(`/users/${user.id}`, body);
      } else {
        await api.post("/users", { ...f, base_salary: Number(f.base_salary), employee_code: f.employee_code || null, department: f.department || null });
      }
      toast.success("Saved"); onSaved();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-2xl bg-white border border-gray-900 p-6 max-h-[90vh] overflow-y-auto" data-testid="user-modal">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{isEdit ? "Edit" : "Create"}</div>
          <h2 className="font-chivo font-black text-2xl mt-1 mb-4">{isEdit ? "Edit User" : "New Executive"}</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Username *">
              <input required disabled={isEdit} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100" data-testid="user-username-input" />
            </Field>
            <Field label="Full Name *">
              <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="user-name-input" />
            </Field>
            <Field label={isEdit ? "New Password (optional)" : "Password *"}>
              <input type="password" required={!isEdit} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="user-password-input" />
            </Field>
            <Field label="Role">
              <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} className="w-full border border-gray-300 px-2 py-2 text-sm" data-testid="user-role-select">
                <option value="executive">executive (telecalling)</option>
                <option value="staff">staff (packing / accounts / media…)</option>
                <option value="data_entry">data entry</option>
                <option value="admin">admin</option>
              </select>
            </Field>
            <Field label="Company">
              <select value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} className="w-full border border-gray-300 px-2 py-2 text-sm" data-testid="user-company-select">
                <option value="citspray">CitSpray</option>
                <option value="fragvansh">Fragvansh</option>
              </select>
              <div className="text-[10px] text-gray-400 mt-1">Executives only see and receive this company's leads. Admins see both via the sidebar switcher.</div>
            </Field>

            {f.role !== "admin" && (
              <>
                <Field label="Department">
                  <input type="text" list="dept-suggestions" placeholder="telecalling / packing / accounts / media…" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" />
                  <datalist id="dept-suggestions">
                    <option value="telecalling" /><option value="packing" /><option value="accounts" /><option value="media" />
                  </datalist>
                </Field>
                <Field label="Joining Date">
                  <input type="date" value={f.joining_date} onChange={(e) => setF({ ...f, joining_date: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" />
                </Field>
                <Field label="Monthly Base Salary (₹)">
                  <input type="number" value={f.base_salary} onChange={(e) => setF({ ...f, base_salary: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" />
                </Field>
                <Field label="Fingerprint Device ID / Code">
                  <input type="text" placeholder="e.g. 5 (user ID in the attendance machine)" value={f.employee_code} onChange={(e) => setF({ ...f, employee_code: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" />
                </Field>
                <div className="flex flex-col justify-center">
                  <div className="flex items-center gap-2 py-2">
                    <input type="checkbox" id="bypass_attendance" checked={f.bypass_attendance} onChange={(e) => setF({ ...f, bypass_attendance: e.target.checked })} className="rounded border-gray-300 text-[#002FA7] focus:ring-[#002FA7]" />
                    <label htmlFor="bypass_attendance" className="text-xs font-semibold text-gray-700 cursor-pointer">Bypass Attendance Check (always gets leads)</label>
                  </div>
                </div>
                {/* Biometric facial data registration removed */}
              </>
            )}
          </div>

          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Working Hours</div>
              <button type="button" onClick={addSlot} className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7]" data-testid="add-slot-btn">+ Add slot</button>
            </div>
            <div className="space-y-2">
              {f.working_hours.map((w, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select value={w.weekday} onChange={(e) => updSlot(i, { weekday: Number(e.target.value) })} className="border border-gray-300 px-2 py-2 text-sm">
                    {WEEK.map((d, idx) => <option key={idx} value={idx}>{d}</option>)}
                  </select>
                  <input type="time" value={w.start} onChange={(e) => updSlot(i, { start: e.target.value })} className="border border-gray-300 px-2 py-2 text-sm" />
                  <span className="text-xs">to</span>
                  <input type="time" value={w.end} onChange={(e) => updSlot(i, { end: e.target.value })} className="border border-gray-300 px-2 py-2 text-sm" />
                  <button type="button" onClick={() => removeSlot(i)} className="text-[#E60000]"><Trash size={14} /></button>
                </div>
              ))}
              {f.working_hours.length === 0 && <div className="text-xs text-gray-400 uppercase tracking-widest">No slots — always available</div>}
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <button type="button" onClick={onClose} className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100">Cancel</button>
            <button disabled={loading} className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="user-save-btn">
              {loading ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>

    </>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">{label}</div>
      {children}
    </label>
  );
}

function DeleteUserReassignModal({ user, users, onClose, onDeleted }) {
  const [strategy, setStrategy] = useState("all_equally");
  const [singleAgentId, setSingleAgentId] = useState("");
  const [multipleAgentIds, setMultipleAgentIds] = useState([]);
  const [loading, setLoading] = useState(false);

  const activeExecs = users.filter((u) => u.role === "executive" && u.active && u.id !== user.id);

  const handleCheckboxChange = (id) => {
    setMultipleAgentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    if (strategy === "single" && !singleAgentId) {
      toast.error("Please select a single executive to reassign leads.");
      return;
    }
    if (strategy === "multiple" && multipleAgentIds.length === 0) {
      toast.error("Please select at least one executive to reassign leads.");
      return;
    }

    setLoading(true);
    try {
      const params = {
        strategy,
        single_agent_id: strategy === "single" ? singleAgentId : undefined,
        multiple_agent_ids: strategy === "multiple" ? multipleAgentIds.join(",") : undefined,
      };
      await api.delete(`/users/${user.id}`, { params });
      toast.success("Executive deleted and leads reassigned!");
      onDeleted();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-lg bg-white border border-gray-900 p-6 max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in-95 duration-150"
        data-testid="delete-reassign-modal"
      >
        <div className="text-[10px] uppercase tracking-widest text-[#E60000] font-bold">Delete Executive</div>
        <h2 className="font-chivo font-black text-2xl mt-1 mb-2">Delete {user.name}</h2>
        <p className="text-sm text-gray-600 mb-6 font-chivo">
          This user is an executive. To whom would you like to reassign their currently assigned leads?
        </p>

        {activeExecs.length === 0 ? (
          <div className="bg-[#FFF4E5] border border-[#E67E00] text-[#B85F00] text-xs p-3 mb-6 font-semibold">
            Warning: No other active executives are available. All leads assigned to {user.name} will become unassigned.
          </div>
        ) : (
          <div className="space-y-4 mb-6">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="strategy"
                value="all_equally"
                checked={strategy === "all_equally"}
                onChange={(e) => setStrategy(e.target.value)}
                className="mt-1 text-[#002FA7] focus:ring-[#002FA7]"
              />
              <div>
                <span className="text-sm font-semibold">Reassign equally among all active executives</span>
                <p className="text-xs text-gray-500">Distributes leads evenly and randomly to all other {activeExecs.length} active executive(s).</p>
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="strategy"
                value="single"
                checked={strategy === "single"}
                onChange={(e) => setStrategy(e.target.value)}
                className="mt-1 text-[#002FA7] focus:ring-[#002FA7]"
              />
              <div className="flex-1">
                <span className="text-sm font-semibold">Reassign to one agent</span>
                <p className="text-xs text-gray-500 mb-2">Transfer all leads to a single chosen executive.</p>
                {strategy === "single" && (
                  <select
                    required
                    value={singleAgentId}
                    onChange={(e) => setSingleAgentId(e.target.value)}
                    className="w-full border border-gray-300 px-2 py-2 text-sm bg-white outline-none focus:border-[#002FA7] focus:ring-1 focus:ring-[#002FA7]"
                  >
                    <option value="">— Select Executive —</option>
                    {activeExecs.map((ae) => (
                      <option key={ae.id} value={ae.id}>
                        {ae.name} (@{ae.username})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="strategy"
                value="multiple"
                checked={strategy === "multiple"}
                onChange={(e) => setStrategy(e.target.value)}
                className="mt-1 text-[#002FA7] focus:ring-[#002FA7]"
              />
              <div className="flex-1">
                <span className="text-sm font-semibold">Reassign to multiple selected agents equally</span>
                <p className="text-xs text-gray-500 mb-2">Equally (and randomly) distribute leads among specific executives.</p>
                {strategy === "multiple" && (
                  <div className="border border-gray-200 p-3 max-h-[150px] overflow-y-auto space-y-2 bg-gray-50 rounded-sm">
                    {activeExecs.map((ae) => (
                      <label key={ae.id} className="flex items-center gap-2 cursor-pointer text-xs font-semibold">
                        <input
                           type="checkbox"
                           checked={multipleAgentIds.includes(ae.id)}
                           onChange={() => handleCheckboxChange(ae.id)}
                           className="text-[#002FA7] focus:ring-[#002FA7]"
                        />
                        <span>{ae.name} (@{ae.username})</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="strategy"
                value="none"
                checked={strategy === "none"}
                onChange={(e) => setStrategy(e.target.value)}
                className="mt-1 text-[#002FA7] focus:ring-[#002FA7]"
              />
              <div>
                <span className="text-sm font-semibold">Leave leads unassigned</span>
                <p className="text-xs text-gray-500">Remove executive assignment, leaving leads unassigned.</p>
              </div>
            </label>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100 transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={loading}
            className="bg-[#E60000] hover:bg-[#CC0000] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50 transition-colors"
          >
            {loading ? "Deleting & Reassigning…" : "Delete Executive"}
          </button>
        </div>
      </form>
    </div>
  );
}
