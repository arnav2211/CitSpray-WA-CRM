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
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} IST`;
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

// IST calendar-day key (YYYY-MM-DD) — used to group messages by the date the
// customer/agent saw them locally (Indian time), regardless of UTC drift.
const _DATE_IST = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
});
export function istDayKey(iso) {
  const d = _parse(iso);
  if (!d) return "";
  return _DATE_IST.format(d); // 2026-02-13
}

const _TIME12 = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true,
});
const _DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short",
});
const _FULL_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
});
const _WEEKDAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", weekday: "long",
});

function _todayIST() { return _DATE_IST.format(new Date()); }
function _yesterdayIST() {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 1);
  return _DATE_IST.format(d);
}

/**
 * Smart relative date formatter (WhatsApp-style):
 *  - Today  → "3:45 PM"
 *  - Yesterday → "Yesterday"
 *  - within last 7 days → weekday name ("Monday")
 *  - same calendar year → "12 Feb"
 *  - older → "12 Feb 2024"
 * Used in chat list previews where space is tight.
 */
export function fmtSmartShort(iso) {
  const d = _parse(iso);
  if (!d) return "";
  const k = _DATE_IST.format(d);
  const today = _todayIST();
  const yest = _yesterdayIST();
  if (k === today) return _TIME12.format(d);
  if (k === yest) return "Yesterday";
  const diffDays = Math.floor((new Date(today) - new Date(k)) / 86400000);
  if (diffDays > 0 && diffDays < 7) return _WEEKDAY.format(d);
  if (k.slice(0, 4) === today.slice(0, 4)) return _DAY_MONTH.format(d);
  return _FULL_DATE.format(d);
}

/**
 * Long form for individual chat-bubble timestamps:
 *  - Today → "Today, 3:45 PM"
 *  - Yesterday → "Yesterday, 3:45 PM"
 *  - older same year → "12 Feb, 2:30 PM"
 *  - older year → "12 Feb 2024, 2:30 PM"
 */
export function fmtSmartLong(iso) {
  const d = _parse(iso);
  if (!d) return "";
  const k = _DATE_IST.format(d);
  const today = _todayIST();
  const yest = _yesterdayIST();
  const time = _TIME12.format(d);
  if (k === today) return `Today, ${time}`;
  if (k === yest) return `Yesterday, ${time}`;
  if (k.slice(0, 4) === today.slice(0, 4)) return `${_DAY_MONTH.format(d)}, ${time}`;
  return `${_FULL_DATE.format(d)}, ${time}`;
}

/** Pretty label for the sticky day separator inside chats. */
export function fmtDaySeparator(dayKeyOrIso) {
  const isKey = /^\d{4}-\d{2}-\d{2}$/.test(dayKeyOrIso);
  const d = isKey ? new Date(`${dayKeyOrIso}T12:00:00+05:30`) : _parse(dayKeyOrIso);
  if (!d) return "";
  const k = _DATE_IST.format(d);
  const today = _todayIST();
  const yest = _yesterdayIST();
  if (k === today) return "Today";
  if (k === yest) return "Yesterday";
  const diffDays = Math.floor((new Date(today) - new Date(k)) / 86400000);
  if (diffDays > 0 && diffDays < 7) return _WEEKDAY.format(d);
  if (k.slice(0, 4) === today.slice(0, 4)) return _DAY_MONTH.format(d);
  return _FULL_DATE.format(d);
}

/** Bare time only (e.g. "3:45 PM") — for inside-bubble compact mode. */
export function fmtTime12(iso) {
  const d = _parse(iso);
  if (!d) return "";
  return _TIME12.format(d);
}

export const QUERY_TYPE_MAP = {
  W:   { label: "Direct Enquiry",    short: "Direct",   color: "bg-[#002FA7] text-white" },
  B:   { label: "Buy-Lead",          short: "Buy",      color: "bg-[#008A00] text-white" },
  P:   { label: "PNS Call",          short: "PNS",      color: "bg-[#E60000] text-white" },
  BIZ: { label: "Catalog View",      short: "Catalog",  color: "bg-gray-200 text-gray-900" },
  WA:  { label: "WhatsApp Enquiry",  short: "WhatsApp", color: "bg-[#FFCC00] text-gray-900" },
};

export function queryTypeInfo(code) {
  if (!code) return null;
  return QUERY_TYPE_MAP[code] || { label: code, short: code, color: "bg-gray-200 text-gray-900" };
}
