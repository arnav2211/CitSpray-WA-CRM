import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import {
  MagnifyingGlass, PaperPlaneRight, ChatCircleDots, Phone, ArrowsClockwise, Plus, ArrowLeft,
  Funnel, Lightning, ArrowsLeftRight, X, Tag, NotePencil, Info,
} from "@phosphor-icons/react";
import { fmtIST, fmtISTTime } from "@/lib/format";
import { StatusBadge, SourceBadge } from "@/components/Badges";

const POLL_MS = 4000;
const STATUSES = ["new", "contacted", "qualified", "converted", "lost"];

// ---------------- Helpers ----------------
function tickFor(status) {
  if (!status) return "";
  if (status === "read") return "✓✓";
  if (status === "delivered") return "✓✓";
  if (status === "sent") return "✓";
  if (status === "received") return "";
  if (status === "failed") return "!";
  return "✓";
}
function tickColor(status) {
  if (status === "read") return "text-[#34B7F1]";
  if (status === "failed") return "text-[#E60000]";
  return "text-gray-400";
}
function previewText(m) {
  if (!m) return "—";
  const prefix = m.direction === "out" ? "" : "";
  return `${prefix}${(m.body || m.template_name || "(message)").slice(0, 80)}`;
}

// ---------------- Page ----------------
export default function Chat() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [convs, setConvs] = useState([]);
  const [activeId, setActiveId] = useState(params.get("lead") || null);
  const [search, setSearch] = useState("");
  const [filterUnread, setFilterUnread] = useState(false);
  const [filterUnreplied, setFilterUnreplied] = useState(false);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [execs, setExecs] = useState([]);
  const [showNewChat, setShowNewChat] = useState(false);

  const isAdmin = user.role === "admin";

  const fetchConvs = useCallback(async () => {
    try {
      const { data } = await api.get("/inbox/conversations", {
        params: {
          q: search || undefined,
          only_unread: filterUnread || undefined,
          only_unreplied: filterUnreplied || undefined,
          status: filterStatus || undefined,
          assigned_to: filterAssignee || undefined,
        },
      });
      setConvs(data);
    } catch (e) {
      // silent; toast on hard fail
      const msg = errMsg(e, "");
      if (msg && !msg.toLowerCase().includes("network")) toast.error(msg);
    }
  }, [search, filterUnread, filterUnreplied, filterStatus, filterAssignee]);

  // Initial + filter changes
  useEffect(() => { fetchConvs(); }, [fetchConvs]);
  // Poll
  useEffect(() => {
    const id = setInterval(fetchConvs, POLL_MS);
    return () => clearInterval(id);
  }, [fetchConvs]);

  // Load execs for admin filter
  useEffect(() => {
    if (!isAdmin) return;
    api.get("/users").then(({ data }) => setExecs(data.filter(u => u.role === "executive" || u.role === "admin"))).catch(() => {});
  }, [isAdmin]);

  // Sync active lead id to URL
  useEffect(() => {
    const p = {};
    if (activeId) p.lead = activeId;
    setParams(p, { replace: true });
  }, [activeId, setParams]);

  const activeConv = useMemo(() => convs.find(c => c.id === activeId), [convs, activeId]);
  const totalUnread = convs.reduce((s, c) => s + (c.unread || 0), 0);

  return (
    <div className="h-full flex bg-[#EFEAE2]" data-testid="chat-page">
      {/* LEFT SIDEBAR */}
      <aside
        className={`${activeId ? "hidden md:flex" : "flex"} w-full md:w-[380px] shrink-0 flex-col bg-white border-r border-gray-200`}
        data-testid="conv-sidebar"
      >
        <div className="border-b border-gray-200 px-4 py-3 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Inbox</div>
            <div className="font-chivo font-bold text-lg leading-none mt-0.5">
              Chats {totalUnread > 0 && <span className="ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 bg-[#25D366] text-white text-xs font-bold">{totalUnread}</span>}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={fetchConvs} className="p-2 hover:bg-gray-100" title="Refresh" data-testid="refresh-conv-btn">
              <ArrowsClockwise size={16} />
            </button>
            <button onClick={() => setShowNewChat(true)} className="bg-[#25D366] hover:bg-[#1da851] text-white p-2" title="Start new chat" data-testid="new-chat-btn">
              <Plus size={16} weight="bold" />
            </button>
          </div>
        </div>
        <div className="px-3 py-2 border-b border-gray-200 space-y-2">
          <div className="relative">
            <MagnifyingGlass className="absolute left-2 top-2.5 text-gray-400" size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, phone…"
              className="w-full border border-gray-300 pl-7 pr-3 py-2 text-sm outline-none focus:border-[#25D366] focus:ring-2 focus:ring-[#25D366]"
              data-testid="conv-search-input" />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <FilterChip active={filterUnread} onClick={() => setFilterUnread(v => !v)} testId="filter-unread">Unread</FilterChip>
            <FilterChip active={filterUnreplied} onClick={() => setFilterUnreplied(v => !v)} testId="filter-unreplied">Not replied</FilterChip>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="border border-gray-300 px-2 py-1 text-xs" data-testid="filter-status">
              <option value="">All status</option>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {isAdmin && (
              <select value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)} className="border border-gray-300 px-2 py-1 text-xs" data-testid="filter-agent">
                <option value="">All agents</option>
                {execs.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {convs.length === 0 ? (
            <div className="p-8 text-center text-xs uppercase tracking-widest text-gray-400">
              <ChatCircleDots size={48} className="mx-auto mb-3 text-gray-300" weight="light" />
              No conversations match these filters
            </div>
          ) : convs.map((c) => (
            <ConvRow key={c.id} c={c} active={c.id === activeId} onClick={() => setActiveId(c.id)} execs={execs} />
          ))}
        </div>
      </aside>

      {/* RIGHT THREAD */}
      <section className={`${activeId ? "flex" : "hidden md:flex"} flex-1 min-w-0 flex-col`}>
        {activeConv ? (
          <ChatThread
            conv={activeConv}
            user={user}
            execs={execs}
            onClose={() => setActiveId(null)}
            onChanged={fetchConvs}
          />
        ) : (
          <EmptyState />
        )}
      </section>

      {showNewChat && (
        <NewChatModal
          execs={execs}
          isAdmin={isAdmin}
          onClose={() => setShowNewChat(false)}
          onCreated={(lead) => { setShowNewChat(false); fetchConvs(); setActiveId(lead.id); }}
        />
      )}
    </div>
  );
}

