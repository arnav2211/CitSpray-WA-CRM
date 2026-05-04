// IST-aware formatters + IndiaMART QUERY_TYPE mapping
const DTF_IST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

const TF_IST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

function _parse(iso) {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export function fmtIST(iso) {
  const d = _parse(iso);
  if (!d) return "—";
  const p = DTF_IST.formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute} IST`;
}

export function fmtISTTime(iso) {
  const d = _parse(iso);
  if (!d) return "—";
  return `${TF_IST.format(d)} IST`;
}

export function fmtISTShort(iso) {
  const d = _parse(iso);
  if (!d) return "—";
  const p = DTF_IST.formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

export const QUERY_TYPE_MAP = {
  W: { label: "Direct", short: "Direct", color: "bg-[#002FA7] text-white" },
  B: { label: "Buylead", short: "Buylead", color: "bg-[#008A00] text-white" },
  P: { label: "PNS", short: "PNS", color: "bg-[#E60000] text-white" },
  BIZ: { label: "Catalog", short: "Catalog", color: "bg-gray-200 text-gray-900" },
  WA: { label: "WhatsApp", short: "WhatsApp", color: "bg-[#FFCC00] text-gray-900" },
};

export function queryTypeInfo(code) {
  if (!code) return null;
  return QUERY_TYPE_MAP[code] || { label: code, short: code, color: "bg-gray-200 text-gray-900" };
}
