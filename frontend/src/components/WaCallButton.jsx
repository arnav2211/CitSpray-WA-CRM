import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PhoneOutgoing, Clock, Check, X } from "@phosphor-icons/react";
import { api, errMsg } from "@/lib/api";
import { fmtSmartLong } from "@/lib/format";

/* Outgoing WhatsApp calls cost money (Meta bills per minute), so an executive must
   ask an admin first; an approval is good for ONE call to that lead for 2 hours.
   WhatsApp also needs the customer's own "Allow calls" before we can ring them. */

export function WaCallButton({ leadId }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/wa-calls/outgoing/status", { params: { lead_id: leadId } });
      setSt(data);
    } catch (e) {
      setSt(null);
    }
  }, [leadId]);

  useEffect(() => { setSt(null); setOpen(false); setReason(""); load(); }, [load]);
  useEffect(() => {
    if (!open) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [open, load]);

  if (!st || !st.enabled) return null;

  const ask = async () => {
    setBusy(true);
    try {
      await api.post("/wa-calls/requests", { lead_id: leadId, reason });
      toast.success("Sent to admin for approval");
      await load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const askCustomer = async () => {
    setBusy(true);
    try {
      await api.post("/wa-calls/permission-request", { lead_id: leadId, reason });
      toast.success("Asked the customer to allow WhatsApp calls. You'll get a notification when they allow it.");
      await load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const callNow = () => { window.location.href = `/wa-call-out/${leadId}`; };

  const perm = st.permission || {};
  const allowed = st.admin || st.approval;
  let body;
  if (!allowed && st.pending) {
    body = (
      <div className="text-xs text-gray-600 flex items-center gap-1"><Clock size={12} /> Waiting for an admin to approve (asked {fmtSmartLong(st.pending.created_at)}).</div>
    );
  } else if (!allowed) {
    body = (
      <div className="space-y-2">
        <div className="text-xs text-gray-600">WhatsApp calls we make are charged by Meta per minute, so an admin has to approve each call.</div>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why do you need to call? (optional)"
          className="w-full border border-gray-300 px-2 py-1 text-xs" />
        <button type="button" disabled={busy} onClick={ask} className="w-full bg-[#128C7E] text-white text-xs font-bold uppercase tracking-widest py-2 disabled:opacity-50">Ask admin to approve</button>
      </div>
    );
  } else if (perm.error) {
    body = <div className="text-xs text-red-600">WhatsApp: {perm.error}</div>;
  } else if (perm.can_call) {
    body = (
      <div className="space-y-2">
        {st.approval && <div className="text-[11px] text-green-700">Approved by {st.approval.decided_by_name} · valid till {fmtSmartLong(st.approval.expires_at)} (one call)</div>}
        <button type="button" onClick={callNow} className="w-full bg-[#25D366] text-white text-xs font-bold uppercase tracking-widest py-2 flex items-center justify-center gap-1"><PhoneOutgoing size={14} /> Call now on WhatsApp</button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-2">
        {st.approval && <div className="text-[11px] text-green-700">Approved by {st.approval.decided_by_name} · valid till {fmtSmartLong(st.approval.expires_at)}</div>}
        <div className="text-xs text-gray-600">The customer has not allowed WhatsApp calls from us yet. WhatsApp will show them an "Allow calls" message.</div>
        {st.within_24h && perm.can_request !== false ? (
          <button type="button" disabled={busy} onClick={askCustomer} className="w-full bg-[#128C7E] text-white text-xs font-bold uppercase tracking-widest py-2 disabled:opacity-50">Ask customer to allow calls</button>
        ) : (
          <div className="text-[11px] text-amber-700">{st.within_24h ? "WhatsApp's limit: we can ask once a day and twice a week. Try later." : "They haven't messaged in the last 24 hours, so we can't ask now. Wait for them to message, or ask them to call us on WhatsApp."}</div>
        )}
      </div>
    );
  }

  return (
    <span className="relative">
      <button type="button" onClick={() => { setOpen((o) => !o); load(); }} data-testid="wa-call-button"
        className="flex items-center gap-1 border border-[#25D366] text-[#128C7E] px-1.5 py-0.5 text-[11px] font-bold hover:bg-[#25D366]/10">
        <PhoneOutgoing size={11} /> WhatsApp call
      </button>
      {open && (
        <div className="absolute z-50 mt-1 left-0 w-72 bg-white border border-gray-300 shadow-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-widest font-bold text-gray-500">WhatsApp call</div>
            <button type="button" onClick={() => setOpen(false)} className="text-gray-400"><X size={12} /></button>
          </div>
          {body}
        </div>
      )}
    </span>
  );
}

/* Admin: pending "may I call on WhatsApp?" requests (also on the admin's phone as a notification). */
export function WaCallRequestsPanel() {
  const [rows, setRows] = useState([]);
  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/wa-calls/requests", { params: { status: "pending" } });
      setRows(data || []);
    } catch (e) { /* ignore */ }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  const decide = async (id, approve) => {
    try {
      await api.post(`/wa-calls/requests/${id}/decide`, { approve });
      toast.success(approve ? "Approved: they can make one call in the next 2 hours" : "Denied");
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };
  if (!rows.length) return null;
  return (
    <div className="border border-[#25D366] bg-[#25D366]/5 p-3 space-y-2" data-testid="wa-call-requests">
      <div className="text-[10px] uppercase tracking-widest font-bold text-[#128C7E] flex items-center gap-1"><PhoneOutgoing size={12} /> WhatsApp call requests (Meta charges per minute)</div>
      {rows.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-2 flex-wrap bg-white border border-gray-200 p-2">
          <div className="text-xs">
            <b>{r.requested_by_name}</b> wants to call <b>{r.name || r.phone}</b> <span className="font-mono text-gray-500">{r.phone}</span>
            {r.reason && <div className="text-gray-600">“{r.reason}”</div>}
            <div className="text-[10px] text-gray-400">{fmtSmartLong(r.created_at)}</div>
          </div>
          <div className="flex gap-1">
            <button type="button" onClick={() => decide(r.id, true)} className="bg-[#25D366] text-white text-[11px] font-bold px-2 py-1 flex items-center gap-1"><Check size={12} /> Approve</button>
            <button type="button" onClick={() => decide(r.id, false)} className="border border-gray-300 text-[11px] font-bold px-2 py-1 flex items-center gap-1"><X size={12} /> Deny</button>
          </div>
        </div>
      ))}
    </div>
  );
}