// ---------------- Sidebar row ----------------
function ConvRow({ c, active, onClick, execs }) {
  const last = c.last_message || {};
  const exec = execs.find(e => e.id === c.assigned_to);
  return (
    <button onClick={onClick} data-testid={`conv-row-${c.id}`}
      className={`w-full text-left px-3 py-3 flex gap-3 border-b border-gray-100 hover:bg-gray-50 ${active ? "bg-[#F0F2F5]" : ""}`}>
      <div className="w-10 h-10 rounded-full bg-[#25D366] flex items-center justify-center text-white font-bold text-sm shrink-0">
        {(c.customer_name || "?").slice(0, 1).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-sm truncate">{c.customer_name || c.phone}</div>
          <div className="text-[10px] text-gray-500 font-mono shrink-0 ml-2">
            {last.at ? fmtISTTime(last.at) : ""}
          </div>
        </div>
        {c.phone && (
          <div className="text-[11px] text-gray-500 font-mono flex items-center gap-1 mt-0.5">
            <Phone size={10} weight="bold" /> {c.phone}
          </div>
        )}
        <div className="flex items-center justify-between mt-0.5">
          <div className="text-xs text-gray-500 truncate flex-1">
            {last.direction === "out" && (
              <span className={`mr-1 ${tickColor(last.status)}`}>{tickFor(last.status)}</span>
            )}
            {previewText(last)}
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            {c.unread > 0 && (
              <span className="bg-[#25D366] text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center" data-testid="unread-badge">
                {c.unread}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <SourceBadge source={c.source} />
          <span className="text-[10px] uppercase tracking-widest text-gray-400 font-bold truncate">
            {exec ? exec.name : c.assigned_to ? "—" : "Unassigned"}
          </span>
          {c.unreplied && (
            <span className="text-[9px] uppercase tracking-widest text-[#E60000] font-bold">Reply pending</span>
          )}
        </div>
      </div>
    </button>
  );
}

function FilterChip({ active, onClick, children, testId }) {
  return (
    <button onClick={onClick} data-testid={testId}
      className={`text-[10px] uppercase tracking-widest font-bold px-2 py-1 border ${active ? "bg-gray-900 text-white border-gray-900" : "border-gray-300 text-gray-700 hover:bg-gray-100"}`}>
      {children}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-[#EFEAE2]" data-testid="chat-empty-state">
      <ChatCircleDots size={64} weight="light" className="text-gray-400" />
      <h3 className="font-chivo font-bold text-xl mt-4">Pick a conversation</h3>
      <p className="text-sm text-gray-500 mt-2 max-w-sm">
        Select a chat on the left to view the conversation, send messages, or use a quick reply.
        New inbound WhatsApp messages appear here automatically.
      </p>
    </div>
  );
}

// ---------------- Chat thread ----------------
function ChatThread({ conv, user, execs, onClose, onChanged }) {
  const isAdmin = user.role === "admin";
  const canMessage = isAdmin || conv.assigned_to === user.id;
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [showTpl, setShowTpl] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [quickReplies, setQuickReplies] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [savingMeta, setSavingMeta] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [replyTo, setReplyTo] = useState(null);  // {id, preview, direction}
  const scrollRef = useRef(null);

  const exec = execs.find(e => e.id === conv.assigned_to);
  const within24h = !!conv.within_24h;

  const loadMessages = useCallback(async () => {
    try {
      const { data } = await api.get(`/leads/${conv.id}/messages`);
      setMessages(data);
    } catch (e) {
      const msg = errMsg(e, "");
      if (msg && !msg.toLowerCase().includes("network")) toast.error(msg);
    }
  }, [conv.id]);

  useEffect(() => { loadMessages(); }, [loadMessages]);
  useEffect(() => {
    const id = setInterval(loadMessages, POLL_MS);
    return () => clearInterval(id);
  }, [loadMessages]);

  // Auto-mark-read when opening + after new inbound
  useEffect(() => {
    if (conv.unread > 0 && canMessage) {
      api.post(`/inbox/leads/${conv.id}/mark-read`).then(() => onChanged?.()).catch(() => {});
    }
    // eslint-disable-next-line
  }, [conv.id]);

  // Load quick replies + templates
  useEffect(() => {
    api.get("/quick-replies").then(({ data }) => setQuickReplies(data)).catch(() => {});
    api.get("/whatsapp/templates").then(({ data }) => setTemplates(data.filter(t => !t.status || t.status === "APPROVED" || !t.synced_from_meta))).catch(() => {});
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const send = async () => {
    if (!draft.trim() || !canMessage) return;
    if (!within24h) {
      toast.error("Outside 24-hour window — please use a template");
      return;
    }
    setSending(true);
    try {
      const payload = { lead_id: conv.id, body: draft };
      if (replyTo?.id) payload.reply_to_message_id = replyTo.id;
      await api.post("/whatsapp/send", payload);
      setDraft("");
      setReplyTo(null);
      loadMessages();
      onChanged?.();
    } catch (e) {
      toast.error(errMsg(e, "Failed to send"));
    } finally { setSending(false); }
  };

  const sendTemplate = async (tpl) => {
    // Backwards-compat: support being called with a string name OR a full template object
    const tplName = typeof tpl === "string" ? tpl : tpl?.name;
    const paramsRequired = typeof tpl === "string"
      ? (templates.find(t => t.name === tpl)?.params_required ?? 0)
      : Number(tpl?.params_required || 0);
    let templateParams = null;
    if (paramsRequired > 0) {
      // Prompt for each placeholder. {{1}} default-suggests customer name.
      templateParams = [];
      for (let i = 1; i <= paramsRequired; i++) {
        const suggestion = i === 1 ? (conv.customer_name || "") : "";
        const v = window.prompt(`Template "${tplName}" — value for {{${i}}}`, suggestion);
        if (v === null) return; // user cancelled
        templateParams.push(v);
      }
    }
    setSending(true);
    try {
      const payload = {
        lead_id: conv.id,
        body: `[Template: ${tplName}]`,
        template_name: tplName,
      };
      if (templateParams !== null) payload.template_params = templateParams;
      await api.post("/whatsapp/send", payload);
      toast.success(`Template "${tplName}" sent`);
      setShowTpl(false);
      loadMessages();
      onChanged?.();
    } catch (e) {
      toast.error(errMsg(e, "Template send failed"));
    } finally { setSending(false); }
  };

  const applyQR = (qr) => {
    const text = (qr.text || "").replace("{{name}}", conv.customer_name || "");
    setDraft((d) => (d ? d + " " : "") + text);
    setShowQR(false);
  };

  const requestTransfer = async () => {
    const reason = window.prompt("Why do you need this lead transferred to you?", "Customer is on my pipeline.");
    if (reason === null) return;
    try {
      await api.post("/inbox/transfer-request", { lead_id: conv.id, reason });
      toast.success("Transfer request sent to admin");
    } catch (e) { toast.error(errMsg(e)); }
  };

  const reassign = async (newAssigneeId) => {
    if (!isAdmin || !newAssigneeId || newAssigneeId === conv.assigned_to) return;
    setSavingMeta(true);
    try {
      await api.post(`/leads/${conv.id}/reassign`, { assigned_to: newAssigneeId });
      toast.success("Lead reassigned");
      onChanged?.();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSavingMeta(false); }
  };

  const setStatus = async (newStatus) => {
    if (!canMessage || newStatus === conv.status) return;
    setSavingMeta(true);
    try {
      await api.patch(`/leads/${conv.id}`, { status: newStatus });
      toast.success(`Status → ${newStatus}`);
      onChanged?.();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSavingMeta(false); }
  };

  const addNote = async () => {
    if (!newNote.trim() || !canMessage) return;
    setSavingMeta(true);
    try {
      await api.post(`/leads/${conv.id}/notes`, { body: newNote.trim() });
      setNewNote("");
      toast.success("Note added");
      onChanged?.();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSavingMeta(false); }
  };

  return (
    <>
      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3" data-testid="chat-topbar">
        <button onClick={onClose} className="md:hidden p-1 -ml-1" data-testid="back-btn"><ArrowLeft size={18} /></button>
        <div className="w-9 h-9 rounded-full bg-[#25D366] flex items-center justify-center text-white font-bold text-sm">
          {(conv.customer_name || "?").slice(0,1).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-semibold truncate">{conv.customer_name}</div>
            {/* Inline status dropdown — disabled for non-owners */}
            <select
              value={conv.status || "new"}
              onChange={(e) => setStatus(e.target.value)}
              disabled={!canMessage || savingMeta}
              data-testid="chat-status-select"
              className="border border-gray-300 px-1.5 py-0.5 text-[10px] uppercase tracking-widest font-bold disabled:bg-gray-100 disabled:cursor-not-allowed"
            >
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="text-xs text-gray-500 flex items-center gap-3 flex-wrap">
            {conv.phone && <span className="font-mono flex items-center gap-1" data-testid="chat-phone-display"><Phone size={11} /> {conv.phone}</span>}
            {/* Admin: reassign dropdown ; executive: read-only assignee */}
            {isAdmin ? (
              <span className="flex items-center gap-1">
                <Tag size={11} />
                <select
                  value={conv.assigned_to || ""}
                  onChange={(e) => reassign(e.target.value)}
                  disabled={savingMeta}
                  data-testid="chat-reassign-select"
                  className="border border-gray-300 px-1.5 py-0.5 text-[11px] disabled:bg-gray-100"
                >
                  <option value="">— Unassigned —</option>
                  {execs.map(x => <option key={x.id} value={x.id}>{x.role === "admin" ? `${x.name} (admin)` : x.name}</option>)}
                </select>
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <Tag size={11} /> {exec ? exec.name : "Unassigned"}
              </span>
            )}
            {within24h ? (
              <span className="text-[#25D366] font-bold uppercase tracking-widest text-[9px]">24h window OPEN</span>
            ) : (
              <span className="text-[#E60000] font-bold uppercase tracking-widest text-[9px]">24h window CLOSED — template only</span>
            )}
          </div>
        </div>
        <button onClick={() => setShowInfo(v => !v)} className={`p-2 ${showInfo ? "bg-gray-900 text-white" : "hover:bg-gray-100"}`} title="Lead info" data-testid="chat-info-toggle">
          <Info size={16} weight={showInfo ? "fill" : "regular"} />
        </button>
        {!canMessage && (
          <button onClick={requestTransfer} className="border border-[#002FA7] text-[#002FA7] px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold hover:bg-[#002FA7] hover:text-white flex items-center gap-1" data-testid="request-transfer-btn">
            <ArrowsLeftRight size={12} /> Request transfer
          </button>
        )}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Messages column */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1.5" style={{ background: "#EFEAE2" }} data-testid="messages-area">
            {messages.length === 0 && (
              <div className="text-center text-xs uppercase tracking-widest text-gray-500 py-12">No messages yet</div>
            )}
            {messages.map((m) => (
              <Bubble
                key={m.id}
                m={m}
                allMessages={messages}
                canMessage={canMessage && within24h}
                onReply={(target) => setReplyTo({
                  id: target.id,
                  preview: (target.caption || target.body || "").slice(0, 120),
                  direction: target.direction,
                })}
              />
            ))}
          </div>

          {/* Quick reply dropdown */}
          {showQR && quickReplies.length > 0 && (
            <div className="bg-white border-t border-gray-200 max-h-48 overflow-y-auto">
              {quickReplies.map(qr => (
                <button key={qr.id} onClick={() => applyQR(qr)} className="w-full text-left px-4 py-2 hover:bg-gray-50 border-b border-gray-100" data-testid={`qr-${qr.id}`}>
                  <div className="text-xs font-bold uppercase tracking-widest text-gray-500">{qr.title}</div>
                  <div className="text-sm text-gray-800">{qr.text}</div>
                </button>
              ))}
            </div>
          )}
          {showTpl && (
            <div className="bg-white border-t border-gray-200 max-h-56 overflow-y-auto">
              {templates.length === 0 ? (
                <div className="px-4 py-6 text-xs uppercase tracking-widest text-gray-400 text-center">
                  No approved templates — sync them from Meta in /templates
                </div>
              ) : templates.map(t => (
                <button key={t.id} onClick={() => sendTemplate(t)} className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100" data-testid={`tpl-${t.name}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-bold">{t.name}</div>
                    <div className="flex items-center gap-1">
                      {Number(t.params_required || 0) > 0 ? (
                        <span className="kbd bg-[#002FA7] text-white border-[#002FA7]" data-testid={`tpl-params-${t.name}`}>{t.params_required} var{t.params_required === 1 ? "" : "s"}</span>
                      ) : (
                        <span className="kbd" data-testid={`tpl-params-${t.name}`}>no vars</span>
                      )}
                      <span className="kbd">{t.language || t.category}</span>
                    </div>
                  </div>
                  {t.body && <div className="text-xs text-gray-600 mt-1 whitespace-pre-wrap">{t.body}</div>}
                </button>
              ))}
            </div>
          )}

          {/* Reply-to preview banner */}
          {replyTo && canMessage && (
            <div className="bg-white border-t border-gray-200 px-3 py-2 flex items-center gap-2" data-testid="reply-to-banner">
              <div className="flex-1 min-w-0 border-l-[3px] border-[#25D366] pl-2">
                <div className="text-[10px] uppercase tracking-widest text-[#25D366] font-bold">
                  Replying to {replyTo.direction === "out" ? "your message" : "customer"}
                </div>
                <div className="text-xs text-gray-700 truncate">{replyTo.preview || "(no preview)"}</div>
              </div>
              <button onClick={() => setReplyTo(null)} className="text-gray-500 hover:text-gray-900 p-1" data-testid="reply-to-cancel">
                <X size={14} />
              </button>
            </div>
          )}

          {/* Input */}
          {canMessage ? (
            <div className="bg-[#F0F2F5] border-t border-gray-200 p-3 flex items-end gap-2" data-testid="chat-composer">
              <button onClick={() => { setShowQR(v => !v); setShowTpl(false); }} title="Quick replies"
                className={`p-2 ${showQR ? "bg-gray-900 text-white" : "hover:bg-gray-200 text-gray-700"}`} data-testid="qr-toggle">
                <Lightning size={18} weight="bold" />
              </button>
              <button onClick={() => { setShowTpl(v => !v); setShowQR(false); }} title="Templates"
                className={`px-3 py-2 text-[10px] uppercase tracking-widest font-bold ${showTpl ? "bg-gray-900 text-white" : "border border-gray-300 hover:bg-gray-200"}`} data-testid="tpl-toggle">
                Tpl
              </button>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                disabled={!within24h}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={within24h ? "Type a message…" : "Outside 24-hour window — use a template (Tpl ↑)"}
                rows={1}
                className="flex-1 resize-none border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#25D366] disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
                data-testid="chat-input" />
              <button onClick={send} disabled={!draft.trim() || sending || !within24h}
                className="bg-[#25D366] hover:bg-[#1da851] text-white p-2 disabled:opacity-50 disabled:cursor-not-allowed" data-testid="chat-send-btn">
                <PaperPlaneRight size={18} weight="fill" />
              </button>
            </div>
          ) : (
            <div className="bg-[#FFE9E9] border-t border-[#E60000] p-3 text-center text-sm text-[#E60000]">
              You can't message this lead — assigned to <b>{exec?.name || "another agent"}</b>.
              <button onClick={requestTransfer} className="ml-2 underline font-bold" data-testid="composer-request-transfer">Request transfer</button>
            </div>
          )}
        </div>

        {/* Right info panel — slides over on mobile, side-by-side on lg+ */}
        {showInfo && (
          <aside
            className="fixed inset-y-0 right-0 z-30 w-full sm:w-[360px] lg:relative lg:inset-auto lg:w-[300px] lg:z-auto shrink-0 bg-white border-l border-gray-200 overflow-y-auto"
            data-testid="lead-info-panel"
          >
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Lead Details</div>
              <button onClick={() => setShowInfo(false)} className="text-gray-400 hover:text-gray-900"><X size={14} /></button>
            </div>
            <div className="p-4 space-y-4 text-sm">
              <InfoRow label="Customer">{conv.customer_name || "—"}</InfoRow>
              <InfoRow label="Phone"><span className="font-mono">{conv.phone || "—"}</span></InfoRow>
              {conv.email && <InfoRow label="Email"><span className="font-mono text-xs break-all">{conv.email}</span></InfoRow>}
              <InfoRow label="Source"><SourceBadge source={conv.source} /></InfoRow>
              <InfoRow label="Status"><StatusBadge status={conv.status} /></InfoRow>
              <InfoRow label="Requirement">
                <div className="text-xs text-gray-700 whitespace-pre-wrap">{conv.requirement || "—"}</div>
              </InfoRow>
              {(conv.city || conv.area || conv.state) && (
                <InfoRow label="Location">
                  <div className="text-xs text-gray-700">{[conv.area, conv.city, conv.state].filter(Boolean).join(", ")}</div>
                </InfoRow>
              )}
              {conv.created_at && <InfoRow label="Created"><span className="text-xs text-gray-700">{fmtIST(conv.created_at)}</span></InfoRow>}

              {/* Notes section */}
              <div className="pt-3 border-t border-gray-200">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2">
                  <NotePencil size={12} /> Notes ({(conv.notes || []).length})
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {(conv.notes || []).length === 0 && (
                    <div className="text-xs text-gray-400 italic">No notes yet</div>
                  )}
                  {(conv.notes || []).map(n => (
                    <div key={n.id} className="bg-gray-50 border border-gray-200 p-2 text-xs" data-testid={`note-${n.id}`}>
                      <div className="text-gray-800 whitespace-pre-wrap">{n.body}</div>
                      <div className="text-[10px] text-gray-500 mt-1 font-mono">
                        {n.by_name || "—"} · {fmtIST(n.at)}
                      </div>
                    </div>
                  ))}
                </div>
                {canMessage && (
                  <div className="mt-3">
                    <textarea
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      placeholder="Add a note (visible to admin + assignee)…"
                      rows={2}
                      className="w-full border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-[#002FA7]"
                      data-testid="add-note-input"
                    />
                    <button
                      onClick={addNote}
                      disabled={!newNote.trim() || savingMeta}
                      className="mt-1.5 w-full bg-[#002FA7] hover:bg-[#002288] text-white px-2 py-1.5 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50"
                      data-testid="add-note-btn"
                    >
                      Add Note
                    </button>
                  </div>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}

function InfoRow({ label, children }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Bubble({ m, allMessages = [], onReply, canMessage = true }) {
  const isOut = m.direction === "out";
  const isSystem = m.direction === "system";
  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <div className="bg-white text-gray-600 text-xs px-3 py-1 shadow-sm">{m.body}</div>
      </div>
    );
  }
  const media = renderMedia(m);
  const captionText = m.caption || (media ? "" : m.body);
  // Resolve quoted/reply-to preview if this message is itself a reply
  const quoted = m.reply_to_message_id
    ? allMessages.find((x) => x.id === m.reply_to_message_id)
    : null;
  const quotedPreview = quoted
    ? ((quoted.caption || quoted.body || "").slice(0, 120))
    : (m.reply_to_preview ? m.reply_to_preview.slice(0, 120) : null);
  const quotedDirection = quoted?.direction || (m.reply_to_wamid && isOut ? "in" : "out");
  return (
    <div className={`group flex ${isOut ? "justify-end" : "justify-start"}`} data-testid={`msg-${m.id}`}>
      {/* Reply affordance on the left side for incoming, right for outgoing */}
      {!isOut && canMessage && onReply && (
        <button onClick={() => onReply(m)}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 hover:text-[#25D366] text-[10px] uppercase tracking-widest font-bold self-center mr-1 px-1"
          title="Reply" data-testid={`reply-btn-${m.id}`}>
          ↩ Reply
        </button>
      )}
      <div className={`max-w-[75%] ${media ? "p-1.5" : "px-3 py-2"} ${isOut ? "bg-[#D9FDD3]" : "bg-white"} text-sm shadow-sm`}>
        {m.template_name && (
          <div className="text-[9px] uppercase tracking-widest text-gray-500 font-bold mb-1 px-2 pt-1">Template · {m.template_name}</div>
        )}
        {quotedPreview && (
          <div
            className={`mb-1.5 border-l-[3px] pl-2 py-1 text-xs bg-black/5 ${media ? "mx-1.5 mt-1.5" : ""}`}
            style={{ borderColor: quotedDirection === "out" ? "#25D366" : "#002FA7" }}
            data-testid={`quoted-preview-${m.id}`}
          >
            <div className="text-[9px] uppercase tracking-widest font-bold" style={{ color: quotedDirection === "out" ? "#128C7E" : "#002FA7" }}>
              {quotedDirection === "out" ? "You" : "Customer"}
            </div>
            <div className="text-gray-700 truncate">{quotedPreview}</div>
          </div>
        )}
        {media}
        {captionText && (
          <div className={`whitespace-pre-wrap break-words ${media ? "px-2 pt-1.5" : ""}`}>{captionText}</div>
        )}
        <div className={`flex items-center justify-end gap-1 mt-1 ${media ? "px-2 pb-1" : ""}`}>
          <span className="text-[10px] text-gray-500 font-mono">{fmtISTTime(m.at)}</span>
          {isOut && <span className={`text-[10px] ${tickColor(m.status)}`}>{tickFor(m.status)}</span>}
          {isOut && m.error && <span className="text-[9px] text-[#E60000] uppercase tracking-widest font-bold">{String(m.error).slice(0, 24)}</span>}
        </div>
      </div>
      {isOut && canMessage && onReply && (
        <button onClick={() => onReply(m)}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 hover:text-[#25D366] text-[10px] uppercase tracking-widest font-bold self-center ml-1 px-1"
          title="Reply" data-testid={`reply-btn-${m.id}`}>
          ↩ Reply
        </button>
      )}
    </div>
  );
}

function renderMedia(m) {
  const type = m.media_type;
  if (!type) return null;
  const url = m.media_url;  // outbound (admin-provided/uploaded public URL)
  if (type === "image" && url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" data-testid={`msg-media-image-${m.id}`}>
        <img src={url} alt="" className="block w-full max-h-[320px] object-cover bg-gray-100" loading="lazy" />
      </a>
    );
  }
  if (type === "video" && url) {
    return (
      <video controls preload="metadata" className="block w-full max-h-[320px] bg-black" data-testid={`msg-media-video-${m.id}`}>
        <source src={url} />
      </video>
    );
  }
  if (type === "document" && url) {
    const name = m.filename || url.split("/").pop();
    return (
      <a href={url} target="_blank" rel="noreferrer"
        className="flex items-center gap-2 bg-white/60 px-3 py-2 border border-gray-200 text-gray-800 hover:bg-white"
        data-testid={`msg-media-document-${m.id}`}>
        <span className="text-lg">📄</span>
        <div className="min-w-0">
          <div className="text-xs font-semibold truncate">{name}</div>
          <div className="text-[10px] text-gray-500 uppercase tracking-widest">Document</div>
        </div>
      </a>
    );
  }
  // Inbound without a downloaded URL — show a lightweight placeholder using media_id
  if (m.media_id) {
    const icon = type === "image" ? "🖼️" : type === "video" ? "🎬" : "📄";
    return (
      <div className="flex items-center gap-2 bg-gray-100 px-3 py-2 text-gray-700" data-testid={`msg-media-placeholder-${m.id}`}>
        <span className="text-lg">{icon}</span>
        <div className="text-[11px] uppercase tracking-widest font-bold">Incoming {type}</div>
      </div>
    );
  }
  return null;
}

// ---------------- New chat modal ----------------
function NewChatModal({ onClose, onCreated, execs, isAdmin }) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [requirement, setRequirement] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [requesting, setRequesting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setConflict(null);
    try {
      const payload = { phone, customer_name: name, requirement };
      if (isAdmin && assignedTo) payload.assigned_to = assignedTo;
      const { data } = await api.post("/inbox/start-chat", payload);
      toast.success("Chat ready");
      onCreated(data);
    } catch (e) {
      const detail = e?.response?.data?.detail;
      if (e?.response?.status === 409 && detail && typeof detail === "object" && detail.code === "duplicate_phone") {
        setConflict(detail);
      } else {
        toast.error(errMsg(e));
      }
    }
    finally { setBusy(false); }
  };

  const requestReassignment = async () => {
    if (!conflict?.existing_lead_id) return;
    setRequesting(true);
    try {
      await api.post("/inbox/transfer-request", {
        lead_id: conflict.existing_lead_id,
        reason: `Tried to start chat with ${phone}. Please reassign to me.`,
      });
      toast.success("Reassignment request sent to admin");
      onClose();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setRequesting(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose} data-testid="new-chat-modal">
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-md bg-white border border-gray-900 p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">New Chat</div>
            <h2 className="font-chivo font-black text-2xl mt-1">Start by phone</h2>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400"><X size={18} /></button>
        </div>
        {conflict && (
          <div className="border-l-4 border-[#E60000] bg-[#FFE9E9] px-3 py-2 mb-3" data-testid="chat-duplicate-conflict-panel">
            <div className="text-[10px] uppercase tracking-widest font-bold text-[#E60000]">Duplicate phone</div>
            <div className="text-sm mt-1">{conflict.message}</div>
            <div className="text-xs text-gray-700 mt-1">Currently with: <b>{conflict.owned_by_name || "another executive"}</b></div>
            <div className="flex gap-2 mt-2">
              <button type="button" onClick={requestReassignment} disabled={requesting} className="bg-[#E60000] hover:bg-[#cc0000] text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="chat-request-reassignment-btn">
                {requesting ? "Sending…" : "Request Reassignment"}
              </button>
              <button type="button" onClick={() => setConflict(null)} className="border border-gray-300 px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100">Edit phone</button>
            </div>
          </div>
        )}
        <div className="space-y-3">
          <Field label="Phone *">
            <input required autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="8790934618 or +255123456789"
              className="w-full border border-gray-300 px-3 py-2 text-sm font-mono" data-testid="new-chat-phone-input" />
          </Field>
          <Field label="Customer name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional"
              className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-chat-name-input" />
          </Field>
          <Field label="Requirement / context">
            <input value={requirement} onChange={(e) => setRequirement(e.target.value)} placeholder="What are they enquiring about?"
              className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-chat-requirement-input" />
          </Field>
          {isAdmin && (
            <Field label="Assign to">
              <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}
                className="w-full border border-gray-300 px-2 py-2 text-sm" data-testid="new-chat-assign-select">
                <option value="">Auto (round-robin)</option>
                {execs.map(x => <option key={x.id} value={x.id}>{x.role === "admin" ? `${x.name} (admin)` : x.name}</option>)}
              </select>
            </Field>
          )}
          <div className="text-xs text-gray-500 leading-relaxed border border-gray-200 bg-gray-50 p-3">
            If a lead with this phone already exists and is yours, it'll open. If it's another executive's lead,
            you can send a reassignment request to admin. WhatsApp Cloud API requires a template message for
            first-touch outside the 24-hour window.
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100" data-testid="new-chat-cancel-btn">Cancel</button>
          <button disabled={busy} className="bg-[#25D366] hover:bg-[#1da851] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="new-chat-submit-btn">
            {busy ? "Starting…" : "Start Chat"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">{label}</div>
      {children}
    </label>
  );
}
