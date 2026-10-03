import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { fmtSmartLong } from "@/lib/format";

/* Website COD orders must be verified before dispatch. The customer can tap
   Confirm / Cancel on the cod_verification WhatsApp; the executive can do the
   same here after calling them. Confirm books the order into OMS. Used in the
   lead drawer (/leads) and the /chat "Lead Details" panel. */

export function isCodOrder(lead) {
  if (!lead) return false;
  if (lead.cod_status) return true;
  const sd = lead.source_data || {};
  if (!sd.order_number) return false;
  const gw = String(sd.gateway || "").toLowerCase();
  const fs = String(sd.financial_status || "").toLowerCase();
  return (/cod|cash on delivery|manual/.test(gw) || !gw) && (fs === "pending" || fs === "unpaid");
}

const STATUS_STYLE = {
  pending: "border-amber-300 bg-amber-50",
  confirmed: "border-green-300 bg-green-50",
  cancelled: "border-red-300 bg-red-50",
  none: "border-gray-300 bg-gray-50",
};

export default function CodVerificationCard({ lead, onChange }) {
  const [state, setState] = useState({ status: lead?.cod_status || "", oms: lead?.oms_order_number || "", via: lead?.cod_resolved_via || "" });
  const [busy, setBusy] = useState("");

  useEffect(() => {
    setState({ status: lead?.cod_status || "", oms: lead?.oms_order_number || "", via: lead?.cod_resolved_via || "" });
  }, [lead?.id, lead?.cod_status, lead?.oms_order_number, lead?.cod_resolved_via]);

  if (!isCodOrder(lead)) return null;
  const sd = lead.source_data || {};
  const status = state.status || "none";

  const act = async (action) => {
    if (action === "cancel" && !window.confirm(`Cancel COD order ${sd.order_number}? It will not be dispatched.`)) return;
    if (action === "confirm" && !window.confirm(`Confirm COD order ${sd.order_number} and send it to OMS for dispatch?`)) return;
    setBusy(action);
    try {
      const { data } = await api.post(`/leads/${lead.id}/cod/${action}`);
      if (action === "resend") {
        if (data.ok) toast.success("Confirmation request sent on WhatsApp");
        else toast.error(`WhatsApp failed: ${data.error || data.status}`);
      } else if (data.error) {
        toast.error(`Marked ${data.cod_status}, but OMS push failed: ${data.error}`);
      } else if (action === "confirm") {
        toast.success(data.oms_order_number ? `Confirmed · OMS order ${data.oms_order_number} created` : "Order confirmed");
      } else {
        toast.success("Order cancelled");
        if (data.warning) toast.warning(data.warning);
      }
      setState({ status: data.cod_status || state.status, oms: data.oms_order_number || state.oms, via: action === "resend" ? state.via : "crm" });
      onChange?.(data);
    } catch (e) { toast.error(errMsg(e, "Action failed")); }
    setBusy("");
  };

  const btn = "px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50";

  return (
    <section data-testid="cod-verification-section">
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2 flex items-center justify-between">
        <span>💵 Cash on Delivery · {sd.order_number}</span>
        <span className="text-gray-400 normal-case tracking-normal font-normal">{sd.currency || "INR"} {sd.total_price}</span>
      </div>
      <div className={`border p-3 text-sm space-y-2 ${STATUS_STYLE[status]}`}>
        {status === "pending" && (
          <div><span className="font-bold text-amber-800">Awaiting confirmation</span>
            <div className="text-xs text-gray-600">WhatsApp asked {fmtSmartLong(lead.cod_asked_at) || "—"}. Not sent to OMS until confirmed.</div></div>
        )}
        {status === "confirmed" && (
          <div><span className="font-bold text-green-800">Confirmed{state.via === "crm" ? " by executive" : state.via === "whatsapp" ? " by customer" : ""}</span>
            <div className="text-xs text-gray-600">{state.oms ? `OMS order ${state.oms}` : "In OMS"} · {fmtSmartLong(lead.cod_responded_at) || ""}</div></div>
        )}
        {status === "cancelled" && (
          <div><span className="font-bold text-red-800">Cancelled</span>
            <div className="text-xs text-gray-600">Do not dispatch. {fmtSmartLong(lead.cod_responded_at) || ""}</div></div>
        )}
        {status === "none" && (
          <div><span className="font-bold text-gray-800">Not verified yet</span>
            <div className="text-xs text-gray-600">No confirmation request has been sent. Call the customer or send the WhatsApp.</div></div>
        )}
        {status !== "cancelled" && (
          <div className="flex flex-wrap gap-2 pt-1">
            {status !== "confirmed" && (
              <button onClick={() => act("confirm")} disabled={!!busy} className={`${btn} bg-[#008A00] text-white`} data-testid="cod-confirm-btn">
                {busy === "confirm" ? "Confirming…" : "Confirm order (spoke to customer)"}
              </button>
            )}
            {status !== "confirmed" && (
              <button onClick={() => act("resend")} disabled={!!busy} className={`${btn} bg-[#25D366] text-white`} data-testid="cod-resend-btn">
                {busy === "resend" ? "Sending…" : status === "pending" ? "Resend WhatsApp" : "Ask on WhatsApp"}
              </button>
            )}
            <button onClick={() => act("cancel")} disabled={!!busy} className={`${btn} border border-[#E60000] text-[#E60000] hover:bg-[#E60000] hover:text-white`} data-testid="cod-cancel-btn">
              {busy === "cancel" ? "Cancelling…" : "Cancel order"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
