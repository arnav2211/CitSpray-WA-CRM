import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { Plus, Trash } from "@phosphor-icons/react";

export default function Templates() {
  const [tpl, setTpl] = useState([]);
  const [showNew, setShowNew] = useState(false);

  const load = async () => {
    try { const { data } = await api.get("/whatsapp/templates"); setTpl(data); } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const del = async (id) => {
    if (!window.confirm("Delete template?")) return;
    try { await api.delete(`/whatsapp/templates/${id}`); load(); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="p-6 md:p-8 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Messaging</div>
          <h1 className="font-chivo font-black text-3xl md:text-4xl">WhatsApp Templates</h1>
        </div>
        <button onClick={() => setShowNew(true)} className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="add-template-btn">
          <Plus size={12} /> New Template
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {tpl.map((t) => (
          <div key={t.id} className="border border-gray-200 bg-white p-5" data-testid={`tpl-card-${t.name}`}>
            <div className="flex items-center justify-between">
              <div className="font-chivo font-bold">{t.name}</div>
              <span className="kbd">{t.category}</span>
            </div>
            <div className="mt-3 border border-gray-200 bg-gray-50 p-3 text-sm whitespace-pre-wrap">{t.body}</div>
            <div className="mt-3 flex justify-end">
              <button onClick={() => del(t.id)} className="text-[10px] uppercase tracking-widest font-bold text-[#E60000] flex items-center gap-1" data-testid={`delete-tpl-${t.name}`}><Trash size={12} /> Delete</button>
            </div>
          </div>
        ))}
        {tpl.length === 0 && <div className="col-span-full text-center text-xs uppercase tracking-widest text-gray-500 py-12">No templates</div>}
      </div>

      {showNew && <NewTplModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
    </div>
  );
}

function NewTplModal({ onClose, onSaved }) {
  const [f, setF] = useState({ name: "", category: "utility", body: "" });
  const submit = async (e) => {
    e.preventDefault();
    try { await api.post("/whatsapp/templates", f); toast.success("Saved"); onSaved(); }
    catch (err) { toast.error(errMsg(err)); }
  };
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-lg bg-white border border-gray-900 p-6" data-testid="tpl-modal">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Create</div>
        <h2 className="font-chivo font-black text-2xl mt-1 mb-4">New Template</h2>
        <div className="space-y-3">
          <label className="block">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Name (snake_case)</div>
            <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="tpl-name-input" />
          </label>
          <label className="block">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Category</div>
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} className="w-full border border-gray-300 px-2 py-2 text-sm">
              <option value="utility">utility</option>
              <option value="marketing">marketing</option>
            </select>
          </label>
          <label className="block">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Body (use {"{{name}}"} to inject customer name)</div>
            <textarea required rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="tpl-body-input" />
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100">Cancel</button>
          <button className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold" data-testid="tpl-save-btn">Save</button>
        </div>
      </form>
    </div>
  );
}
