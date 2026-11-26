import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Fingerprint, WarningCircle } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

/* Punch status for the logged-in employee (never shown to admins):
   - a small chip in the top bar: punched in / not punched in / punched out
   - an amber banner while the office is open and they have not punched in
   - a red banner on the following days when a punch-out was missed, until the
     admin fixes it. Attendance only - no salary anywhere. */

const POLL_MS = 5 * 60 * 1000;

export function fmtPunch(t) {
  if (!t) return "";
  const hh = parseInt(String(t).slice(11, 13) || String(t).slice(0, 2), 10);
  const mm = String(t).length > 5 ? String(t).slice(14, 16) : String(t).slice(3, 5);
  if (Number.isNaN(hh)) return "";
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${mm} ${hh >= 12 ? "pm" : "am"}`;
}

export function fmtDay(d) {
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  } catch {
    return d;
  }
}

let _cache = null;
const _subs = new Set();

function useMyPunch() {
  const { user } = useAuth();
  const [data, setData] = useState(_cache);
  const enabled = !!user && user.role !== "admin" && user.username !== "scanner";
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const { data: d } = await api.get("/attendance/me", { params: { summary: true } });
      _cache = d;
      _subs.forEach((fn) => fn(d));
    } catch { /* ignore */ }
  }, [enabled]);
  useEffect(() => {
    _subs.add(setData);
    return () => { _subs.delete(setData); };
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const id = setInterval(load, POLL_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [enabled, load]);
  return enabled && data && data.tracked ? data : null;
}

export function PunchChip() {
  const d = useMyPunch();
  if (!d) return null;
  const t = d.today_punch || {};
  let cls = "bg-red-50 text-[#E60000] border-[#E60000]/30";
  let text = "Not punched in";
  if (t.checked_out) {
    cls = "bg-gray-50 text-gray-600 border-gray-300";
    text = `Punched out ${fmtPunch(t.check_out_time)}`;
  } else if (t.checked_in) {
    cls = "bg-green-50 text-green-700 border-green-600/30";
    text = `Punched in ${fmtPunch(t.check_in_time)}`;
  } else if (d.on_leave_today) {
    cls = "bg-gray-50 text-gray-600 border-gray-300";
    text = "On leave today";
  }
  return (
    <Link to="/my-attendance" title="My attendance"
      className={`inline-flex items-center gap-1 border px-2 py-1 text-[11px] font-bold whitespace-nowrap ${cls}`}
      data-testid="punch-chip">
      <Fingerprint size={14} weight="bold" /> {text}
    </Link>
  );
}

export default function AttendanceBanner() {
  const d = useMyPunch();
  if (!d) return null;
  const t = d.today_punch || {};
  const missing = d.missing_punch_out || [];
  const notIn = d.office_open && !t.checked_in && !d.on_leave_today;
  if (!missing.length && !notIn) return null;
  return (
    <div className="shrink-0" data-testid="attendance-banner">
      {missing.length > 0 && (
        <div className="bg-[#E60000] text-white px-4 py-2 text-xs md:text-sm flex items-start gap-2">
          <WarningCircle size={18} weight="fill" className="shrink-0 mt-0.5" />
          <div className="flex-1">
            <b>You did not punch out on {missing.map((m) => `${fmtDay(m.date)}${m.punch_in ? ` (in ${fmtPunch(m.punch_in)})` : ""}`).join(", ")}.</b>{" "}
            {missing.length > 1 ? "These days count" : "This day counts"} as a half day until it is fixed.
            Talk to the admin today and get it fixed immediately.{" "}
            <Link to="/my-attendance" className="underline font-bold whitespace-nowrap">My attendance</Link>
          </div>
        </div>
      )}
      {notIn && (
        <div className="bg-[#FFF4E0] text-[#8A4B00] border-b border-[#E67E00]/40 px-4 py-2 text-xs md:text-sm flex items-start gap-2">
          <Fingerprint size={18} weight="bold" className="shrink-0 mt-0.5" />
          <div className="flex-1">
            <b>You have not punched in today.</b> Scan your finger at the office device now. Until you do, the CRM treats you
            as absent and customers who message you are moved to other executives.
          </div>
        </div>
      )}
    </div>
  );
}
