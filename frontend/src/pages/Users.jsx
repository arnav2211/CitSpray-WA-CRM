import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { Plus, Trash } from "@phosphor-icons/react";

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    try { const { data } = await api.get("/users"); setUsers(data); } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const del = async (id) => {
    if (!window.confirm("Delete this user?")) return;
    try { await api.delete(`/users/${id}`); toast.success("Deleted"); load(); } catch (e) { toast.error(errMsg(e)); }
  };

  const toggleActive = async (u) => {
    try { await api.patch(`/users/${u.id}`, { active: !u.active }); load(); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="p-6 md:p-8 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Team</div>
          <h1 className="font-chivo font-black text-3xl md:text-4xl">Executives</h1>
        </div>
        <button onClick={() => setShowNew(true)} className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="add-user-btn">
          <Plus size={12} weight="bold" /> Add User
        </button>
      </div>

      <div className="border border-gray-200 bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
            <tr>
              <th className="text-left px-4 py-3">Name</th>
              <th className="text-left px-4 py-3">Username</th>
              <th className="text-left px-4 py-3">Role</th>
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
                  {u.role !== "admin" && <button onClick={() => del(u.id)} className="text-[#E60000]" data-testid={`delete-user-${u.username}`}><Trash size={14} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(showNew || editing) && (
        <UserModal user={editing} onClose={() => { setShowNew(false); setEditing(null); }} onSaved={() => { setShowNew(false); setEditing(null); load(); }} />
      )}
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
        const body = { name: f.name, role: f.role, active: f.active, working_hours: f.working_hours };
        if (f.password) body.password = f.password;
        await api.patch(`/users/${user.id}`, body);
      } else {
        await api.post("/users", f);
      }
      toast.success("Saved"); onSaved();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-2xl bg-white border border-gray-900 p-6 max-h-[90vh] overflow-y-auto" data-testid="user-modal">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{isEdit ? "Edit" : "Create"}</div>
        <h2 className="font-chivo font-black text-2xl mt-1 mb-4">{isEdit ? "Edit User" : "New Executive"}</h2>

        <div className="grid grid-cols-2 gap-3">
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
              <option value="executive">executive</option>
              <option value="admin">admin</option>
            </select>
          </Field>
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
