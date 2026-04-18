import React from "react";

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
