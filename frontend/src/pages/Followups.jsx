import React, { useEffect, useMemo, useState, useCallback } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import {
  CheckCircle, Clock, ArrowClockwise, WhatsappLogo, ArrowSquareOut, Phone,
  Package, Bell, MagnifyingGlass, Sparkle, PushPin, PencilSimple, CaretDown, CaretUp,
} from "@phosphor-icons/react";
import { fmtSmartLong, istDayKey } from "@/lib/format";
import LeadDrawer from "@/components/LeadDrawer";

/* Follow-ups: one clear list of what to do and when.
   - Overdue / Today / Tomorrow / This week / Later, each follow-up shows WHY it exists:
     AI after a call (with what the call was about), a promise, a reorder, or set by hand.
   - Reschedule to any time (it rings again then), snooze, mark done.
   - Admins can see everyone's or one person's. */

const POLL_MS = 30000;
const DAY = 86400000;

function addDaysKey(n) {
  return istDayKey(new Date(Date.now() + n * DAY).toISOString());
}

function bucketOf(f, now) {
  if (f.status === "done") return "done";
  if (f.snoozed) return "snoozed";
  if (f.kind === "reorder") return "reorder";
  const due = new Date(f.due_at).getTime();
  if (due < now - 30 * DAY) return "old";              // long forgotten - folded away at the bottom
  if (f.status === "missed" || due < now) return "overdue";
  const k = istDayKey(f.due_at);
  if (k === addDaysKey(0)) return "today";
  if (k === addDaysKey(1)) return "tomorrow";
  if (due - now < 7 * DAY) return "week";
  return "later";
}

const SECTIONS = [
  { k: "overdue", label: "Overdue", cls: "text-[#B00000]", dot: "bg-[#E60000]" },
  { k: "today", label: "Today", cls: "text-[#B85F00]", dot: "bg-[#E67E00]" },
  { k: "tomorrow", label: "Tomorrow", cls: "text-[#002FA7]", dot: "bg-[#002FA7]" },
  { k: "week", label: "This week", cls: "text-gray-700", dot: "bg-gray-400" },
  { k: "later", label: "Later", cls: "text-gray-500", dot: "bg-gray-300" },
  { k: "old", label: "Old - more than 30 days overdue", cls: "text-gray-500", dot: "bg-gray-300", collapsed: true },
];

const TABS = [
  { k: "todo", label: "To do" },
  { k: "reorder", label: "Reorders" },
  { k: "snoozed", label: "Snoozed" },
  { k: "done", label: "Done" },
];

