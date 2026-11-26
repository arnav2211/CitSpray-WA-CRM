import React, { useEffect, useState } from "react";
import { X, MagnifyingGlass, Eye, PaperPlaneRight, CaretRight, CaretDown, LockSimple } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { openDoc, KIND_COLORS } from "@/lib/docs";

/* /chat → attach → Product documents: search an oil, tick its COA / GCMS / TDS …
   and send them to this customer as WhatsApp documents. */
export default function DocPicker({ leadId, onClose, onSent }) {
  const [q, setQ] = useState("");
  const [products, setProducts] = useState([]);
  const [open, setOpen] = useState(null);
  const [docs, setDocs] = useState({});
  const [picked, setPicked] = useState([]);
  const [caption, setCaption] = useState("");
  const [kinds, setKinds] = useState({});
  const [sending, setSending] = useState(false);

  useEffect(() => { api.get("/docs/meta").then(({ data }) => setKinds(data.kinds || {})).catch(() => {}); }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      api.get("/docs/products", { params: { q } }).then(({ data }) => setProducts((data.products || []).filter((p) => p.total))).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const toggleOil = async (pid) => {
    if (open === pid) { setOpen(null); return; }
    setOpen(pid);
    if (!docs[pid]) {
      try {
        const { data } = await api.get(`/docs/products/${pid}`);
        setDocs((d) => ({ ...d, [pid]: data.documents || [] }));
      } catch (e) { toast.error(errMsg(e, "Could not load")); }
    }
  };

  const send = async () => {
    setSending(true);
    try {
      const { data } = await api.post("/docs/send", { lead_id: leadId, doc_ids: picked.map((p) => p.id), caption });
      toast.success(`Sent ${data.sent.length} document${data.sent.length === 1 ? "" : "s"}${data.failed.length ? ` · ${data.failed.length} failed` : ""}`);
      onSent?.();
    } catch (e) { toast.error(errMsg(e, "Could not send")); }
    finally { setSending(false); }
  };

  const isPicked = (id) => picked.some((p) => p.id === id);
  const toggle = (d) => setPicked(isPicked(d.id) ? picked.filter((p) => p.id !== d.id) : [...picked, d].slice(0, 10));

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center" data-testid="doc-picker">
      <div className="bg-white w-full md:max-w-lg max-h-[85vh] flex flex-col shadow-2xl">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="font-chivo font-black">Send product documents</div>
          <button onClick={onClose} className="p-1 text-gray-500"><X size={16} /></button>
        </div>
        <div className="p-3 border-b border-gray-200 relative">
          <MagnifyingGlass size={14} className="absolute left-5 top-5 text-gray-400" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search oil (e.g. lemongrass)"
            className="w-full border border-gray-300 pl-7 pr-2 py-2 text-sm outline-none focus:border-[#002FA7]" data-testid="doc-picker-search" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {products.map((p) => (
            <div key={p.id} className="border-b border-gray-100">
              <button onClick={() => toggleOil(p.id)} className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-gray-50">
                {open === p.id ? <CaretDown size={12} /> : <CaretRight size={12} />}
                <span className="font-bold text-sm flex-1">{p.name}</span>
                <span className="text-[10px] text-gray-400">{p.total} doc{p.total === 1 ? "" : "s"}</span>
              </button>
              {open === p.id && (docs[p.id] || []).map((d) => (
                <label key={d.id} className="flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer">
                  <input type="checkbox" checked={isPicked(d.id)} onChange={() => toggle(d)} />
                  <span className={`text-[9px] px-1.5 py-0.5 font-bold uppercase ${KIND_COLORS[d.kind] || KIND_COLORS.other}`}>{kinds[d.kind] || d.kind}</span>
                  <span className="flex-1 truncate">{d.title}</span>
                  {d.visibility === "admin" && <LockSimple size={12} className="text-gray-500" title="Admin only" />}
                  <button type="button" onClick={(e) => { e.preventDefault(); openDoc(d.id).catch((er) => toast.error(errMsg(er, "Could not open"))); }} className="p-1 text-gray-500 hover:text-gray-900" title="View"><Eye size={14} /></button>
                </label>
              ))}
            </div>
          ))}
          {!products.length && <div className="p-6 text-center text-sm text-gray-400">{q ? "No oil with documents matches" : "No documents in the library yet"}</div>}
        </div>
        <div className="p-3 border-t border-gray-200 space-y-2">
          <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Message with the first document (optional)"
            className="w-full border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-[#002FA7]" />
          <button onClick={send} disabled={!picked.length || sending}
            className="w-full bg-[#25D366] hover:bg-[#1DA851] text-white py-2 text-xs font-bold uppercase tracking-widest flex items-center justify-center gap-1 disabled:opacity-50" data-testid="doc-picker-send">
            <PaperPlaneRight size={14} weight="fill" /> {sending ? "Sending…" : `Send ${picked.length || ""} document${picked.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
