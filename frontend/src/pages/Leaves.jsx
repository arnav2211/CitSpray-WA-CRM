import React, { useEffect, useMemo, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import {
  CalendarBlank, PaperPlaneRight, CheckCircle, XCircle, Clock, Trash, Plus, Spinner,
} from "@phosphor-icons/react";

const chip = (status) => {
  const map = {
    pending: "bg-amber-50 text-amber-700 border-amber-200",
    approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rejected: "bg-red-50 text-red-700 border-red-200",
  };
  return `inline-flex items-center gap-1 px-2 py-0.5 border text-[10px] font-bold uppercase tracking-wider rounded-sm ${map[status] || map.approved}`;
};

const StatusIcon = ({ status }) =>
  status === "pending" ? <Clock size={12} weight="fill" /> :
  status === "rejected" ? <XCircle size={12} weight="fill" /> :
  <CheckCircle size={12} weight="fill" />;

function daysBetween(a, b) {
  try {
    return Math.round((new Date(b) - new Date(a)) / 86400000) + 1;
  } catch { return "?"; }
}

/* ---------------- Executive view: apply + my leaves ---------------- */
function MyLeaves() {
  const [leaves, setLeaves] = useState([]);
  const [form, setForm] = useState({ start_date: "", end_date: "", reason: "" });
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const { data } = await api.get("/leaves/my");
      setLeaves(data);
    } catch (e) {
      toast.error(errMsg(e, "Failed to load leaves"));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.start_date || !form.end_date) return;
    setSubmitting(true);
    try {
      await api.post("/leaves/apply", form);
      toast.success("Leave request sent to admin for approval");
      setForm({ start_date: "", end_date: "", reason: "" });
      load();
    } catch (e) {
      toast.error(errMsg(e, "Could not apply for leave"));
    } finally { setSubmitting(false); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="bg-white border border-gray-200 p-5 space-y-4 h-fit">
        <h3 className="font-bold text-xs uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
          <CalendarBlank size={16} className="text-[#002FA7]" /> Apply for Leave
        </h3>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">From</label>
              <input type="date" required value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                className="w-full border border-gray-300 px-2 py-2 text-sm bg-white" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">To</label>
              <input type="date" required value={form.end_date} min={form.start_date}
                onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                className="w-full border border-gray-300 px-2 py-2 text-sm bg-white" />
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Reason (required)</label>
            <textarea required minLength={5} rows={3} value={form.reason}
              placeholder="Give a proper reason for the leave…"
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              className="w-full border border-gray-300 px-2 py-2 text-sm bg-white resize-none" />
          </div>
          <button type="submit" disabled={submitting}
            className="w-full bg-[#002FA7] hover:bg-[#002288] text-white text-[11px] font-bold uppercase tracking-widest py-2.5 flex items-center justify-center gap-2 disabled:opacity-60">
            <PaperPlaneRight size={14} /> {submitting ? "Sending…" : "Send Request"}
          </button>
        </form>
        <div className="text-[11px] leading-relaxed text-gray-500 border-t border-gray-100 pt-3">
          <b>Approved leave:</b> 1 day's salary cut per day.<br />
          <b>Absence without approval:</b> 2 days' salary cut per day.
        </div>
      </div>

      <div className="lg:col-span-2 bg-white border border-gray-200">
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="font-bold text-xs uppercase tracking-wider text-gray-500">My Leave Requests</h3>
        </div>
        {loading ? (
          <div className="p-8 text-center"><Spinner size={22} className="animate-spin inline text-[#002FA7]" /></div>
        ) : leaves.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">No leave requests yet</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {leaves.map((lv) => (
              <div key={lv.id} className="px-5 py-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-mono text-sm font-bold text-gray-800">
                    {lv.start_date} → {lv.end_date}
                    <span className="ml-2 text-[10px] text-gray-400 font-sans font-semibold uppercase">{daysBetween(lv.start_date, lv.end_date)} day(s)</span>
                  </div>
                  {lv.reason && <div className="text-xs text-gray-500 mt-0.5 truncate">{lv.reason}</div>}
                  {lv.decision_note && <div className="text-[11px] text-gray-400 mt-0.5 italic">Admin: {lv.decision_note}</div>}
                </div>
                <span className={chip(lv.status)}><StatusIcon status={lv.status} /> {lv.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Admin view: approval queue + add leave ---------------- */
function AdminLeaves() {
  const [leaves, setLeaves] = useState([]);
  const [filter, setFilter] = useState("pending");
  const [users, setUsers] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ user_id: "", start_date: "", end_date: "", reason: "" });
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const params = filter === "all" ? {} : { status: filter };
      const { data } = await api.get("/leaves", { params });
      setLeaves(data);
    } catch (e) {
      toast.error(errMsg(e, "Failed to load leaves"));
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [filter]);
  useEffect(() => {
    api.get("/users").then(({ data }) =>
      setUsers(data.filter((u) => u.role !== "admin" && !["scanner", "test_user"].includes(u.username)))
    ).catch(() => {});
  }, []);

  const decide = async (id, action) => {
    const note = window.prompt(`Optional note for this ${action}:`, "") ?? "";
    try {
      await api.post(`/leaves/${id}/${action}`, { note });
      toast.success(`Leave ${action}d`);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const cancel = async (id) => {
    if (!window.confirm("Cancel this leave?")) return;
    try {
      await api.post(`/leaves/${id}/cancel`);
      toast.success("Leave cancelled");
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const addLeave = async (e) => {
    e.preventDefault();
    try {
      await api.post("/leaves", addForm);
      toast.success("Leave added (auto-approved). 1 day's salary cut per leave day.");
      setShowAdd(false);
      setAddForm({ user_id: "", start_date: "", end_date: "", reason: "" });
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-2">
          {["pending", "approved", "rejected", "all"].map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`text-[10px] uppercase tracking-widest font-bold px-3 py-1.5 border ${filter === f ? "bg-[#002FA7] border-[#002FA7] text-white" : "border-gray-200 hover:bg-gray-50 text-gray-600"}`}>
              {f}
            </button>
          ))}
        </div>
        <button onClick={() => setShowAdd(!showAdd)}
          className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7] flex items-center gap-1 hover:underline">
          <Plus size={14} /> {showAdd ? "Cancel" : "Add Leave (auto-approved)"}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={addLeave} className="grid grid-cols-1 md:grid-cols-5 gap-2 bg-gray-50 p-3 border border-gray-200">
          <select required value={addForm.user_id} onChange={(e) => setAddForm({ ...addForm, user_id: e.target.value })}
            className="border border-gray-300 px-2 py-1.5 text-xs bg-white">
            <option value="">Select employee…</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.department || u.role})</option>)}
          </select>
          <input type="date" required value={addForm.start_date} onChange={(e) => setAddForm({ ...addForm, start_date: e.target.value })} className="border border-gray-300 px-2 py-1.5 text-xs bg-white" />
          <input type="date" required value={addForm.end_date} min={addForm.start_date} onChange={(e) => setAddForm({ ...addForm, end_date: e.target.value })} className="border border-gray-300 px-2 py-1.5 text-xs bg-white" />
          <input type="text" placeholder="Reason" value={addForm.reason} onChange={(e) => setAddForm({ ...addForm, reason: e.target.value })} className="border border-gray-300 px-2 py-1.5 text-xs bg-white" />
          <button type="submit" className="bg-[#002FA7] hover:bg-[#002288] text-white text-[10px] font-bold uppercase tracking-widest py-1.5">Add</button>
        </form>
      )}

      <div className="bg-white border border-gray-200">
        {loading ? (
          <div className="p-8 text-center"><Spinner size={22} className="animate-spin inline text-[#002FA7]" /></div>
        ) : leaves.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">No {filter !== "all" ? filter : ""} leave requests</div>
        ) : (
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 text-[10px] uppercase font-bold text-gray-500 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2.5">Employee</th>
                <th className="px-4 py-2.5">Dates</th>
                <th className="px-4 py-2.5">Reason</th>
                <th className="px-4 py-2.5 text-center">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {leaves.map((lv) => (
                <tr key={lv.id} className="border-t border-gray-100 hover:bg-gray-50/50">
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-gray-900">{lv.user_name || "?"}</div>
                    <div className="text-[10px] text-gray-400 font-mono">@{lv.user_username}</div>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {lv.start_date} → {lv.end_date}
                    <span className="ml-1 text-gray-400">({daysBetween(lv.start_date, lv.end_date)}d)</span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-600 max-w-[240px]">
                    <div className="truncate">{lv.reason || "—"}</div>
                    {lv.decision_note && <div className="text-[10px] text-gray-400 italic truncate">Note: {lv.decision_note}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-center"><span className={chip(lv.status)}><StatusIcon status={lv.status} /> {lv.status}</span></td>
                  <td className="px-4 py-2.5 text-right space-x-1 whitespace-nowrap">
                    {lv.status === "pending" && (
                      <>
                        <button onClick={() => decide(lv.id, "approve")}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold uppercase tracking-wider px-2.5 py-1">Approve</button>
                        <button onClick={() => decide(lv.id, "reject")}
                          className="bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold uppercase tracking-wider px-2.5 py-1">Reject</button>
                      </>
                    )}
                    <button onClick={() => cancel(lv.id)} title="Cancel leave" className="text-gray-400 hover:text-[#E60000] p-1 align-middle"><Trash size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="text-[11px] text-gray-500">
        Approving a leave cuts <b>1 day's salary per leave day</b>. Uninformed absence is cut at <b>2 days per day</b>. Payroll updates automatically.
      </div>
    </div>
  );
}

export default function LeavesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  return (
    <div className="p-4 md:p-8 space-y-6 font-chivo text-gray-900">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{isAdmin ? "Admin Portal" : "Employee Portal"}</div>
        <h1 className="font-chivo font-black text-2xl md:text-4xl">{isAdmin ? "Leave Approvals" : "My Leaves"}</h1>
      </div>
      {isAdmin ? <AdminLeaves /> : <MyLeaves />}
    </div>
  );
}