function relative(iso, now) {
  const t = new Date(iso).getTime();
  const mins = Math.round((t - now) / 60000);
  const abs = Math.abs(mins);
  const s = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} day${Math.round(abs / 1440) === 1 ? "" : "s"}`;
  return mins < 0 ? `${s} overdue` : `in ${s}`;
}

function nextAt(daysAhead, hour, minute = 0, weekday = null) {
  // a time in IST (the team works in IST); weekday 1 = Monday
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  let d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + daysAhead, hour, minute));
  if (weekday !== null) {
    while (d.getUTCDay() !== weekday || d.getTime() <= ist.getTime()) d = new Date(d.getTime() + DAY);
  }
  return new Date(d.getTime() - 5.5 * 3600 * 1000).toISOString();
}

export default function Followups() {
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [items, setItems] = useState([]);
  const [people, setPeople] = useState([]);
  const [person, setPerson] = useState(isAdmin ? "" : null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("todo");
  const [q, setQ] = useState("");
  const [openLeadId, setOpenLeadId] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [showOld, setShowOld] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { view: "board" };
      if (isAdmin && person) params.exec_id = person;
      const { data } = await api.get("/followups", { params });
      setItems(Array.isArray(data?.items) ? data.items : []);
      if (data?.people?.length) setPeople(data.people);
      setNow(Date.now());
    } catch (e) { toast.error(errMsg(e)); }
    finally { setLoading(false); }
  }, [isAdmin, person]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const patch = async (f, body, msg) => {
    try {
      await api.patch(`/followups/${f.id}`, body);
      toast.success(msg);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };
  const markDone = (f) => {
    setItems((prev) => prev.map((x) => (x.id === f.id ? { ...x, status: "done", completed_at: new Date().toISOString() } : x)));
    patch(f, { status: "done" }, "Marked done");
  };
  const reschedule = (f, iso, label) => patch(f, { due_at: iso }, `Rescheduled to ${label}`);
  const editNote = (f) => {
    const note = window.prompt("Follow-up note", f.note || "");
    if (note === null) return;
    patch(f, { note }, "Note saved");
  };

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return items.filter((f) => !ql ||
      (f.lead_customer_name || "").toLowerCase().includes(ql) ||
      (f.lead_phone || "").toLowerCase().includes(ql) ||
      (f.note || "").toLowerCase().includes(ql) ||
      (f.owner_name || "").toLowerCase().includes(ql))
      .map((f) => ({ ...f, _b: bucketOf(f, now) }));
  }, [items, q, now]);

  const counts = useMemo(() => {
    const c = { overdue: 0, today: 0, todo: 0, reorder: 0, snoozed: 0, done: 0, old: 0 };
    rows.forEach((f) => {
      if (["overdue", "today", "tomorrow", "week", "later", "old"].includes(f._b)) c.todo += 1;
      if (f._b in c) c[f._b] += 1;
    });
    return c;
  }, [rows]);

  const listFor = (b) => rows.filter((f) => f._b === b)
    .sort((a, z) => (b === "done" ? new Date(z.completed_at) - new Date(a.completed_at) : new Date(a.due_at) - new Date(z.due_at)));

  return (
    <div className="p-4 md:p-8 space-y-4" data-testid="followups-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1.5">
            <Bell size={12} weight="bold" /> Schedule
          </div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Follow-ups</h1>
          <p className="text-xs mt-1">
            {counts.overdue > 0 && <span className="text-[#E60000] font-bold">{counts.overdue} overdue · </span>}
            <span className="text-gray-600">{counts.today} due today · {counts.todo} open in total</span>
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="border border-gray-900 hover:bg-gray-900 hover:text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50">
          <ArrowClockwise size={12} weight="bold" /> {loading ? "…" : "Refresh"}
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {TABS.map((t) => {
          const n = t.k === "todo" ? counts.todo : counts[t.k];
          return (
            <button key={t.k} onClick={() => setTab(t.k)} data-testid={`fu-tab-${t.k}`}
              className={`px-3 py-1.5 text-[11px] uppercase tracking-widest font-bold border ${tab === t.k ? "bg-[#002FA7] text-white border-[#002FA7]" : "border-gray-300 bg-white hover:bg-gray-100"}`}>
              {t.label}{n ? ` (${n})` : ""}
            </button>
          );
        })}
        {isAdmin && (
          <select value={person} onChange={(e) => setPerson(e.target.value)} className="border border-gray-300 px-2 py-1.5 text-xs" data-testid="fu-person">
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <div className="flex items-center border border-gray-300 bg-white flex-1 min-w-[180px] max-w-xs md:ml-auto">
          <MagnifyingGlass size={14} className="ml-2 text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer, phone, note…"
            className="flex-1 px-2 py-2 text-sm outline-none min-w-0" data-testid="fu-search" />
        </div>
      </div>

      {tab === "todo" && (
        <div className="space-y-5">
          {counts.todo === 0 && <Empty loading={loading} text="Nothing to follow up - all clear." />}
          {SECTIONS.map((s) => {
            const list = listFor(s.k);
            if (!list.length) return null;
            const hidden = s.collapsed && !showOld;
            return (
              <section key={s.k}>
                <button type="button" onClick={() => s.collapsed && setShowOld((v) => !v)}
                  className={`text-[11px] uppercase tracking-widest font-bold mb-2 flex items-center gap-2 ${s.cls}`}>
                  <span className={`w-2 h-2 rounded-full ${s.dot}`} /> {s.label} ({list.length})
                  {s.collapsed && <span className="normal-case tracking-normal font-normal underline">{showOld ? "hide" : "show"}</span>}
                </button>
                {!hidden && <div className="space-y-2">
                  {list.map((f) => <Card key={f.id} f={f} now={now} showOwner={isAdmin && !person} nav={nav}
                    onOpen={() => setOpenLeadId(f.lead_id)} onDone={() => markDone(f)} onResched={(iso, l) => reschedule(f, iso, l)} onNote={() => editNote(f)} />)}
                </div>}
              </section>
            );
          })}
        </div>
      )}
      {tab !== "todo" && (
        <div className="space-y-2">
          {tab === "reorder" && <p className="text-xs text-gray-500">Customers who have not reordered for a while - call them when you can (no fixed time).</p>}
          {tab === "snoozed" && <p className="text-xs text-gray-500">Snoozed follow-ups come back and ring at the time shown.</p>}
          {tab === "done" && <p className="text-xs text-gray-500">Completed in the last 14 days.</p>}
          {listFor(tab).length === 0 && <Empty loading={loading} text="Nothing here." />}
          {listFor(tab).map((f) => <Card key={f.id} f={f} now={now} showOwner={isAdmin && !person} nav={nav}
            onOpen={() => setOpenLeadId(f.lead_id)} onDone={() => markDone(f)} onResched={(iso, l) => reschedule(f, iso, l)} onNote={() => editNote(f)} />)}
        </div>
      )}

      {openLeadId && <LeadDrawer leadId={openLeadId} onClose={() => { setOpenLeadId(null); load(); }} />}
    </div>
  );
}

function Empty({ loading, text }) {
  return (
    <div className="border border-dashed border-gray-300 bg-gray-50/50 py-12 text-center">
      <CheckCircle size={36} weight="light" className="mx-auto text-gray-300 mb-2" />
      <div className="text-xs uppercase tracking-widest text-gray-400 font-bold">{loading ? "Loading…" : text}</div>
    </div>
  );
}

function Origin({ f }) {
  const chip = "inline-flex items-center gap-1 border px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold rounded-sm";
  if (f.kind === "ai_call") return <span className={`${chip} bg-[#F5F3FF] border-[#7C3AED] text-[#6D28D9]`}><Sparkle size={10} weight="fill" /> AI · from a call</span>;
  if (f.kind === "ai_promise") return <span className={`${chip} bg-[#FFF4E5] border-[#E67E00] text-[#B85F00]`}><PushPin size={10} weight="fill" /> Promise to send</span>;
  if (f.kind === "reorder") return <span className={`${chip} bg-[#F3E8FF] border-[#7C3AED] text-[#6D28D9]`}><Package size={10} weight="bold" /> Reorder</span>;
  return <span className={`${chip} bg-gray-50 border-gray-300 text-gray-600`}>{f.created_by_name ? `Set by ${f.created_by_name}` : "Set automatically"}</span>;
}

