import React from "react";
import { queryTypeInfo } from "@/lib/format";

export function StatusBadge({ status }) {
  const map = {
    new: "bg-[#002FA7] text-white",
    contacted: "bg-[#FFCC00] text-gray-900",
    qualified: "bg-gray-900 text-white",
    converted: "bg-[#008A00] text-white",
    lost: "bg-[#E60000] text-white",
  };
  const cls = map[status] || "bg-gray-200 text-gray-900";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${cls}`}
      data-testid={`status-badge-${status}`}>
      {status || "unknown"}
    </span>
  );
}

export function SourceBadge({ source }) {
  const map = {
    IndiaMART: "border-[#002FA7] text-[#002FA7]",
    ExportersIndia: "border-[#BE185D] text-[#BE185D]",
    Justdial: "border-[#E60000] text-[#E60000]",
    Manual: "border-gray-500 text-gray-700",
    WhatsApp: "border-[#008A00] text-[#008A00]",
  };
  const cls = map[source] || "border-gray-300 text-gray-600";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border ${cls} bg-white`}
      data-testid={`source-badge-${source}`}>
      {source}
    </span>
  );
}

export function QueryTypeBadge({ code, compact = false }) {
  const info = queryTypeInfo(code);
  if (!info) return null;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${info.color}`}
      title={info.label}
      data-testid={`query-type-badge-${code}`}>
      {compact ? info.short : info.label}
    </span>
  );
}

// Unified enquiry-type badge that works for both IndiaMART (single-char QUERY_TYPE like W/P/B)
// and free-text enquiry_type fields ("direct", "buyleads", etc) from ExportersIndia and others.
const FREE_TYPE_COLORS = {
  direct: "bg-[#F0F4FF] text-[#002FA7]",
  buyleads: "bg-[#FEF3C7] text-[#92400E]",
  inquiry: "bg-[#F0F9FF] text-[#0891B2]",
  catalog: "bg-[#ECFDF5] text-[#008A00]",
};

export function EnquiryTypeBadge({ lead }) {
  if (!lead) return null;
  // Prefer the explicit free-text enquiry_type, then fall back to IndiaMART's QUERY_TYPE code.
  const freeText = (lead.enquiry_type || "").trim();
  if (freeText) {
    const key = freeText.toLowerCase().replace(/[^a-z]/g, "");
    const cls = FREE_TYPE_COLORS[key] || "bg-gray-100 text-gray-800";
    return (
      <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${cls}`}
        title={`Enquiry type: ${freeText}`}
        data-testid={`enquiry-type-badge-${key || "generic"}`}>
        {freeText}
      </span>
    );
  }
  const code = lead.source_data?.QUERY_TYPE;
  return <QueryTypeBadge code={code} compact />;
}
