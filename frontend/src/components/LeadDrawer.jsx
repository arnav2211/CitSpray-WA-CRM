import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { StatusBadge, SourceBadge, QueryTypeBadge } from "@/components/Badges";
import { X, Phone, EnvelopeSimple, MapPin, ArrowSquareOut, PaperPlaneRight, Clock, CalendarBlank, NotePencil, Plus, Trash, Info, PhoneCall, WhatsappLogo, Star, PencilSimple, Check } from "@phosphor-icons/react";
import { fmtIST, fmtISTTime, queryTypeInfo } from "@/lib/format";

const STATUSES = ["new", "contacted", "qualified", "converted", "lost"];

const CALL_OUTCOMES = [
  { v: "connected", label: "Connected (Call Answered)" },
  { v: "no_response", label: "No Response (PNR)" },
  { v: "rejected", label: "Rejected (Call Declined)" },
  { v: "not_reachable", label: "Not Reachable / Switched Off" },
  { v: "busy", label: "Busy / Engaged" },
  { v: "invalid", label: "Invalid number" },
];

const OUTCOME_COLOR = {
  connected: "text-[#008A00]",
  no_response: "text-[#FF8800]",
  rejected: "text-[#E60000]",
  not_reachable: "text-gray-500",
  busy: "text-[#FFCC00]",
  invalid: "text-[#E60000]",
};

