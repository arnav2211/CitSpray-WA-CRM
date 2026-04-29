import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { Plus, Trash, PencilSimple, X } from "@phosphor-icons/react";

export default function QuickReplies() {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    try { const { data } = await api.get("/quick-replies"); setList(data); }
    catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const del = async (id) => {
    if (!window.confirm("Delete this quick reply?")) return;
    try { await api.delete(`/quick-replies/${id}`); toast.success("Deleted"); load(); }
    catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Messaging</div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Quick Replies</h1>
          <p className="text-sm text-gray-600 mt-1 max-w-2xl">
            Internal canned messages executives can insert into the chat composer. These are NOT WhatsApp templates —
            they only work inside the 24-hour customer-care window. Use <span className="kbd">{"{{name}}"}</span> to inject the customer name.
          </p>
        </div>
        <button onClick={() => setEditing({})} className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="add-qr-btn">
          <Plus size={12} weight="bold" /> New Quick Reply
        </button>
      </div>

      <div className="border border-gray-200 bg-white">
        {list.length === 0 ? (
          <div className="p-12 text-center text-xs uppercase tracking-widest text-gray-400">No quick replies yet</div>
        ) : list.map(qr => (
          <div key={qr.id} className="px-5 py-4 border-b border-gray-200 flex items-start gap-4 last:border-b-0" data-testid={`qr-row-${qr.id}`}>
            <div className="flex-1 min-w-0">
              <div className="font-chivo font-bold">{qr.title}</div>
              <div className="text-sm text-gray-700 mt-1 whitespace-pre-wrap">{qr.text}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setEditing(qr)} className="text-[#002FA7] p-1" title="Edit" data-testid={`edit-qr-${qr.id}`}>
                <PencilSimple size={14} />
              </button>
              <button onClick={() => del(qr.id)} className="text-[#E60000] p-1" title="Delete" data-testid={`delete-qr-${qr.id}`}>
                <Trash size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && <QRModal qr={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function QRModal({ qr, onClose, onSaved }) {
  const isEdit = !!qr.id;
  const [title, setTitle] = useState(qr.title || "");
  const [text, setText] = useState(qr.text || "");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isEdit) await api.put(`/quick-replies/${qr.id}`, { title, text });
      else await api.post("/quick-replies", { title, text });
      toast.success("Saved");
      onSaved();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-lg bg-white border border-gray-900 p-6" data-testid="qr-modal">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{isEdit ? "Edit" : "Create"}</div>
            <h2 className="font-chivo font-black text-2xl mt-1">{isEdit ? "Edit Quick Reply" : "New Quick Reply"}</h2>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <label className="block">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Title</div>
            <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short label e.g. Greeting"
              className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="qr-title-input" />
          </label>
          <label className="block">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Message text</div>
            <textarea required rows={5} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="Hi {{name}}, thanks for reaching out…"
              className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="qr-text-input" />
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100">Cancel</button>
          <button disabled={busy} className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="qr-save-btn">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
