import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ClockCounterClockwise, CaretDown, CaretUp } from "@phosphor-icons/react";

// Orders from the old hand-kept order sheets (2022 - Apr 2026, before OMS).
const fmtDate = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "date not written");
const inr = (n) => (n || n === 0 ? "₹" + Math.round(n).toLocaleString("en-IN") : "");

function ago(d) {
  if (!d) return "";
  const days = Math.floor((Date.now() - new Date(d + "T00:00:00").getTime()) / 86400000);
  if (days < 45) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const y = days / 365;
  return `${y.toFixed(y < 2 ? 1 : 0)} years ago`;
}

export default function PastOrdersSection({ leadId }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    if (!leadId) return;
    setData(null);
    api.get(`/leads/${leadId}/past-orders`).then(({ data }) => setData(data)).catch(() => setData(null));
  }, [leadId]);

  if (!data || !data.count) return null;
  return (
    <section className="pt-3 border-t border-gray-200" data-testid="past-orders">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1.5">
          <ClockCounterClockwise size={14} className="text-gray-500" /> Past orders - old order sheet ({data.count})
        </span>
        {open ? <CaretUp size={12} /> : <CaretDown size={12} />}
      </button>
      <div className="text-xs text-gray-700 mb-2">
        Last order <b>{fmtDate(data.last_order_at)}</b>{data.last_order_at ? ` (${ago(data.last_order_at)})` : ""}
        {data.total ? <> · total spent <b>{inr(data.total)}</b></> : null}
      </div>
      {open && (
        <div className="space-y-1.5">
          {data.orders.map((o) => {
            const ex = expanded[o.id];
            const items = (o.items || []).filter((x) => !/^(total|grand total|courier|shipping|freight|gst|18%)/i.test(x.trim()));
            return (
              <div key={o.id} className="border border-gray-200 bg-white px-3 py-2 text-xs" data-testid={`past-order-${o.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{fmtDate(o.date)}</span>
                  <span className="font-mono">{inr(o.total)}</span>
                </div>
                <div className="text-gray-600 mt-0.5">
                  {(ex ? items : items.slice(0, 3)).map((it, i) => <div key={i} className="truncate">{it}</div>)}
                  {items.length > 3 && (
                    <button type="button" className="text-[#002FA7] underline mt-0.5" onClick={() => setExpanded((m) => ({ ...m, [o.id]: !ex }))}>
                      {ex ? "less" : `+${items.length - 3} more`}
                    </button>
                  )}
                </div>
                {(o.executive || (o.notes || []).length > 0) && (
                  <div className="text-[10px] text-gray-400 mt-1">
                    {o.executive ? `Taken by ${o.executive}` : ""}{o.executive && (o.notes || []).length ? " · " : ""}{(o.notes || []).join(" · ")}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
