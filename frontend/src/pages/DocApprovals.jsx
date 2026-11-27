import React, { useCallback, useEffect, useState } from "react";
import { Eye, CheckCircle, XCircle, Phone, ChatCircleText, Warning, Files, ArrowClockwise } from "@phosphor-icons/react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { openDoc } from "@/lib/docs";

/* Admin: documents (COA / GCMS / TDS …) an executive picked in /chat wait here.
   Look at the customer's chat and calls, preview each document, then approve (sent on WhatsApp
   in the executive's name) or reject with a reason the executive sees. */

const fmt = (iso) => {
  try { return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); } catch { return iso; }
};
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function Detail({ id, onDone }) {
  const [d, setD] = useState(null);
  const [ids, setIds] = useState([]);
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setD(null);
    api.get(`/docs/send-requests/${id}`).then(({ data }) => {
      setD(data);
      setIds(data.request.doc_ids);
      setCaption(data.request.caption || "");
    }).catch((e) => toast.error(errMsg(e)));
  }, [id]);

  if (!d) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  const r = d.request;
  const pending = r.status === "pending";

  const approve = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/docs/send-requests/${id}/approve`, { doc_ids: ids, caption });
      toast.success(`Approved - sent ${data.sent?.length || 0} document(s)${data.failed?.length ? `, ${data.failed.length} failed` : ""}`);
      onDone();
    } catch (e) { toast.error(errMsg(e, "Could not send")); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    const reason = window.prompt("Reason (the executive will see this):", "");
    if (reason === null) return;
    setBusy(true);
    try { await api.post(`/docs/send-requests/${id}/reject`, { reason }); toast.success("Rejected"); onDone(); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-lg font-black">{d.lead?.name || r.lead_name || "Customer"}</div>
        <div className="text-xs text-gray-500">
          {r.phone}{d.lead?.city ? ` · ${d.lead.city}` : ""}{d.lead?.source ? ` · ${d.lead.source}` : ""} · asked by <b>{r.requested_by_name}</b> {ago(r.created_at)}
        </div>
      </div>

      <div className="border border-gray-200 p-3">
        <div className="text-[10px] uppercase tracking-widest font-bold text-gray-500 mb-2">Documents to send</div>
        {r.docs.map((doc) => (
          <label key={doc.id} className="flex items-center gap-2 py-1 text-sm">
            {pending && <input type="checkbox" checked={ids.includes(doc.id)} onChange={() => setIds(ids.includes(doc.id) ? ids.filter((x) => x !== doc.id) : [...ids, doc.id])} />}
            <span className="flex-1">{doc.title}</span>
            <button type="button" onClick={() => openDoc(doc.id).catch((e) => toast.error(errMsg(e, "Could not open")))}
              className="text-xs font-bold text-[#002FA7] flex items-center gap-1 border border-[#002FA7]/30 px-2 py-1 hover:bg-blue-50"><Eye size={14} /> Preview</button>
          </label>
        ))}
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-widest font-bold text-gray-500 mb-1">Message with the first document</div>
          <input value={caption} onChange={(e) => setCaption(e.target.value)} disabled={!pending} placeholder="(none)"
            className="w-full border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-[#002FA7] disabled:bg-gray-50" />
        </div>
        {pending && !d.within_24h && (
          <div className="mt-2 text-xs bg-[#FFF4E0] text-[#8A4B00] px-2 py-1.5 flex gap-1.5"><Warning size={14} className="shrink-0 mt-px" />
            The customer has not messaged in the last 24 hours, so WhatsApp will refuse documents until they reply (the executive can send a template first).</div>
        )}
        {pending ? (
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={approve} disabled={busy || !ids.length} className="flex-1 bg-green-600 hover:bg-green-700 text-white font-bold text-sm py-2 flex items-center justify-center gap-1 disabled:opacity-50">
              <CheckCircle size={16} weight="fill" /> Approve & send {ids.length}
            </button>
            <button type="button" onClick={reject} disabled={busy} className="px-4 border border-[#E60000] text-[#E60000] font-bold text-sm py-2 flex items-center gap-1 hover:bg-red-50">
              <XCircle size={16} weight="fill" /> Reject
            </button>
          </div>
        ) : (
          <div className={`mt-3 text-sm font-bold ${r.status === "approved" ? "text-green-700" : "text-[#E60000]"}`}>
            {r.status === "approved" ? "Approved & sent" : "Rejected"} by {r.decided_by_name} · {fmt(r.decided_at)}{r.reason ? ` - ${r.reason}` : ""}
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="border border-gray-200">
          <div className="px-3 py-2 border-b border-gray-200 text-[10px] uppercase tracking-widest font-bold text-gray-500 flex items-center gap-1"><ChatCircleText size={14} /> WhatsApp chat</div>
          <div className="p-3 space-y-2 max-h-[60vh] overflow-y-auto bg-[#F5F1EA]">
            {!d.messages.length && <div className="text-xs text-gray-500">No messages</div>}
            {d.messages.map((m) => (
              <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] px-2.5 py-1.5 text-xs shadow-sm ${m.direction === "out" ? "bg-[#DCF8C6]" : "bg-white"}`}>
                  {m.media_type && <div className="text-[10px] font-bold text-gray-500 uppercase">{m.media_type}{m.filename ? `: ${m.filename}` : ""}</div>}
                  <div className="whitespace-pre-wrap break-words">{m.caption || m.body || (m.template_name ? `[template] ${m.template_name}` : "")}</div>
                  <div className="text-[9px] text-gray-500 text-right mt-0.5">{m.direction === "out" && m.by_name ? `${m.by_name} · ` : ""}{fmt(m.at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="border border-gray-200">
          <div className="px-3 py-2 border-b border-gray-200 text-[10px] uppercase tracking-widest font-bold text-gray-500 flex items-center gap-1"><Phone size={14} /> Calls</div>
          <div className="divide-y divide-gray-100 max-h-[60vh] overflow-y-auto">
            {!d.calls.length && <div className="p-3 text-xs text-gray-500">No calls</div>}
            {d.calls.map((c) => (
              <div key={c.id} className="p-3 text-xs">
                <div className="font-bold">{fmt(c.at)} · {c.direction === "incoming" ? "Incoming" : "Outgoing"} · {c.duration_seconds ? `${Math.round(c.duration_seconds / 60 * 10) / 10} min` : c.outcome} · {c.by_user_name}</div>
                {c.ai_summary?.summary ? (
                  <>
                    <div className="mt-1 text-gray-700">{c.ai_summary.summary}</div>
                    {c.ai_summary.price_discussed && <div className="mt-1 text-gray-500">Price: {c.ai_summary.price_discussed}</div>}
                  </>
                ) : c.summary ? <div className="mt-1 text-gray-600">{c.summary}</div> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DocApprovals() {
  const [tab, setTab] = useState("pending");
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(null);

  const load = useCallback(() => {
    api.get("/docs/send-requests", { params: { status: tab } }).then(({ data }) => {
      setRows(data.requests);
      setSel((s) => (s && data.requests.some((r) => r.id === s) ? s : data.requests[0]?.id || null));
    }).catch((e) => toast.error(errMsg(e)));
  }, [tab]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (tab !== "pending") return undefined;
    const t = setInterval(() => { if (!document.hidden) load(); }, 20000);
    return () => clearInterval(t);
  }, [tab, load]);

  return (
    <div className="p-4 md:p-6" data-testid="doc-approvals-page">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-xl font-black flex items-center gap-2"><Files size={22} weight="fill" className="text-[#002FA7]" /> Document Approvals</h1>
        <button type="button" onClick={load} className="p-1.5 text-gray-500 hover:text-gray-900" title="Refresh"><ArrowClockwise size={16} /></button>
        <div className="ml-auto flex border border-gray-300 text-xs font-bold">
          {[["pending", "Waiting"], ["done", "History"]].map(([k, l]) => (
            <button key={k} type="button" onClick={() => { setTab(k); setSel(null); }} className={`px-3 py-1.5 ${tab === k ? "bg-[#002FA7] text-white" : "bg-white"}`}>{l}</button>
          ))}
        </div>
      </div>
      <div className="grid md:grid-cols-[300px_1fr] gap-4">
        <div className="border border-gray-200 divide-y divide-gray-100 self-start">
          {rows === null ? <div className="p-4 text-xs text-gray-500">Loading…</div> : !rows.length ? (
            <div className="p-6 text-xs text-gray-500 text-center">{tab === "pending" ? "Nothing waiting - all clear." : "No history yet."}</div>
          ) : rows.map((r) => (
            <button key={r.id} type="button" onClick={() => setSel(r.id)} className={`w-full text-left px-3 py-2 ${sel === r.id ? "bg-blue-50" : "hover:bg-gray-50"}`}>
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm flex-1 truncate">{r.lead_name || r.phone}</span>
                {r.status === "approved" && <CheckCircle size={14} weight="fill" className="text-green-600" />}
                {r.status === "rejected" && <XCircle size={14} weight="fill" className="text-[#E60000]" />}
              </div>
              <div className="text-[11px] text-gray-500 truncate">{r.requested_by_name} · {(r.docs || []).map((d) => d.title).join(", ")}</div>
              <div className="text-[10px] text-gray-400">{ago(r.created_at)}</div>
            </button>
          ))}
        </div>
        <div>{sel ? <Detail key={sel} id={sel} onDone={load} /> : null}</div>
      </div>
    </div>
  );
}
