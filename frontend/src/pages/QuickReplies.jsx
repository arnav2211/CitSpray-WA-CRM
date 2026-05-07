import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { Plus, Trash, PencilSimple, X, ArrowUp, ArrowDown } from "@phosphor-icons/react";

export default function QuickReplies() {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null);
  const [reordering, setReordering] = useState(false);

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

  // Move qr at index `from` by `delta` (+1 down, -1 up). Optimistic UI: reorder
  // locally first, then persist via /quick-replies/reorder.
  const move = async (from, delta) => {
    const to = from + delta;
    if (to < 0 || to >= list.length) return;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setList(next);
    setReordering(true);
    try {
      await api.post("/quick-replies/reorder", { ids: next.map((q) => q.id) });
    } catch (e) {
      toast.error(errMsg(e, "Reorder failed"));
      load();
    } finally {
      setReordering(false);
    }
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
            Use the ↑/↓ arrows to reorder — the order is what executives see in <span className="kbd">/chat</span>.
          </p>
        </div>
        <button onClick={() => setEditing({})} className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="add-qr-btn">
          <Plus size={12} weight="bold" /> New Quick Reply
        </button>
      </div>

      <div className="border border-gray-200 bg-white">
        {list.length === 0 ? (
          <div className="p-12 text-center text-xs uppercase tracking-widest text-gray-400">No quick replies yet</div>
        ) : list.map((qr, i) => (
          <div key={qr.id} className="px-5 py-4 border-b border-gray-200 flex items-start gap-3 last:border-b-0" data-testid={`qr-row-${qr.id}`}>
            <div className="flex flex-col gap-1 shrink-0">
              <button
                onClick={() => move(i, -1)}
                disabled={i === 0 || reordering}
                className="text-gray-500 hover:text-[#002FA7] disabled:opacity-20 disabled:cursor-not-allowed p-0.5"
                title="Move up"
                data-testid={`qr-up-${qr.id}`}
              >
                <ArrowUp size={14} weight="bold" />
              </button>
              <button
                onClick={() => move(i, +1)}
                disabled={i === list.length - 1 || reordering}
                className="text-gray-500 hover:text-[#002FA7] disabled:opacity-20 disabled:cursor-not-allowed p-0.5"
                title="Move down"
                data-testid={`qr-down-${qr.id}`}
              >
                <ArrowDown size={14} weight="bold" />
              </button>
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-chivo font-bold flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-widest text-gray-400 font-mono">#{i + 1}</span>
                {qr.title}
                {qr.media_type && (
                  <span className="bg-[#25D366] text-white px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold">
                    {qr.media_type}
                  </span>
                )}
              </div>
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
  const [mediaUrl, setMediaUrl] = useState(qr.media_url || "");
  const [mediaType, setMediaType] = useState(qr.media_type || "");
  const [mediaFilename, setMediaFilename] = useState(qr.media_filename || "");
  const [caption, setCaption] = useState(qr.caption || "");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = React.useRef(null);

  const detectKind = (file) => {
    const t = file.type || "";
    if (t.startsWith("image/")) return "image";
    if (t.startsWith("video/")) return "video";
    if (t.startsWith("audio/")) return "audio";
    return "document";
  };

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast.error("Max 25 MB");
      return;
    }
    setUploading(true);
    try {
      const kind = detectKind(file);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      const { data } = await api.post("/chatflows/upload-media", fd);
      setMediaUrl(data.url);
      setMediaType(kind);
      setMediaFilename(file.name);
      toast.success(`${kind} attached`);
    } catch (err) { toast.error(errMsg(err, "Upload failed")); }
    finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const clearMedia = () => {
    setMediaUrl(""); setMediaType(""); setMediaFilename(""); setCaption("");
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim() && !mediaUrl) {
      toast.error("Add either a text message or a media attachment");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        title,
        text,
        media_url: mediaUrl || null,
        media_type: mediaType || null,
        media_filename: mediaFilename || null,
        caption: caption || null,
      };
      if (isEdit) await api.put(`/quick-replies/${qr.id}`, payload);
      else await api.post("/quick-replies", payload);
      toast.success("Saved");
      onSaved();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-lg bg-white border border-gray-900 p-6 max-h-[90vh] overflow-y-auto" data-testid="qr-modal">
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
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Message text {mediaUrl && <span className="text-gray-400 normal-case lowercase ml-1">(optional when media attached)</span>}</div>
            <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="Hi {{name}}, thanks for reaching out…"
              className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="qr-text-input" />
          </label>

          {/* Media attachment */}
          <div className="border border-gray-200 p-3 bg-gray-50">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2">Media (optional)</div>
            {mediaUrl ? (
              <div className="space-y-2" data-testid="qr-media-preview">
                <div className="flex items-center gap-2 text-xs">
                  <span className="bg-[#25D366] text-white px-2 py-0.5 text-[9px] uppercase tracking-widest font-bold">{mediaType}</span>
                  <span className="font-mono text-gray-700 truncate flex-1">{mediaFilename || mediaUrl}</span>
                  <button type="button" onClick={clearMedia} className="text-[#E60000] text-[10px] uppercase tracking-widest font-bold hover:underline" data-testid="qr-media-remove">Remove</button>
                </div>
                {mediaType === "image" && <img src={mediaUrl} alt="" className="max-h-32 border border-gray-200" />}
                {mediaType === "video" && <video src={mediaUrl} controls className="max-h-32 w-full" />}
                {mediaType === "audio" && <audio src={mediaUrl} controls className="w-full" />}
                <input
                  type="text" value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  placeholder="Caption (image/video only)"
                  className="w-full border border-gray-300 px-2 py-1.5 text-xs"
                  data-testid="qr-caption-input"
                />
              </div>
            ) : (
              <div>
                <input ref={fileInputRef} type="file" onChange={onPick} accept="image/*,video/*,audio/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={uploading} className="hidden" id="qr-file" data-testid="qr-file-input" />
                <label htmlFor="qr-file" className="inline-block border border-gray-300 hover:border-gray-900 cursor-pointer px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold">
                  {uploading ? "Uploading…" : "Attach image / video / document"}
                </label>
              </div>
            )}
          </div>
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