export default function LeadDrawer({ leadId, onClose }) {
  const { user } = useAuth();
  const [lead, setLead] = useState(null);
  const [messages, setMessages] = useState([]);
  const [activity, setActivity] = useState([]);
  const [calls, setCalls] = useState([]);
  const [execs, setExecs] = useState([]);
  const [tpl, setTpl] = useState([]);
  const [noteText, setNoteText] = useState("");
  const [waText, setWaText] = useState("");
  const [fuDate, setFuDate] = useState("");
  const [fuNote, setFuNote] = useState("");
  const [showActivity, setShowActivity] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [aliasDraft, setAliasDraft] = useState("");
  const [editingReq, setEditingReq] = useState(false);
  const [reqDraft, setReqDraft] = useState("");
  // Call form
  const [callOutcome, setCallOutcome] = useState("");
  const [callPhone, setCallPhone] = useState("");
  const [callSummary, setCallSummary] = useState("");
  const [savingCall, setSavingCall] = useState(false);

  const loadAll = async () => {
    try {
      const [{ data: L }, { data: M }, { data: A }, { data: C }] = await Promise.all([
        api.get(`/leads/${leadId}`),
        api.get(`/leads/${leadId}/messages`),
        api.get(`/leads/${leadId}/activity`),
        api.get(`/leads/${leadId}/calls`),
      ]);
      setLead(L); setMessages(M); setActivity(A); setCalls(C);
      if (!callPhone) setCallPhone(L.phone || "");
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
  const canEdit = isAdmin || lead.assigned_to === user.id;
  const assignedExec = execs.find((e) => e.id === lead.assigned_to);

  const update = async (patch) => {
    try {
      const { data } = await api.patch(`/leads/${leadId}`, patch);
      setLead(data);
      toast.success("Updated");
    } catch (e) { toast.error(errMsg(e)); }
  };

  const saveName = async () => {
    const aliases = aliasDraft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await update({ customer_name: nameDraft.trim() || lead.customer_name, aliases });
    setEditingName(false);
  };

  const saveRequirement = async () => {
    await update({ requirement: reqDraft });
    setEditingReq(false);
  };

  const submitCall = async () => {
    if (!callOutcome) { toast.error("Pick a call outcome"); return; }
    if (!callPhone) { toast.error("Pick a phone number"); return; }
    if (callOutcome === "connected" && !callSummary.trim()) { toast.error("Summary required for connected calls"); return; }
    setSavingCall(true);
    try {
      await api.post(`/leads/${leadId}/calls`, {
        phone: callPhone,
        outcome: callOutcome,
        summary: callOutcome === "connected" ? callSummary.trim() : null,
      });
      setCallOutcome(""); setCallSummary("");
      loadAll();
      toast.success("Call logged");
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSavingCall(false); }
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
      toast.success("WhatsApp sent");
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
        <div className="sticky top-0 bg-white border-b border-gray-200 p-4 md:p-5 flex items-start justify-between z-10">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <SourceBadge source={lead.source} />
              <QueryTypeBadge code={lead.source_data?.QUERY_TYPE} />
              <StatusBadge status={lead.status} />
              {!lead.opened_at && <span className="text-[10px] uppercase tracking-widest font-bold text-[#E60000]">Unopened</span>}
            </div>
            {/* Name + alias edit */}
            {editingName ? (
              <div className="mt-2 space-y-2">
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="w-full border border-gray-300 px-3 py-2 text-2xl font-chivo font-black"
                  placeholder="Customer name"
                  data-testid="edit-name-input"
                />
                <input
                  value={aliasDraft}
                  onChange={(e) => setAliasDraft(e.target.value)}
                  className="w-full border border-gray-300 px-3 py-1.5 text-sm"
                  placeholder="Aliases (comma-separated, e.g. Mr Steel, Steel Buyer)"
                  data-testid="edit-aliases-input"
                />
                <div className="flex gap-2">
                  <button onClick={saveName} className="bg-[#002FA7] text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="save-name-btn">
                    <Check size={12} weight="bold" /> Save
                  </button>
                  <button onClick={() => setEditingName(false)} className="border border-gray-300 px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold">Cancel</button>
                </div>
              </div>
            ) : (
              <h2 className="font-chivo font-black text-2xl md:text-3xl mt-2 leading-tight break-words flex items-baseline gap-2 flex-wrap">
                <span>{lead.customer_name}</span>
                {canEdit && (
                  <button
                    onClick={() => { setNameDraft(lead.customer_name || ""); setAliasDraft((lead.aliases || []).join(", ")); setEditingName(true); }}
                    className="text-gray-400 hover:text-[#002FA7] p-1"
                    title="Edit name + aliases"
                    data-testid="edit-name-btn"
                  >
                    <PencilSimple size={14} />
                  </button>
                )}
              </h2>
            )}
            {(lead.aliases || []).length > 0 && !editingName && (
              <div className="text-xs text-gray-500 mt-1" data-testid="aliases-display">
                aka {(lead.aliases || []).join(" · ")}
              </div>
            )}
            <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
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
            <PhonesRow lead={lead} canEdit={canEdit} onChanged={loadAll} />
          </div>
          <div className="flex items-start gap-1 shrink-0">
            <button onClick={() => setShowActivity(true)} className="border border-gray-300 hover:bg-gray-100 p-2" title="Lead activity & history" data-testid="open-activity-btn">
              <Info size={18} weight="regular" />
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-900 p-2" data-testid="lead-drawer-close">
              <X size={20} />
            </button>
          </div>
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
          {/* Left: details + call log + notes + followup (activity log REMOVED — open via i-button) */}
          <div className="lg:col-span-3 border-r border-gray-200 p-5 space-y-6">
            <section>
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2 flex items-center gap-1 justify-between">
                <span className="flex items-center gap-1"><NotePencil size={12} /> Requirement</span>
                {canEdit && !editingReq && (
                  <button onClick={() => { setReqDraft(lead.requirement || ""); setEditingReq(true); }} className="text-[#002FA7] text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="edit-requirement-btn">
                    <PencilSimple size={11} /> Edit
                  </button>
                )}
              </div>
              {editingReq ? (
                <div className="space-y-2">
                  <textarea
                    value={reqDraft}
                    onChange={(e) => setReqDraft(e.target.value)}
                    rows={3}
                    className="w-full border border-gray-300 p-2 text-sm"
                    data-testid="edit-requirement-input"
                  />
                  <div className="flex gap-2">
                    <button onClick={saveRequirement} className="bg-[#002FA7] text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold" data-testid="save-requirement-btn">Save</button>
                    <button onClick={() => setEditingReq(false)} className="border border-gray-300 px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="border border-gray-200 p-3 text-sm bg-gray-50 whitespace-pre-wrap" data-testid="requirement-display">{lead.requirement || "—"}</div>
              )}
            </section>

            {lead.source === "IndiaMART" && lead.source_data && (
              <section data-testid="indiamart-details-section">
                <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2">IndiaMART Details</div>
                <div className="border border-gray-200 bg-white divide-y divide-gray-200">
                  {lead.source_data.QUERY_PRODUCT_NAME && (
                    <DetailRow k="Product" v={lead.source_data.QUERY_PRODUCT_NAME} testId="im-product" />
                  )}
                  {lead.source_data.QUERY_MCAT_NAME && lead.source_data.QUERY_MCAT_NAME !== lead.source_data.QUERY_PRODUCT_NAME && (
                    <DetailRow k="Category" v={lead.source_data.QUERY_MCAT_NAME} />
                  )}
                  {lead.source_data.QUERY_MESSAGE && (
                    <div className="px-3 py-2" data-testid="im-query-message">
                      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Buyer's message</div>
                      <div className="text-sm mt-1 whitespace-pre-wrap leading-relaxed">{lead.source_data.QUERY_MESSAGE}</div>
                    </div>
                  )}
                  {lead.source_data.SENDER_COMPANY && (
                    <DetailRow k="Company" v={lead.source_data.SENDER_COMPANY} />
                  )}
                  {(lead.source_data.SENDER_MOBILE_ALT || lead.source_data.SENDER_PHONE || lead.source_data.SENDER_PHONE_ALT) && (
                    <DetailRow k="Alt numbers" v={[lead.source_data.SENDER_MOBILE_ALT, lead.source_data.SENDER_PHONE, lead.source_data.SENDER_PHONE_ALT].filter(Boolean).join(" · ")} mono />
                  )}
                  {lead.source_data.SENDER_EMAIL_ALT && (
                    <DetailRow k="Alt email" v={lead.source_data.SENDER_EMAIL_ALT} mono />
                  )}
                  {lead.source_data.SENDER_PINCODE && (
                    <DetailRow k="Pincode" v={lead.source_data.SENDER_PINCODE} mono />
                  )}
                  {lead.source_data.QUERY_TIME && (
                    <DetailRow k="IndiaMART query time" v={lead.source_data.QUERY_TIME} mono />
                  )}
                  {lead.source_data.UNIQUE_QUERY_ID && (
                    <DetailRow k="IndiaMART ID" v={lead.source_data.UNIQUE_QUERY_ID} mono />
                  )}
                </div>
              </section>
            )}

            {/* Call activity */}
            <CallLogSection
              lead={lead}
              calls={calls}
              canEdit={canEdit}
              callOutcome={callOutcome} setCallOutcome={setCallOutcome}
              callPhone={callPhone} setCallPhone={setCallPhone}
              callSummary={callSummary} setCallSummary={setCallSummary}
              savingCall={savingCall}
              onSubmit={submitCall}
            />

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
          </div>

          {/* Right: WhatsApp panel */}
          <div className="lg:col-span-2 wa-panel flex flex-col min-h-[560px]">
            <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-widest font-bold text-white/60 flex items-center gap-1">
                <WhatsappLogo size={12} /> WhatsApp Thread
              </div>
              <div className="text-[10px] uppercase tracking-widest font-bold text-white/60 font-mono">
                {lead.active_wa_phone || lead.phone || "—"}
              </div>
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

      {/* Activity side panel — opens from i-button */}
      {showActivity && (
        <ActivityPanel
          activity={activity}
          isAdmin={isAdmin}
          lead={lead}
          execs={execs}
          onClose={() => setShowActivity(false)}
        />
      )}
    </div>
  );
}

function CallLogSection({ lead, calls, canEdit, callOutcome, setCallOutcome, callPhone, setCallPhone, callSummary, setCallSummary, savingCall, onSubmit }) {
  const allPhones = [lead.phone, ...(lead.phones || [])].filter(Boolean);
  return (
    <section data-testid="call-log-section">
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2 flex items-center gap-1">
        <PhoneCall size={12} /> Call Activity ({calls.length})
      </div>
      {canEdit && (
        <div className="border border-gray-200 bg-white p-3 space-y-2 mb-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <select
              value={callPhone}
              onChange={(e) => setCallPhone(e.target.value)}
              className="border border-gray-300 px-2 py-2 text-sm"
              data-testid="call-phone-select"
            >
              {allPhones.length === 0 && <option value="">No phone on lead</option>}
              {allPhones.map((p, i) => <option key={p} value={p}>{p}{i === 0 ? " (Primary)" : ""}</option>)}
            </select>
            <select
              value={callOutcome}
              onChange={(e) => setCallOutcome(e.target.value)}
              className="border border-gray-300 px-2 py-2 text-sm"
              data-testid="call-outcome-select"
            >
              <option value="">— Call outcome —</option>
              {CALL_OUTCOMES.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
          </div>
          {callOutcome === "connected" && (
            <textarea
              value={callSummary}
              onChange={(e) => setCallSummary(e.target.value)}
              placeholder="Conversation summary — what was discussed, lead requirement, follow-up note…"
              rows={3}
              className="w-full border border-gray-300 p-2 text-sm"
              data-testid="call-summary-input"
            />
          )}
          <button
            onClick={onSubmit}
            disabled={!callOutcome || savingCall}
            className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50 flex items-center gap-1"
            data-testid="log-call-btn"
          >
            <PhoneCall size={12} weight="bold" /> Log Call
          </button>
        </div>
      )}
      <div className="space-y-2">
        {calls.length === 0 && <div className="text-xs text-gray-400 uppercase tracking-widest">No calls logged yet</div>}
        {calls.map(c => {
          const o = CALL_OUTCOMES.find(x => x.v === c.outcome);
          return (
            <div key={c.id} className="border border-gray-200 bg-white p-3" data-testid={`call-row-${c.id}`}>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] uppercase tracking-widest font-bold ${OUTCOME_COLOR[c.outcome] || "text-gray-500"}`}>
                    {o?.label || c.outcome}
                  </span>
                  <span className="text-xs font-mono text-gray-500">{c.phone}</span>
                </div>
                <div className="text-[10px] text-gray-400 font-mono">{fmtIST(c.at)} · {c.by_user_name}</div>
              </div>
              {c.summary && <div className="text-sm mt-2 whitespace-pre-wrap">{c.summary}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ActivityPanel({ activity, isAdmin, lead, execs, onClose }) {
  const execMap = Object.fromEntries((execs || []).map(e => [e.id, e.name]));
  const enriched = activity.map(a => ({ ...a, _meta: a.meta || {} }));
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose} data-testid="activity-panel">
      <div className="w-full max-w-md bg-white border-l border-gray-200 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Lead Activity</div>
            <h3 className="font-chivo font-bold text-lg leading-tight">{lead.customer_name}</h3>
            {isAdmin && (
              <div className="text-[10px] uppercase tracking-widest text-[#002FA7] font-bold mt-0.5" data-testid="activity-admin-flag">Admin view — full trail</div>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900 p-2" data-testid="activity-panel-close">
            <X size={18} />
          </button>
        </div>
        <div className="p-4 space-y-2">
          {enriched.length === 0 && <div className="text-xs text-gray-400 uppercase tracking-widest">No activity</div>}
          {enriched.map(a => {
            const isAssign = a.action === "lead_assigned" || a.action === "auto_reassigned_unopened" || a.action === "auto_reassigned_noaction";
            const toName = execMap[a._meta?.to] || a._meta?.to;
            const fromName = execMap[a._meta?.from] || a._meta?.from;
            return (
              <div key={a.id} className="border-l-2 border-gray-300 pl-3 py-1" data-testid={`activity-row-${a.id}`}>
                <div className="text-xs">
                  <span className="font-bold uppercase tracking-widest">{a.action.replace(/_/g, " ")}</span>
                  {isAssign && isAdmin && (
                    <span className="text-gray-600">
                      {" "}— {fromName ? <>from <b>{fromName}</b> </> : ""}to <b>{toName || "—"}</b>
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-gray-500 font-mono mt-0.5">
                  {fmtIST(a.at)} · {a.actor_name || "System"}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ k, v, mono, testId }) {
  return (
    <div className="px-3 py-2 flex items-baseline gap-4" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold w-32 shrink-0">{k}</div>
      <div className={`text-sm ${mono ? "font-mono" : ""} break-words`}>{v}</div>
    </div>
  );
}

function PhonesRow({ lead, canEdit, onChanged }) {
  const [adding, setAdding] = React.useState(false);
  const [val, setVal] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const allPhones = [lead.phone, ...(lead.phones || [])].filter(Boolean);
  const waMap = lead.wa_status_map || {};
  const activeWa = (lead.active_wa_phone || lead.phone || "").trim();
  const norm = (p) => (p || "").replace(/\D+/g, "").slice(-10);

  const add = async () => {
    const trimmed = val.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await api.post(`/leads/${lead.id}/phones`, { phone: trimmed });
      toast.success("Phone added");
      setVal("");
      setAdding(false);
      onChanged?.();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const remove = async (p) => {
    if (!window.confirm(`Remove ${p} from this lead?`)) return;
    setBusy(true);
    try {
      await api.delete(`/leads/${lead.id}/phones`, { params: { phone: p } });
      toast.success("Phone removed");
      onChanged?.();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const setActiveWa = async (p) => {
    setBusy(true);
    try {
      await api.put(`/leads/${lead.id}/active-wa-phone`, { phone: p });
      toast.success(`WhatsApp now uses ${p}`);
      onChanged?.();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  if (allPhones.length === 0 && !canEdit) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="lead-phones-row">
      {allPhones.map((p, i) => {
        const key = norm(p);
        const wa = waMap[key]; // true / false / undefined
        const isActiveWa = norm(activeWa) === key;
        return (
          <span key={p} className="flex items-center gap-1 text-xs text-gray-700 bg-gray-50 border border-gray-200 px-2 py-1" data-testid={`lead-phone-${p}`}>
            <Phone size={11} weight={i === 0 ? "fill" : "regular"} className={i === 0 ? "text-[#002FA7]" : "text-gray-400"} />
            <span className={i === 0 ? "font-semibold" : ""}>{p}</span>
            {i === 0 && <span className="text-[9px] uppercase tracking-widest text-gray-400 font-bold">Primary</span>}
            {/* WA detection badge */}
            {wa === true && (
              <span className="text-[9px] uppercase tracking-widest font-bold text-[#25D366] flex items-center gap-0.5" title="On WhatsApp" data-testid={`wa-yes-${p}`}>
                <WhatsappLogo size={11} weight="fill" /> WA
              </span>
            )}
            {wa === false && (
              <span className="text-[9px] uppercase tracking-widest font-bold text-gray-400" title="Not on WhatsApp" data-testid={`wa-no-${p}`}>NO WA</span>
            )}
            {wa === undefined && (
              <span className="text-[9px] uppercase tracking-widest font-bold text-gray-300" title="WA status unknown — send once to detect">?</span>
            )}
            {isActiveWa ? (
              <span className="text-[9px] uppercase tracking-widest font-bold text-[#FF8800] flex items-center gap-0.5" title="WhatsApp messages will go to this number" data-testid={`wa-active-${p}`}>
                <Star size={10} weight="fill" /> Active
              </span>
            ) : canEdit && (
              <button onClick={() => setActiveWa(p)} disabled={busy} className="text-[9px] uppercase tracking-widest font-bold text-[#002FA7] hover:underline" title="Use this number for WhatsApp" data-testid={`set-wa-active-${p}`}>
                Use for WA
              </button>
            )}
            {canEdit && (
              <button onClick={() => remove(p)} className="text-gray-300 hover:text-[#E60000]" title="Remove" data-testid={`remove-phone-${p}`}>
                <Trash size={11} />
              </button>
            )}
          </span>
        );
      })}
      {canEdit && !adding && (
        <button onClick={() => setAdding(true)} className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7] hover:underline flex items-center gap-1" data-testid="add-phone-btn">
          <Plus size={12} weight="bold" /> {allPhones.length === 0 ? "Add phone" : "Add another"}
        </button>
      )}
      {canEdit && adding && (
        <span className="flex items-center gap-1">
          <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="+91 98765 43210"
            className="border border-gray-300 px-2 py-1 text-xs" data-testid="add-phone-input" />
          <button onClick={add} disabled={busy} className="bg-[#002FA7] hover:bg-[#002288] text-white px-2 py-1 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="add-phone-save-btn">
            Add
          </button>
          <button onClick={() => { setAdding(false); setVal(""); }} className="text-gray-400 hover:text-gray-900 p-1"><X size={12} /></button>
        </span>
      )}
    </div>
  );
}