function Card({ f, now, showOwner, nav, onOpen, onDone, onResched, onNote }) {
  const [menu, setMenu] = useState(false);
  const [showCall, setShowCall] = useState(false);
  const [custom, setCustom] = useState("");
  const done = f.status === "done";
  const overdue = f._b === "overdue";
  const note = (f.note || "").replace(/^AI:\s*/, "");
  return (
    <div className={`border bg-white p-3 ${done ? "opacity-70" : ""} ${overdue ? "border-l-4 border-l-[#E60000]" : ""}`} data-testid={`followup-${f.id}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={onOpen} className="font-semibold text-sm hover:underline text-gray-900 truncate max-w-full text-left">{f.lead_customer_name || "Unknown lead"}</button>
            {f.lead_phone && <a href={`tel:${f.lead_phone}`} className="text-[11px] text-gray-500 font-mono hover:underline">{f.lead_phone}</a>}
            {f.lead_status && <span className="text-[9px] uppercase tracking-widest font-bold text-gray-500 border border-gray-200 px-1">{f.lead_status}</span>}
            <Origin f={f} />
            {showOwner && f.owner_name && <span className="text-[10px] text-gray-500">· {f.owner_name}</span>}
          </div>
          <div className="text-sm text-gray-800 mt-1 whitespace-pre-wrap break-words">{note || <span className="text-gray-400">No note</span>}</div>
          {f.call && (
            <div className="mt-1">
              <button onClick={() => setShowCall((v) => !v)} className="text-[11px] text-[#6D28D9] font-semibold flex items-center gap-1">
                {f.call.direction === "incoming" ? "Incoming" : "Outgoing"} call {fmtSmartLong(f.call.at)} · {Math.round((f.call.duration_seconds || 0) / 60)} min
                {f.call.summary ? (showCall ? <CaretUp size={10} /> : <CaretDown size={10} />) : null}
              </button>
              {showCall && f.call.summary && <div className="text-xs text-gray-600 bg-[#F5F3FF] p-2 mt-1">{f.call.summary}</div>}
            </div>
          )}
          {!f.call && f.lead_requirement && <div className="text-[11px] text-gray-500 mt-0.5">Requirement: {f.lead_requirement}</div>}
          <div className={`text-[11px] mt-1 font-semibold ${overdue ? "text-[#B00000]" : "text-gray-500"}`}>
            {done ? `Done ${fmtSmartLong(f.completed_at)}`
              : f.kind === "reorder" ? "Reorder - call when you can"
              : f.snoozed ? `Snoozed until ${fmtSmartLong(f.snoozed_until)}`
              : `${fmtSmartLong(f.due_at)} · ${relative(f.due_at, now)}`}
            {f.created_at && !done && <span className="text-gray-400 font-normal"> · set {fmtSmartLong(f.created_at)}</span>}
          </div>
        </div>
        {!done && (
          <div className="flex items-center gap-1 shrink-0 relative w-full sm:w-auto justify-end">
            {f.lead_phone && (
              <a href={`tel:${f.lead_phone}`} title="Call" className="p-1.5 text-[#002FA7] hover:bg-[#002FA7]/10 rounded"><Phone size={18} weight="fill" /></a>
            )}
            <button onClick={() => nav(`/chat?lead=${f.lead_id}`)} title="WhatsApp chat" className="p-1.5 text-[#128C7E] hover:bg-[#128C7E]/10 rounded"><WhatsappLogo size={18} weight="fill" /></button>
            <button onClick={onOpen} title="Open lead" className="p-1.5 text-[#002FA7] hover:bg-[#002FA7]/10 rounded"><ArrowSquareOut size={17} weight="bold" /></button>
            <button onClick={onNote} title="Edit note" className="p-1.5 text-gray-500 hover:bg-gray-100 rounded"><PencilSimple size={16} /></button>
            <div className="relative">
              <button onClick={() => setMenu((v) => !v)} title="Reschedule" data-testid={`fu-resched-${f.id}`}
                className="px-2 py-1.5 text-gray-600 hover:bg-gray-100 rounded flex items-center gap-1 text-[11px] font-semibold border border-gray-200">
                <Clock size={14} /> Later <CaretDown size={9} />
              </button>
              {menu && (
                <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 shadow-lg z-20 w-56 py-1">
                  {[
                    ["In 1 hour", new Date(Date.now() + 3600e3).toISOString()],
                    ["In 3 hours", new Date(Date.now() + 3 * 3600e3).toISOString()],
                    ["Tomorrow 11:00 AM", nextAt(1, 11)],
                    ["Tomorrow 4:00 PM", nextAt(1, 16)],
                    ["Next Monday 11:00 AM", nextAt(1, 11, 0, 1)],
                  ].map(([l, iso]) => (
                    <button key={l} onClick={() => { setMenu(false); onResched(iso, l); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50">{l}</button>
                  ))}
                  <div className="border-t border-gray-100 px-3 py-2 space-y-1">
                    <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Pick date & time</div>
                    <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} className="w-full border border-gray-300 px-1 py-1 text-xs" />
                    <button disabled={!custom} onClick={() => { setMenu(false); onResched(new Date(custom).toISOString(), fmtSmartLong(new Date(custom).toISOString())); }}
                      className="w-full bg-[#002FA7] text-white text-[11px] font-bold py-1 disabled:opacity-40">Set</button>
                  </div>
                </div>
              )}
            </div>
            <button onClick={onDone} title="Mark done" data-testid={`fu-done-${f.id}`}
              className="px-2 py-1.5 text-white bg-[#008A00] hover:bg-[#006E00] rounded flex items-center gap-1 text-[11px] font-bold">
              <CheckCircle size={14} weight="fill" /> Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
