import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { StatusBadge, SourceBadge, QueryTypeBadge } from "@/components/Badges";
import { X, Phone, EnvelopeSimple, MapPin, ArrowSquareOut, PaperPlaneRight, Clock, CalendarBlank, NotePencil } from "@phosphor-icons/react";
import { fmtIST, fmtISTTime, queryTypeInfo } from "@/lib/format";

const STATUSES = ["new", "contacted", "qualified", "converted", "lost"];

export default function LeadDrawer({ leadId, onClose }) {
  const { user } = useAuth();
  const [lead, setLead] = useState(null);
  const [messages, setMessages] = useState([]);
  const [activity, setActivity] = useState([]);
  const [execs, setExecs] = useState([]);
  const [tpl, setTpl] = useState([]);
  const [noteText, setNoteText] = useState("");
  const [waText, setWaText] = useState("");
  const [fuDate, setFuDate] = useState("");
  const [fuNote, setFuNote] = useState("");

  const loadAll = async () => {
    try {
      const [{ data: L }, { data: M }, { data: A }] = await Promise.all([
        api.get(`/leads/${leadId}`),
        api.get(`/leads/${leadId}/messages`),
        api.get(`/leads/${leadId}/activity`),
      ]);
      setLead(L); setMessages(M); setActivity(A);
    } catch (e) { toast.error(errMsg(e)); onClose?.(); }
  };

  useEffect(() => {
    (async () => {
      try {
        const [{ data: U }, { data: T }] = await Promise.all([
          api.get("/users"),
          api.get("/whatsapp/templates"),
        ]);
        setExecs(U.filter((u) => u.role === "executive"));
        setTpl(T);
      } catch { /* empty */ }
    })();
    loadAll();
    // eslint-disable-next-line
  }, [leadId]);

  if (!lead) {
    return (
      <div className="fixed inset-0 bg-black/40 z-40 flex justify-end" onClick={onClose}>
        <div className="w-full max-w-4xl bg-white border-l border-gray-200 p-8 text-xs uppercase tracking-widest text-gray-500">
          Loading…
        </div>
      </div>
    );
  }

  const isAdmin = user.role === "admin";
  const assignedExec = execs.find((e) => e.id === lead.assigned_to);

  const update = async (patch) => {
    try {
      const { data } = await api.patch(`/leads/${leadId}`, patch);
      setLead(data);
      toast.success("Updated");
    } catch (e) { toast.error(errMsg(e)); }
  };

  const addNote = async () => {
    if (!noteText.trim()) return;
    try {
      await api.post(`/leads/${leadId}/notes`, { body: noteText });
      setNoteText("");
      loadAll();
      toast.success("Note added");
    } catch (e) { toast.error(errMsg(e)); }
  };

  const sendWA = async () => {
    if (!waText.trim()) return;
    try {
      await api.post(`/whatsapp/send`, { lead_id: leadId, body: waText });
      setWaText("");
      loadAll();
      toast.success("WhatsApp sent (mock)");
    } catch (e) { toast.error(errMsg(e)); }
  };

  const applyTemplate = (t) => {
    const body = (t.body || "").replace("{{name}}", lead.customer_name || "");
    setWaText(body);
  };

  const reassign = async (userId) => {
    try {
      await api.post(`/leads/${leadId}/reassign`, { assigned_to: userId });
      loadAll();
      toast.success("Reassigned");
    } catch (e) { toast.error(errMsg(e)); }
  };

  const scheduleFollowup = async () => {
    if (!fuDate) { toast.error("Pick a date/time"); return; }
    try {
      const dueIso = new Date(fuDate).toISOString();
      await api.post("/followups", { lead_id: leadId, due_at: dueIso, note: fuNote });
      setFuDate(""); setFuNote("");
      toast.success("Follow-up scheduled");
      loadAll();
    } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex justify-end" onClick={onClose} data-testid="lead-drawer">
      <div className="w-full max-w-5xl bg-white border-l border-gray-200 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 p-5 flex items-start justify-between z-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <SourceBadge source={lead.source} />
              <QueryTypeBadge code={lead.source_data?.QUERY_TYPE} />
              <StatusBadge status={lead.status} />
              {!lead.opened_at && <span className="text-[10px] uppercase tracking-widest font-bold text-[#E60000]">Unopened</span>}
            </div>
            <h2 className="font-chivo font-black text-3xl mt-2 leading-tight">{lead.customer_name}</h2>
            <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {lead.phone && <span className="flex items-center gap-1"><Phone size={12} /> {lead.phone}</span>}
              {lead.email && <span className="flex items-center gap-1"><EnvelopeSimple size={12} /> {lead.email}</span>}
              {(lead.area || lead.city || lead.state) && (
                <span className="flex items-center gap-1"><MapPin size={12} /> {[lead.area, lead.city, lead.state].filter(Boolean).join(", ")}</span>
              )}
              {lead.source_data?.QUERY_TYPE === "P" && lead.source_data?.RECEIVER_MOBILE && (
                <span className="flex items-center gap-1 text-[#E60000] font-bold" data-testid="pns-receiver">
                  <Phone size={12} weight="fill" /> PNS received on: {lead.source_data.RECEIVER_MOBILE}
                </span>
              )}
              {lead.source_data?.QUERY_TYPE === "P" && lead.source_data?.CALL_DURATION && (
                <span className="text-gray-500">Call duration: {lead.source_data.CALL_DURATION}s</span>
              )}
              <span className="flex items-center gap-1 text-gray-500">
                <Clock size={12} /> {fmtIST(lead.created_at)}
              </span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900 p-2" data-testid="lead-drawer-close">
            <X size={20} />
          </button>
        </div>

        {/* Action bar */}
        <div className="px-5 py-3 border-b border-gray-200 flex flex-wrap items-center gap-2 bg-gray-50">
          {lead.contact_link && (
            <a href={lead.contact_link} target="_blank" rel="noreferrer"
              className="border border-gray-900 px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 hover:bg-gray-900 hover:text-white"
              data-testid="open-justdial-btn"
            >
              Open Justdial Lead <ArrowSquareOut size={12} />
            </a>
          )}
          <select value={lead.status} onChange={(e) => update({ status: e.target.value })} className="border border-gray-300 px-2 py-2 text-sm" data-testid="lead-status-select">
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {isAdmin && (
            <select value={lead.assigned_to || ""} onChange={(e) => e.target.value && reassign(e.target.value)} className="border border-gray-300 px-2 py-2 text-sm" data-testid="lead-reassign-select">
              <option value="">— Reassign —</option>
              {execs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          )}
          <div className="text-xs text-gray-500 ml-auto flex items-center gap-1">
            <Clock size={12} />
            Currently: <span className="font-bold text-gray-900">{assignedExec?.name || "Unassigned"}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-0">
          {/* Left: details + notes + followup + activity */}
          <div className="lg:col-span-3 border-r border-gray-200 p-5 space-y-6">
            <section>
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2 flex items-center gap-1"><NotePencil size={12} /> Requirement</div>
              <div className="border border-gray-200 p-3 text-sm bg-gray-50">{lead.requirement || "—"}</div>
            </section>

            <section>
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2">Notes</div>
              <div className="space-y-2 mb-3">
                {(lead.notes || []).slice().reverse().map((n) => (
                  <div key={n.id} className="border border-gray-200 p-3 bg-white">
                    <div className="text-xs text-gray-500 flex justify-between">
                      <span className="font-bold uppercase tracking-widest text-[10px]">{n.by_name}</span>
                      <span className="font-mono">{fmtIST(n.at)}</span>
                    </div>
                    <div className="text-sm mt-1">{n.body}</div>
                  </div>
                ))}
                {(!lead.notes || lead.notes.length === 0) && <div className="text-xs text-gray-400 uppercase tracking-widest">No notes yet</div>}
              </div>
              <div className="flex gap-2">
                <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note…"
                  className="flex-1 border border-gray-300 px-3 py-2 text-sm" data-testid="lead-note-input" />
                <button onClick={addNote} className="bg-gray-900 text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold" data-testid="lead-note-add-btn">Add Note</button>
              </div>
            </section>

            <section>
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2 flex items-center gap-1"><CalendarBlank size={12} /> Schedule Follow-up</div>
              <div className="flex flex-wrap gap-2">
                <input type="datetime-local" value={fuDate} onChange={(e) => setFuDate(e.target.value)} className="border border-gray-300 px-2 py-2 text-sm" data-testid="followup-date-input" />
                <input value={fuNote} onChange={(e) => setFuNote(e.target.value)} placeholder="Note (optional)"
                  className="flex-1 border border-gray-300 px-3 py-2 text-sm" data-testid="followup-note-input" />
                <button onClick={scheduleFollowup} className="border border-gray-900 px-3 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-900 hover:text-white" data-testid="followup-submit-btn">
                  Schedule
                </button>
              </div>
            </section>

            <section>
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2">Activity</div>
              <div className="border-l border-gray-300 pl-4 space-y-2">
                {activity.map((a) => (
                  <div key={a.id} className="text-xs">
                    <span className="font-mono text-gray-500">{fmtIST(a.at)}</span>
                    <span className="mx-2 text-gray-400">·</span>
                    <span className="font-bold uppercase tracking-widest">{a.action.replace(/_/g, " ")}</span>
                  </div>
                ))}
                {activity.length === 0 && <div className="text-xs text-gray-400 uppercase tracking-widest">No activity</div>}
              </div>
            </section>
          </div>

          {/* Right: WhatsApp panel */}
          <div className="lg:col-span-2 wa-panel flex flex-col min-h-[560px]">
            <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-widest font-bold text-white/60">WhatsApp Thread</div>
              <span className="text-[10px] uppercase tracking-widest font-bold text-[#FFCC00]">MOCK</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                  <div className={`${m.direction === "out" ? "wa-bubble-out" : "wa-bubble-in"} max-w-[75%] px-3 py-2 text-sm`} data-testid={`wa-msg-${m.id}`}>
                    {m.template_name && <div className="text-[9px] uppercase tracking-widest opacity-70 mb-1">Template · {m.template_name}</div>}
                    <div>{m.body}</div>
                    <div className="text-[9px] opacity-70 mt-1 font-mono">{fmtISTTime(m.at)}</div>
                  </div>
                </div>
              ))}
              {messages.length === 0 && <div className="text-xs uppercase tracking-widest text-white/40 text-center py-10">No messages yet</div>}
            </div>
            {tpl.length > 0 && (
              <div className="px-3 pt-2 flex flex-wrap gap-1 border-t border-white/10">
                {tpl.map((t) => (
                  <button key={t.id} onClick={() => applyTemplate(t)} className="text-[10px] uppercase tracking-widest font-bold border border-white/20 px-2 py-1 hover:bg-white/10" data-testid={`wa-tpl-${t.name}`}>
                    {t.name}
                  </button>
                ))}
              </div>
            )}
            <div className="p-3 border-t border-white/10 flex gap-2">
              <input value={waText} onChange={(e) => setWaText(e.target.value)} placeholder="Type a message…"
                className="flex-1 bg-[#1E293B] text-white border border-white/10 px-3 py-2 text-sm outline-none" data-testid="wa-input" />
              <button onClick={sendWA} className="bg-[#008A00] text-white px-3 py-2 flex items-center gap-1 text-[10px] uppercase tracking-widest font-bold" data-testid="wa-send-btn">
                <PaperPlaneRight size={14} /> Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
