import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import {
  MagnifyingGlass, PaperPlaneRight, ChatCircleDots, Phone, ArrowsClockwise, Plus, ArrowLeft,
  Funnel, Lightning, ArrowsLeftRight, X, Tag, NotePencil, Info,
  Paperclip, Image as ImageIcon, VideoCamera, FileText, Microphone, MapPin, IdentificationCard, Stop,
  DownloadSimple, Question, ChatTeardropText, CaretLeft,
} from "@phosphor-icons/react";
import { fmtIST, fmtISTTime, fmtSmartShort, fmtSmartLong, fmtTime12, fmtDaySeparator, istDayKey } from "@/lib/format";
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
  const [filterReplied, setFilterReplied] = useState(false);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [execs, setExecs] = useState([]);
  const [showNewChat, setShowNewChat] = useState(false);

  const isAdmin = user.role === "admin";

  // Mobile detection — used to wire the phone back-button to "close current
  // chat" instead of navigating away from /chat entirely.
  const isMobilePage = useMemo(() => {
    if (typeof window === "undefined") return false;
    const touch = (("ontouchstart" in window) || (navigator.maxTouchPoints > 0));
    const narrow = window.matchMedia ? window.matchMedia("(max-width: 767px)").matches : window.innerWidth < 768;
    return touch && narrow;
  }, []);

  // On mobile, when the user opens a chat (activeId set) push a synthetic
  // history entry so the browser back-button pops the chat-thread view back
  // to the chat list instead of leaving /chat altogether.
  useEffect(() => {
    if (!isMobilePage) return;
    if (!activeId) return;
    window.history.pushState({ chatOpen: activeId }, "");
    const onPop = () => {
      // back button pressed while a chat is open on mobile → close chat
      setActiveId(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [isMobilePage, activeId]);

  const fetchConvs = useCallback(async () => {
    try {
      const { data } = await api.get("/inbox/conversations", {
        params: {
          q: search || undefined,
          only_unread: filterUnread || undefined,
          only_unreplied: filterUnreplied || undefined,
          only_replied: filterReplied || undefined,
          status: filterStatus || undefined,
          assigned_to: filterAssignee || undefined,
        },
      });
      // Sort by last_message timestamp DESC (full ISO datetime → lexicographic
      // comparison is correct because ISO-8601 sorts chronologically). Falls
      // back to last_in_at, last_out_at, then last_action_at.
      const sorted = [...data].sort((a, b) => {
        const ta = a.last_message?.at || a.last_in_at || a.last_out_at || a.last_action_at || "";
        const tb = b.last_message?.at || b.last_in_at || b.last_out_at || b.last_action_at || "";
        return tb.localeCompare(ta);
      });
      setConvs(sorted);
    } catch (e) {
      // silent; toast on hard fail
      const msg = errMsg(e, "");
      if (msg && !msg.toLowerCase().includes("network")) toast.error(msg);
    }
  }, [search, filterUnread, filterUnreplied, filterReplied, filterStatus, filterAssignee]);

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

  // Sync active lead id to URL — preserve tab/agent/phone deep-link params if present
  // so links from /qa or /leads remain shareable (copy-paste URL still restores state).
  useEffect(() => {
    const p = {};
    if (activeId) p.lead = activeId;
    const tab = params.get("tab");
    const agent = params.get("agent");
    const phone = params.get("phone");
    if (tab) p.tab = tab;
    if (agent) p.agent = agent;
    if (phone) p.phone = phone;
    setParams(p, { replace: true });
  }, [activeId, setParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeConv = useMemo(() => convs.find(c => c.id === activeId), [convs, activeId]);
  const totalUnread = convs.reduce((s, c) => s + (c.unread || 0), 0);
  // Capture the initial deep-link params ONCE so the URL-sync effect below doesn't
  // strip them before ChatThread mounts (convs are loaded async).
  const initialDeeplink = useMemo(() => ({
    tab: params.get("tab"),
    agent: params.get("agent"),
    phone: params.get("phone"),
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-full flex bg-[#EFEAE2]" data-testid="chat-page">
      <Lightbox />
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
            <FilterChip active={filterReplied} onClick={() => setFilterReplied(v => !v)} testId="filter-replied">Replied</FilterChip>
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
            initialTab={initialDeeplink.tab}
            initialAgentId={initialDeeplink.agent}
            initialPhone={initialDeeplink.phone}
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
  const hasUnread = (c.unread || 0) > 0;
  return (
    <button onClick={onClick} data-testid={`conv-row-${c.id}`}
      className={`w-full text-left px-3 py-3 flex gap-3 border-b border-gray-100 transition-colors ${
        active
          ? "bg-[#F0F2F5]"
          : hasUnread
            ? "bg-[#E7F7E6] hover:bg-[#D4F0D2] border-l-[3px] border-l-[#25D366]"
            : "hover:bg-gray-50 border-l-[3px] border-l-transparent"
      }`}
      data-unread={hasUnread || undefined}>
      <div className="w-10 h-10 rounded-full bg-[#25D366] flex items-center justify-center text-white font-bold text-sm shrink-0">
        {(c.customer_name || "?").slice(0, 1).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <div className={`text-sm truncate ${hasUnread ? "font-bold text-gray-900" : "font-semibold"}`}>{c.customer_name || c.phone}</div>
          <div className={`text-[10px] shrink-0 ml-2 ${hasUnread ? "text-[#25D366] font-bold" : "text-gray-500"}`} title={last.at ? fmtIST(last.at) : ""}>
            {last.at ? fmtSmartShort(last.at) : ""}
          </div>
        </div>
        {c.phone && (
          <div className="text-[11px] text-gray-500 font-mono flex items-center gap-1 mt-0.5">
            <Phone size={10} weight="bold" /> {c.phone}
          </div>
        )}
        <div className="flex items-center justify-between mt-0.5">
          <div className={`text-xs truncate flex-1 ${hasUnread ? "text-gray-900 font-semibold" : "text-gray-500"}`}>
            {last.direction === "out" && (
              <span className={`mr-1 ${tickColor(last.status)}`}>{tickFor(last.status)}</span>
            )}
            {previewText(last)}
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            {hasUnread && (
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
          {c.internal_qa_status === "pending" && (
            <span className="inline-flex items-center gap-1 bg-[#FFF4E5] border border-[#E67E00] text-[#B85F00] text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5" data-testid={`qa-tag-pending-${c.id}`}>
              Question Asked
            </span>
          )}
          {c.internal_qa_status === "answered" && (
            <span className="inline-flex items-center gap-1 bg-[#E7F7E6] border border-[#008A00] text-[#005F00] text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5" data-testid={`qa-tag-answered-${c.id}`}>
              Answered
            </span>
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
function ChatThread({ conv, user, execs, onClose, onChanged, initialTab, initialAgentId, initialPhone }) {
  const isAdmin = user.role === "admin";
  const canMessage = isAdmin || conv.assigned_to === user.id;
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [showTpl, setShowTpl] = useState(false);
  const [showInfo, setShowInfo] = useState(initialTab === "internal");
  const [panelTab, setPanelTab] = useState(initialTab === "internal" ? "internal" : "details"); // 'details' | 'internal'
  const [internalQuote, setInternalQuote] = useState(null); // WA message selected to ask admin about
  const [internalPreselectAgent, setInternalPreselectAgent] = useState(initialAgentId || null);
  // In-chat search (#4) — searches body / caption / template_name within this thread
  const [showInChatSearch, setShowInChatSearch] = useState(false);
  const [inChatQuery, setInChatQuery] = useState("");
  const [searchHits, setSearchHits] = useState([]); // ids of matching messages
  const [searchCursor, setSearchCursor] = useState(0); // index into searchHits
  const [quickReplies, setQuickReplies] = useState([]);
  const [qrSearch, setQrSearch] = useState("");
  const [templates, setTemplates] = useState([]);
  const [savingMeta, setSavingMeta] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [replyTo, setReplyTo] = useState(null);  // {id, preview, direction}
  const [showAttach, setShowAttach] = useState(false);
  const [attachMode, setAttachMode] = useState(null);  // 'location' | 'contact' | null
  const [recording, setRecording] = useState(null);  // {recorder, chunks, startedAt} or null
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);
  const fileKindRef = useRef("image");
  const inputRef = useRef(null);

  // Mobile detection — touch + small viewport. Re-evaluated on mount.
  const isMobile = useMemo(() => {
    if (typeof window === "undefined") return false;
    const touch = (("ontouchstart" in window) || (navigator.maxTouchPoints > 0));
    const narrow = window.matchMedia ? window.matchMedia("(max-width: 767px)").matches : window.innerWidth < 768;
    return touch && narrow;
  }, []);

  const exec = execs.find(e => e.id === conv.assigned_to);
  const within24h = !!conv.within_24h;
  // Per-phone filter (#3 from /leads parity spec). When deep-linked from /leads
  // with `?phone=…`, this filters the WA history to only the conversations
  // addressed to/from that specific number — never merging across phones.
  // NOTE: /chat itself does NOT alter the lead's active_wa_phone — that's a
  // /leads-only concern. The filter here is purely a view-side restriction.
  const [phoneFilter, setPhoneFilter] = useState(initialPhone || "");

  const loadMessages = useCallback(async () => {
    try {
      const params = phoneFilter ? { phone: phoneFilter } : {};
      const { data } = await api.get(`/leads/${conv.id}/messages`, { params });
      // Stable-identity merge: keep the previous object reference for any message
      // whose body hasn't changed since the last poll. This lets React.memo bail
      // out of re-rendering thousands of bubbles on every 4-second poll. We use
      // a shallow-key signature of the mutable fields (status, reactions, edited
      // body/caption) so updates still flow through.
      setMessages((prev) => {
        if (!Array.isArray(data)) return prev;
        if (!prev || prev.length === 0) return data;
        const byId = new Map(prev.map((m) => [m.id, m]));
        const sig = (m) => `${m.status || ""}|${m.body || ""}|${m.caption || ""}|${m.media_url || ""}|${(m.reactions || []).length}|${m.error || ""}`;
        return data.map((m) => {
          const old = byId.get(m.id);
          if (old && sig(old) === sig(m)) return old;
          return m;
        });
      });
    } catch (e) {
      const msg = errMsg(e, "");
      if (msg && !msg.toLowerCase().includes("network")) toast.error(msg);
    }
  }, [conv.id, phoneFilter]);

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

  // Refresh QR list when dropdown opens
  useEffect(() => {
    if (showQR) {
      api.get("/quick-replies").then(({ data }) => setQuickReplies(data)).catch(() => {});
    }
  }, [showQR]);

  // Auto-expand the message input as the user types (WhatsApp-style). Caps
  // at ~6 lines; beyond that the textarea internally scrolls.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 144; // ~6 lines @ 24px line-height
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  // WhatsApp-style jump-to-quoted-message. Scrolls the bubble into view + adds
  // a temporary highlight ring so the user knows where it landed.
  const jumpToMessage = useCallback((msgId) => {
    if (!msgId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-testid="bubble-${msgId}"]`);
    if (!el) {
      toast.error("Original message not loaded");
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Drop a transient highlight class on the inner bubble div.
    const inner = el.querySelector("div");
    if (inner) {
      inner.classList.add("ring-4", "ring-[#FF8800]", "ring-offset-1");
      setTimeout(() => {
        inner.classList.remove("ring-4", "ring-[#FF8800]", "ring-offset-1");
      }, 1400);
    }
  }, []);

  // Group messages by IST day key — used to render sticky day separators
  // (#2 WhatsApp-style). Memoized so we don't re-walk the array on each render.
  const messageGroups = useMemo(() => {
    const groups = [];
    let lastKey = "";
    for (const m of messages) {
      const k = istDayKey(m.at);
      if (k !== lastKey) {
        groups.push({ dayKey: k, items: [] });
        lastKey = k;
      }
      groups[groups.length - 1].items.push(m);
    }
    return groups;
  }, [messages]);

  // Compute in-chat search hits (#4). Empty query → no hits.
  // Filtering is purely client-side over what's already rendered.
  useEffect(() => {
    const q = inChatQuery.trim().toLowerCase();
    if (!q) { setSearchHits([]); setSearchCursor(0); return; }
    const hits = [];
    for (const m of messages) {
      const haystack = [
        m.body, m.caption, m.template_name, m.media_filename,
        m.contact_name, m.location_address, m.location_name,
      ].filter(Boolean).join(" ").toLowerCase();
      if (haystack.includes(q)) hits.push(m.id);
    }
    setSearchHits(hits);
    setSearchCursor(hits.length > 0 ? 0 : 0);
  }, [inChatQuery, messages]);

  // Scroll the focused search hit into view as the cursor moves
  useEffect(() => {
    if (searchHits.length === 0 || !scrollRef.current) return;
    const id = searchHits[searchCursor];
    const el = scrollRef.current.querySelector(`[data-testid="bubble-${id}"]`);
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [searchCursor, searchHits]);
  const focusedHitId = searchHits[searchCursor];

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

  const applyQR = async (qr) => {
    // Media QR → send immediately (image/video/document/audio + optional caption)
    if (qr.media_url && qr.media_type) {
      if (!within24h) {
        toast.error("Outside 24-hour window — cannot send media");
        return;
      }
      setSending(true);
      try {
        const cap = (qr.caption || qr.text || "").replace("{{name}}", conv.customer_name || "");
        const payload = {
          lead_id: conv.id,
          media_type: qr.media_type,
          media_url: qr.media_url,
        };
        if (cap.trim() && (qr.media_type === "image" || qr.media_type === "video" || qr.media_type === "document")) {
          payload.caption = cap.trim();
        }
        if (qr.media_type === "document" && qr.media_filename) payload.filename = qr.media_filename;
        if (replyTo?.id) payload.reply_to_message_id = replyTo.id;
        await api.post("/whatsapp/send-media", payload);
        setReplyTo(null);
        toast.success(`Sent ${qr.media_type}`);
        loadMessages();
        onChanged?.();
      } catch (e) {
        toast.error(errMsg(e, "Quick reply send failed"));
      } finally {
        setSending(false);
        setShowQR(false);
        setQrSearch("");
      }
      return;
    }
    // Text-only QR → append to draft for editing
    const text = (qr.text || "").replace("{{name}}", conv.customer_name || "");
    setDraft((d) => (d ? d + " " : "") + text);
    setShowQR(false);
    setQrSearch("");
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

  // ────────── Rich media send helpers ──────────
  const uploadAndSend = async (file, kind) => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      toast.error("File too large (max 50 MB)");
      return;
    }
    setSending(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      const { data: up } = await api.post("/chatflows/upload-media", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const payload = {
        lead_id: conv.id,
        media_type: kind,
        media_url: up.url,
      };
      if (kind === "document" && up.filename) payload.filename = up.filename;
      if (replyTo?.id) payload.reply_to_message_id = replyTo.id;
      await api.post("/whatsapp/send-media", payload);
      setReplyTo(null);
      loadMessages();
      onChanged?.();
      toast.success(`Sent ${kind}`);
    } catch (e) {
      toast.error(errMsg(e, `Failed to send ${kind}`));
    } finally {
      setSending(false);
      setShowAttach(false);
    }
  };

  const pickFile = (kind) => {
    fileKindRef.current = kind;
    if (fileInputRef.current) {
      fileInputRef.current.accept = kind === "image" ? "image/*" : kind === "video" ? "video/*" : kind === "audio" ? "audio/*" : "";
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  };

  const onFilePicked = (e) => {
    const f = e.target.files?.[0];
    if (f) uploadAndSend(f, fileKindRef.current);
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Audio recording not supported in this browser");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus") ? "audio/ogg;codecs=opus" : "";
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
        const ext = (blob.type.includes("ogg") ? "ogg" : "webm");
        const file = new File([blob], `voice_${Date.now()}.${ext}`, { type: blob.type });
        await uploadAndSend(file, "audio");
      };
      rec.start();
      setRecording({ rec, startedAt: Date.now() });
      setShowAttach(false);
    } catch (e) {
      toast.error("Microphone permission denied");
    }
  };

  const stopRecording = () => {
    if (recording?.rec) {
      try { recording.rec.stop(); } catch (e) {}
    }
    setRecording(null);
  };

  const sendLocation = async ({ latitude, longitude, name, address }) => {
    setSending(true);
    try {
      const payload = { lead_id: conv.id, latitude: Number(latitude), longitude: Number(longitude) };
      if (name) payload.name = name;
      if (address) payload.address = address;
      if (replyTo?.id) payload.reply_to_message_id = replyTo.id;
      await api.post("/whatsapp/send-location", payload);
      setReplyTo(null); setAttachMode(null); setShowAttach(false);
      loadMessages(); onChanged?.();
      toast.success("Location sent");
    } catch (e) { toast.error(errMsg(e, "Failed to send location")); }
    finally { setSending(false); }
  };

  const sendContact = async (contact) => {
    setSending(true);
    try {
      const payload = { lead_id: conv.id, ...contact };
      if (replyTo?.id) payload.reply_to_message_id = replyTo.id;
      await api.post("/whatsapp/send-contact", payload);
      setReplyTo(null); setAttachMode(null); setShowAttach(false);
      loadMessages(); onChanged?.();
      toast.success("Contact card sent");
    } catch (e) { toast.error(errMsg(e, "Failed to send contact")); }
    finally { setSending(false); }
  };

  const resendMessage = async (m) => {
    try {
      await api.post("/whatsapp/resend", { message_id: m.id });
      loadMessages();
      toast.success("Message resent");
    } catch (e) { toast.error(errMsg(e, "Resend failed")); }
  };

  const reactToMessage = async (m, emoji) => {
    try {
      await api.post("/whatsapp/react", { message_id: m.id, emoji });
      loadMessages();
    } catch (e) { toast.error(errMsg(e, "Reaction failed")); }
  };

  // Stable callback identities so React.memo'd Bubble doesn't re-render on every poll. (#5)
  const handleReply = useCallback((target) => setReplyTo({
    id: target.id,
    preview: (target.caption || target.body || "").slice(0, 120),
    direction: target.direction,
  }), []);
  const handleAskAdmin = useCallback((target) => {
    setInternalQuote({
      id: target.id,
      preview: (target.caption || target.body || "").slice(0, 120),
      direction: target.direction,
      at: target.at,
      msg_type: target.msg_type,
    });
    setShowInfo(true);
    setPanelTab("internal");
  }, []);
  const askAdminFn = canMessage && user.role === "executive" ? handleAskAdmin : null;
  const resendFn = canMessage ? resendMessage : null;
  const reactFn = canMessage ? reactToMessage : null;

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
        <button onClick={() => setShowInChatSearch(v => !v)} className={`p-2 ${showInChatSearch ? "bg-gray-900 text-white" : "hover:bg-gray-100"}`} title="Search in chat" data-testid="chat-search-toggle">
          <MagnifyingGlass size={16} weight={showInChatSearch ? "bold" : "regular"} />
        </button>
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
          {/* Per-phone filter banner — when deep-linked from /leads with ?phone=… */}
          {phoneFilter && (
            <div className="bg-[#FFF4E5] border-b border-[#E67E00] px-3 py-1.5 flex items-center gap-2 text-xs" data-testid="chat-phone-filter-banner">
              <Phone size={12} className="text-[#B85F00]" />
              <span className="text-[#B85F00] font-bold uppercase tracking-widest text-[10px]">Showing only:</span>
              <span className="font-mono text-[#B85F00]">{phoneFilter}</span>
              <button
                onClick={() => setPhoneFilter("")}
                className="ml-auto text-[10px] uppercase tracking-widest text-[#B85F00] hover:underline font-bold"
                data-testid="chat-phone-filter-clear"
              >Show all numbers</button>
            </div>
          )}
          {/* In-chat search bar (#4) */}
          {showInChatSearch && (
            <div className="bg-[#F0F2F5] border-b border-gray-200 px-3 py-2 flex items-center gap-2" data-testid="in-chat-search-bar">
              <MagnifyingGlass size={14} className="text-gray-500" />
              <input
                value={inChatQuery}
                onChange={(e) => setInChatQuery(e.target.value)}
                placeholder="Search messages by name, phone or text…"
                autoFocus
                className="flex-1 bg-white border border-gray-300 px-2 py-1 text-sm outline-none focus:border-[#002FA7]"
                data-testid="in-chat-search-input"
              />
              {inChatQuery && (
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold" data-testid="in-chat-search-counter">
                  {searchHits.length === 0 ? "No matches" : `${searchCursor + 1} / ${searchHits.length}`}
                </span>
              )}
              <button
                onClick={() => setSearchCursor((c) => searchHits.length ? (c - 1 + searchHits.length) % searchHits.length : 0)}
                disabled={searchHits.length === 0}
                className="border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-40"
                title="Previous match"
                data-testid="in-chat-search-prev"
              >↑</button>
              <button
                onClick={() => setSearchCursor((c) => searchHits.length ? (c + 1) % searchHits.length : 0)}
                disabled={searchHits.length === 0}
                className="border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-40"
                title="Next match"
                data-testid="in-chat-search-next"
              >↓</button>
              <button
                onClick={() => { setShowInChatSearch(false); setInChatQuery(""); }}
                className="text-gray-500 hover:text-gray-900 px-1"
                title="Close"
                data-testid="in-chat-search-close"
              ><X size={14} /></button>
            </div>
          )}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1.5" style={{ background: "#EFEAE2", contain: "strict", overscrollBehavior: "contain", willChange: "scroll-position" }} data-testid="messages-area">
            {messages.length === 0 && (
              <div className="text-center text-xs uppercase tracking-widest text-gray-500 py-12">No messages yet</div>
            )}
            {messageGroups.map((g) => (
              <DayGroup
                key={g.dayKey}
                group={g}
                allMessages={messages}
                canMessage={canMessage && within24h}
                currentUserId={user?.id}
                searchQuery={inChatQuery.trim()}
                focusedHitId={focusedHitId}
                searchHitsSet={searchHits}
                onReply={handleReply}
                onResend={resendFn}
                onReact={reactFn}
                onAskAdmin={askAdminFn}
                onJumpTo={jumpToMessage}
              />
            ))}
          </div>

          {/* Quick reply dropdown */}
          {showQR && (
            <div className="bg-white border-t border-gray-200 max-h-64 overflow-hidden flex flex-col" data-testid="qr-dropdown">
              <div className="px-3 py-2 border-b border-gray-100 bg-gray-50">
                <input
                  autoFocus
                  type="text"
                  value={qrSearch}
                  onChange={(e) => setQrSearch(e.target.value)}
                  placeholder="Search quick replies…"
                  className="w-full border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-[#25D366]"
                  data-testid="qr-search-input"
                />
              </div>
              <div className="overflow-y-auto flex-1">
                {(() => {
                  const q = qrSearch.trim().toLowerCase();
                  const filtered = q
                    ? quickReplies.filter((qr) =>
                        (qr.title || "").toLowerCase().includes(q) ||
                        (qr.text || "").toLowerCase().includes(q) ||
                        (qr.caption || "").toLowerCase().includes(q) ||
                        (qr.media_filename || "").toLowerCase().includes(q)
                      )
                    : quickReplies;
                  if (filtered.length === 0) {
                    return (
                      <div className="px-4 py-6 text-xs uppercase tracking-widest text-gray-400 text-center" data-testid="qr-empty">
                        {quickReplies.length === 0 ? "No quick replies — create them in /quick-replies" : "No matches"}
                      </div>
                    );
                  }
                  return filtered.map((qr) => {
                    const previewText = (qr.text || qr.caption || (qr.media_filename ? `[${qr.media_type}] ${qr.media_filename}` : "")).replace(/\s+/g, " ").trim();
                    return (
                      <button
                        key={qr.id}
                        onClick={() => applyQR(qr)}
                        disabled={sending}
                        className="w-full text-left px-4 py-2 hover:bg-gray-50 border-b border-gray-100 disabled:opacity-50"
                        data-testid={`qr-${qr.id}`}
                      >
                        <div className="flex items-center gap-2">
                          <div className="text-xs font-bold uppercase tracking-widest text-gray-500 truncate flex-1">{qr.title}</div>
                          {qr.media_url && qr.media_type && (
                            <span className="bg-[#25D366] text-white px-1.5 py-0.5 text-[8px] uppercase tracking-widest font-bold shrink-0" data-testid={`qr-media-badge-${qr.id}`}>
                              {qr.media_type}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-800 truncate" data-testid={`qr-preview-${qr.id}`}>
                          {previewText || <span className="text-gray-400 italic">(no text)</span>}
                        </div>
                      </button>
                    );
                  });
                })()}
              </div>
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
            <div className="bg-[#F0F2F5] border-t border-gray-200 p-3 flex items-end gap-2 relative" data-testid="chat-composer">
              <input ref={fileInputRef} type="file" onChange={onFilePicked} className="hidden" data-testid="hidden-file-input" />
              <button onClick={() => { setShowAttach(v => !v); setShowQR(false); setShowTpl(false); }} title="Attach"
                className={`p-2 ${showAttach ? "bg-gray-900 text-white" : "hover:bg-gray-200 text-gray-700"}`} disabled={!within24h} data-testid="attach-toggle">
                <Paperclip size={18} weight="bold" />
              </button>
              {showAttach && (
                <div className="absolute bottom-16 left-3 bg-white border border-gray-200 shadow-md z-10 w-52" data-testid="attach-menu">
                  <button onClick={() => pickFile("image")} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-sm" data-testid="attach-image"><ImageIcon size={16} className="text-[#C2410C]" /> Photo</button>
                  <button onClick={() => pickFile("video")} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-sm" data-testid="attach-video"><VideoCamera size={16} className="text-[#BE185D]" /> Video</button>
                  <button onClick={() => pickFile("document")} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-sm" data-testid="attach-document"><FileText size={16} className="text-[#475569]" /> Document</button>
                  <button onClick={() => pickFile("audio")} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-sm" data-testid="attach-audio-file"><Microphone size={16} className="text-[#7C3AED]" /> Audio file</button>
                  <button onClick={startRecording} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-sm border-t border-gray-100" data-testid="attach-record"><Microphone size={16} weight="fill" className="text-[#E60000]" /> Record voice note</button>
                  <button onClick={() => { setAttachMode("location"); setShowAttach(false); }} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-sm border-t border-gray-100" data-testid="attach-location"><MapPin size={16} className="text-[#0891B2]" /> Location</button>
                  <button onClick={() => { setAttachMode("contact"); setShowAttach(false); }} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-sm" data-testid="attach-contact"><IdentificationCard size={16} className="text-[#15803D]" /> Contact</button>
                </div>
              )}
              <button onClick={() => { setShowQR(v => !v); setShowTpl(false); setShowAttach(false); }} title="Quick replies"
                className={`p-2 ${showQR ? "bg-gray-900 text-white" : "hover:bg-gray-200 text-gray-700"}`} data-testid="qr-toggle">
                <Lightning size={18} weight="bold" />
              </button>
              <button onClick={() => { setShowTpl(v => !v); setShowQR(false); setShowAttach(false); }} title="Templates"
                className={`px-3 py-2 text-[10px] uppercase tracking-widest font-bold ${showTpl ? "bg-gray-900 text-white" : "border border-gray-300 hover:bg-gray-200"}`} data-testid="tpl-toggle">
                Tpl
              </button>
              {recording ? (
                <div className="flex-1 flex items-center gap-2 bg-[#FFE9E9] border border-[#E60000] px-3 py-2 text-sm" data-testid="recording-bar">
                  <span className="w-2 h-2 rounded-full bg-[#E60000] animate-pulse" />
                  <span className="text-[#E60000] font-bold">Recording…</span>
                  <button onClick={stopRecording} className="ml-auto bg-[#E60000] text-white px-3 py-1 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="recording-stop">
                    <Stop size={12} weight="fill" /> Stop &amp; send
                  </button>
                </div>
              ) : (
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={!within24h}
                  onKeyDown={(e) => {
                    // Desktop: Enter sends, Shift+Enter newline.
                    // Mobile: Enter ALWAYS inserts a newline; only the Send button submits.
                    if (e.key === "Enter" && !e.shiftKey && !isMobile) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={within24h ? "Type a message…" : "Outside 24-hour window — use a template (Tpl ↑)"}
                  rows={1}
                  style={{ maxHeight: 144 }}
                  className="flex-1 resize-none border border-gray-300 px-3 py-2 text-sm leading-6 outline-none focus:border-[#25D366] disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
                  data-testid="chat-input"
                  data-mobile={isMobile ? "1" : "0"}
                />
              )}
              {!recording && (
                <button onClick={send} disabled={!draft.trim() || sending || !within24h}
                  className="bg-[#25D366] hover:bg-[#1da851] text-white p-2 disabled:opacity-50 disabled:cursor-not-allowed" data-testid="chat-send-btn">
                  <PaperPlaneRight size={18} weight="fill" />
                </button>
              )}
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
            className="fixed inset-y-0 right-0 z-30 w-full sm:w-[360px] lg:relative lg:inset-auto lg:w-[340px] lg:z-auto shrink-0 bg-white border-l border-gray-200 overflow-y-auto flex flex-col"
            data-testid="lead-info-panel"
          >
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between shrink-0">
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Lead Details</div>
              <button onClick={() => setShowInfo(false)} className="text-gray-400 hover:text-gray-900"><X size={14} /></button>
            </div>
            {/* Tabs */}
            <div className="flex border-b border-gray-200 shrink-0" data-testid="lead-panel-tabs">
              <button
                onClick={() => setPanelTab("details")}
                className={`flex-1 px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center justify-center gap-1 ${panelTab === "details" ? "bg-[#002FA7] text-white" : "hover:bg-gray-100 text-gray-600"}`}
                data-testid="tab-details"
              >
                <Info size={12} /> Details
              </button>
              <button
                onClick={() => { setPanelTab("internal"); }}
                className={`flex-1 px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center justify-center gap-1 ${panelTab === "internal" ? "bg-[#002FA7] text-white" : "hover:bg-gray-100 text-gray-600"}`}
                data-testid="tab-internal"
              >
                <ChatTeardropText size={12} /> Internal Q&amp;A
              </button>
            </div>
            {panelTab === "details" ? (
            <div className="p-4 space-y-4 text-sm overflow-y-auto">
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
            ) : (
            <InternalChat
              leadId={conv.id}
              currentUser={user}
              assignedTo={conv.assigned_to}
              execs={execs}
              quote={internalQuote}
              clearQuote={() => setInternalQuote(null)}
              preselectAgentId={internalPreselectAgent}
              onPreselectConsumed={() => setInternalPreselectAgent(null)}
              onJumpToWa={jumpToMessage}
            />
            )}
          </aside>
        )}
      </div>
      {attachMode === "location" && (
        <LocationSendModal onClose={() => setAttachMode(null)} onSend={sendLocation} sending={sending} />
      )}
      {attachMode === "contact" && (
        <ContactSendModal onClose={() => setAttachMode(null)} onSend={sendContact} sending={sending} lead={conv} />
      )}
    </>
  );
}

function LocationSendModal({ onClose, onSend, sending }) {
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  // Office preset — CitSpray, Nagpur. Pre-filled per admin request.
  const OFFICE = {
    lat: "21.109974",
    lng: "79.064088",
    name: "CitSpray",
    address: "B wing, Poonam Heights, Pande Layout, Khamla, Nagpur - 440025",
  };
  const fillOffice = () => {
    setLat(OFFICE.lat);
    setLng(OFFICE.lng);
    setName(OFFICE.name);
    setAddress(OFFICE.address);
  };
  const sendOfficeNow = () => {
    // One-click variant — bypass the form so reps can fire-and-forget.
    onSend({ latitude: OFFICE.lat, longitude: OFFICE.lng, name: OFFICE.name, address: OFFICE.address });
  };
  const useMyLocation = () => {
    if (!navigator.geolocation) { toast.error("Geolocation unavailable"); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setLat(p.coords.latitude.toFixed(6)); setLng(p.coords.longitude.toFixed(6)); },
      () => toast.error("Could not read your location"),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };
  const submit = (e) => {
    e.preventDefault();
    if (!lat || !lng) { toast.error("Latitude and longitude are required"); return; }
    onSend({ latitude: lat, longitude: lng, name, address });
  };
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-md bg-white border border-gray-900 p-6 space-y-3" data-testid="send-location-modal">
        <h3 className="font-chivo font-black text-xl">Send Location</h3>
        {/* Office quick-action — one click sends immediately. */}
        <div className="border border-[#002FA7] bg-[#002FA7]/5 p-3" data-testid="loc-office-card">
          <div className="text-[10px] uppercase tracking-widest text-[#002FA7] font-bold mb-1">Office</div>
          <div className="text-sm font-bold">{OFFICE.name}</div>
          <div className="text-xs text-gray-600">{OFFICE.address}</div>
          <div className="text-[10px] font-mono text-gray-500 mt-0.5">{OFFICE.lat}, {OFFICE.lng}</div>
          <div className="flex gap-2 mt-2">
            <button type="button" onClick={sendOfficeNow} disabled={sending} className="bg-[#25D366] hover:bg-[#1EB755] text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="loc-send-office-btn">
              {sending ? "Sending…" : "Send office location"}
            </button>
            <button type="button" onClick={fillOffice} className="border border-gray-300 hover:border-gray-900 px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold" data-testid="loc-fill-office-btn">
              Pre-fill
            </button>
          </div>
        </div>
        <div className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">Or send a custom location</div>
        <div className="grid grid-cols-2 gap-2">
          <input required placeholder="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} className="border border-gray-300 px-3 py-2 text-sm font-mono" data-testid="loc-lat" />
          <input required placeholder="Longitude" value={lng} onChange={(e) => setLng(e.target.value)} className="border border-gray-300 px-3 py-2 text-sm font-mono" data-testid="loc-lng" />
        </div>
        <input placeholder="Name (optional) — e.g. 'Office'" value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="loc-name" />
        <input placeholder="Address (optional)" value={address} onChange={(e) => setAddress(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="loc-address" />
        <button type="button" onClick={useMyLocation} className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7] hover:underline" data-testid="loc-use-mine">Use my current location</button>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="border border-gray-300 px-3 py-2 text-[10px] uppercase tracking-widest font-bold">Cancel</button>
          <button disabled={sending} className="bg-[#25D366] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="loc-send-btn">{sending ? "Sending…" : "Send"}</button>
        </div>
      </form>
    </div>
  );
}

function ContactSendModal({ onClose, onSend, sending, lead }) {
  const [name, setName] = useState(lead?.customer_name || "");
  const [phone, setPhone] = useState("");
  const [organization, setOrganization] = useState("");
  const [email, setEmail] = useState("");
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim() || !phone.trim()) { toast.error("Name and at least one phone required"); return; }
    const payload = { name: name.trim(), phones: [{ phone: phone.trim(), type: "CELL" }] };
    if (email.trim()) payload.emails = [{ email: email.trim(), type: "WORK" }];
    if (organization.trim()) payload.organization = organization.trim();
    onSend(payload);
  };
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-md bg-white border border-gray-900 p-6 space-y-3" data-testid="send-contact-modal">
        <h3 className="font-chivo font-black text-xl">Send Contact Card</h3>
        <input required placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="contact-name" />
        <input required placeholder="Phone (+91…)" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm font-mono" data-testid="contact-phone" />
        <input placeholder="Email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="contact-email" />
        <input placeholder="Organization (optional)" value={organization} onChange={(e) => setOrganization(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="contact-org" />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="border border-gray-300 px-3 py-2 text-[10px] uppercase tracking-widest font-bold">Cancel</button>
          <button disabled={sending} className="bg-[#25D366] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="contact-send-btn">{sending ? "Sending…" : "Send"}</button>
        </div>
      </form>
    </div>
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

// DayGroup renders a sticky date separator + the bubbles for that calendar day.
// `position: sticky` + `top: 0` makes the separator pin to the top while scrolling
// through the day's messages — matching WhatsApp's behavior.
const DayGroup = React.memo(function DayGroup({
  group, allMessages, canMessage, currentUserId,
  onReply, onResend, onReact, onAskAdmin, onJumpTo,
  searchQuery, focusedHitId, searchHitsSet,
}) {
  const hitsSet = useMemo(
    () => (searchHitsSet && searchHitsSet.length ? new Set(searchHitsSet) : null),
    [searchHitsSet],
  );
  return (
    <div className="space-y-1.5" data-testid={`day-group-${group.dayKey}`}>
      <div
        className="sticky top-0 z-10 flex justify-center pointer-events-none py-1.5"
        data-testid={`day-separator-${group.dayKey}`}
      >
        <span
          className="bg-white/85 backdrop-blur-sm text-gray-700 text-[11px] font-bold uppercase tracking-widest px-3 py-1 rounded-full shadow-sm border border-gray-200"
          data-day-label={group.dayKey}
        >
          {fmtDaySeparator(group.dayKey)}
        </span>
      </div>
      {group.items.map((m) => (
        <Bubble
          key={m.id}
          m={m}
          allMessages={allMessages}
          canMessage={canMessage}
          currentUserId={currentUserId}
          searchQuery={searchQuery}
          isHighlighted={hitsSet ? hitsSet.has(m.id) : false}
          isFocused={focusedHitId === m.id}
          onReply={onReply}
          onResend={onResend}
          onReact={onReact}
          onAskAdmin={onAskAdmin}
          onJumpTo={onJumpTo}
        />
      ))}
    </div>
  );
});


function _BubbleImpl({ m, allMessages = [], onReply, onResend, onReact, onAskAdmin, onJumpTo, canMessage = true, currentUserId = null, isHighlighted = false, isFocused = false, searchQuery = "" }) {
  const isOut = m.direction === "out";
  const isSystem = m.direction === "system";
  const [pickerOpen, setPickerOpen] = useState(false);
  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <div className="bg-white text-gray-600 text-xs px-3 py-1 shadow-sm">{m.body}</div>
      </div>
    );
  }
  const media = renderMedia(m);
  const hasStructured = media || m.msg_type === "location" || m.msg_type === "contacts";
  const captionText = m.caption || (hasStructured ? "" : m.body);
  const quoted = m.reply_to_message_id
    ? allMessages.find((x) => x.id === m.reply_to_message_id)
    : null;
  const quotedPreview = quoted
    ? ((quoted.caption || quoted.body || "").slice(0, 120))
    : (m.reply_to_preview ? m.reply_to_preview.slice(0, 120) : null);
  const quotedDirection = quoted?.direction || (m.reply_to_wamid && isOut ? "in" : "out");
  // Aggregate reactions for display: {emoji: {count, mine}}
  const reactionAgg = {};
  (m.reactions || []).forEach((r) => {
    const k = r.emoji || "?";
    if (!reactionAgg[k]) reactionAgg[k] = { count: 0, mine: false, directions: new Set() };
    reactionAgg[k].count += 1;
    if (r.direction === "out" && currentUserId && r.user_id === currentUserId) reactionAgg[k].mine = true;
    reactionAgg[k].directions.add(r.direction);
  });
  const handleReact = (emoji) => {
    setPickerOpen(false);
    onReact?.(m, emoji);
  };
  return (
    <div className={`group flex ${isOut ? "justify-end" : "justify-start"} relative ${isHighlighted ? "transition-all" : ""}`} data-testid={`bubble-${m.id}`}>
      {/* keep legacy testid for back-compat */}
      <span className="hidden" data-testid={`msg-${m.id}`} aria-hidden="true" />
      {!isOut && canMessage && onReply && (
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center gap-0.5 self-center mr-1">
          {onReact && (
            <button onClick={() => setPickerOpen(v => !v)} className="text-gray-500 hover:text-[#FF8800] text-sm" title="React" data-testid={`react-btn-${m.id}`}>
              😊
            </button>
          )}
          <button onClick={() => onReply(m)} className="text-gray-500 hover:text-[#25D366] text-[10px] uppercase tracking-widest font-bold px-1" title="Reply" data-testid={`reply-btn-${m.id}`}>
            ↩
          </button>
          {onAskAdmin && (
            <button onClick={() => onAskAdmin(m)} className="text-gray-500 hover:text-[#002FA7] text-[10px] uppercase tracking-widest font-bold px-1" title="Ask admin about this message" data-testid={`ask-admin-btn-${m.id}`}>
              <Question size={13} weight="bold" />
            </button>
          )}
        </div>
      )}
      <div className={`max-w-[75%] ${media ? "p-1.5" : "px-3 py-2"} ${isOut ? "bg-[#D9FDD3]" : "bg-white"} text-sm shadow-sm relative ${isHighlighted ? "ring-2 ring-[#FFCC00]" : ""} ${isFocused ? "ring-4 ring-[#FF8800] ring-offset-1" : ""}`}>
        {m.template_name && (
          <div className="text-[9px] uppercase tracking-widest text-gray-500 font-bold mb-1 px-2 pt-1">Template · {m.template_name}</div>
        )}
        {quotedPreview && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (!onJumpTo) return;
              const targetId = quoted?.id || m.reply_to_message_id;
              if (targetId) onJumpTo(targetId);
            }}
            className={`block w-full text-left mb-1.5 border-l-[3px] pl-2 py-1 text-xs bg-black/5 hover:bg-black/10 active:bg-black/15 transition-colors cursor-pointer ${media ? "mx-1.5 mt-1.5" : ""}`}
            style={{ borderColor: quotedDirection === "out" ? "#25D366" : "#002FA7" }}
            data-testid={`quoted-preview-${m.id}`}
            title="Jump to original"
          >
            <div className="text-[9px] uppercase tracking-widest font-bold" style={{ color: quotedDirection === "out" ? "#128C7E" : "#002FA7" }}>
              {quotedDirection === "out" ? "You" : "Customer"}
            </div>
            <div className="text-gray-700 truncate">{quotedPreview}</div>
          </button>
        )}
        {media}
        {m.msg_type === "location" && renderLocation(m)}
        {m.msg_type === "contacts" && renderContacts(m)}
        {captionText && (
          <div className={`whitespace-pre-wrap break-words ${media ? "px-2 pt-1.5" : ""}`}>{captionText}</div>
        )}
        <div className={`flex items-center justify-end gap-1 mt-1 ${media ? "px-2 pb-1" : ""}`}>
          {isOut && m.status === "failed" && onResend && (
            <button onClick={() => onResend(m)} className="text-[9px] text-[#E60000] uppercase tracking-widest font-bold hover:underline mr-2" data-testid={`resend-btn-${m.id}`}>
              ↻ Resend
            </button>
          )}
          <span className="text-[10px] text-gray-500 font-mono" title={fmtSmartLong(m.at)}>{fmtTime12(m.at)}</span>
          {isOut && <span className={`text-[10px] ${tickColor(m.status)}`}>{tickFor(m.status)}</span>}
          {isOut && m.error && <span className="text-[9px] text-[#E60000] uppercase tracking-widest font-bold">{String(m.error).slice(0, 24)}</span>}
        </div>
        {/* Reaction badges anchored to bottom-start of the bubble */}
        {Object.keys(reactionAgg).length > 0 && (
          <div className={`absolute -bottom-3 ${isOut ? "left-2" : "right-2"} flex items-center gap-1`} data-testid={`reactions-${m.id}`}>
            {Object.entries(reactionAgg).map(([emoji, info]) => (
              <button
                key={emoji}
                onClick={() => onReact && info.mine ? onReact(m, "") : onReact && onReact(m, emoji)}
                className={`bg-white border ${info.mine ? "border-[#25D366]" : "border-gray-200"} rounded-full px-1.5 py-0.5 text-[11px] flex items-center gap-0.5 shadow-sm hover:scale-110 transition-transform`}
                title={info.mine ? "Click to remove" : `React ${emoji}`}
                data-testid={`reaction-badge-${emoji}-${m.id}`}
              >
                <span>{emoji}</span>
                {info.count > 1 && <span className="text-[10px] text-gray-600 font-bold">{info.count}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {isOut && canMessage && (onReply || onReact) && (
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center gap-0.5 self-center ml-1">
          {onReact && (
            <button onClick={() => setPickerOpen(v => !v)} className="text-gray-500 hover:text-[#FF8800] text-sm" title="React" data-testid={`react-btn-${m.id}`}>
              😊
            </button>
          )}
          {onReply && (
            <button onClick={() => onReply(m)} className="text-gray-500 hover:text-[#25D366] text-[10px] uppercase tracking-widest font-bold px-1" title="Reply" data-testid={`reply-btn-${m.id}`}>
              ↩
            </button>
          )}
          {onAskAdmin && (
            <button onClick={() => onAskAdmin(m)} className="text-gray-500 hover:text-[#002FA7] text-[10px] uppercase tracking-widest font-bold px-1" title="Ask admin about this message" data-testid={`ask-admin-btn-${m.id}`}>
              <Question size={13} weight="bold" />
            </button>
          )}
        </div>
      )}
      {pickerOpen && (
        <div className={`absolute z-20 ${isOut ? "right-12" : "left-12"} -top-2 bg-white border border-gray-200 shadow-lg px-1.5 py-1.5 flex items-center gap-1`} data-testid={`emoji-picker-${m.id}`}
          onClick={(e) => e.stopPropagation()}>
          {["👍", "❤️", "😂", "😮", "😢", "🙏"].map((e) => (
            <button key={e} onClick={() => handleReact(e)} className="hover:bg-gray-100 w-7 h-7 flex items-center justify-center text-base" data-testid={`emoji-${e}-${m.id}`}>
              {e}
            </button>
          ))}
          <button onClick={() => setPickerOpen(false)} className="ml-1 text-gray-400 hover:text-gray-900 p-1"><X size={12} /></button>
        </div>
      )}
    </div>
  );
}
// Memoize Bubble — re-render only when its specific message reference, search-state,
// or callback set changes. Cuts ~80% of bubble re-renders during chat polling on
// large histories (#5 perf).
const Bubble = React.memo(_BubbleImpl, (prev, next) => {
  if (prev.m !== next.m) return false;
  if (prev.isHighlighted !== next.isHighlighted) return false;
  if (prev.isFocused !== next.isFocused) return false;
  if (prev.canMessage !== next.canMessage) return false;
  if (prev.currentUserId !== next.currentUserId) return false;
  if (prev.searchQuery !== next.searchQuery) return false;
  if (prev.onReply !== next.onReply) return false;
  if (prev.onResend !== next.onResend) return false;
  if (prev.onReact !== next.onReact) return false;
  if (prev.onAskAdmin !== next.onAskAdmin) return false;
  if (prev.onJumpTo !== next.onJumpTo) return false;
  // Reactions live inside `m`; allMessages used only to look up quoted ref by id —
  // skip reference-equality on it and rely on `m` to capture changes.
  return true;
});

function renderMedia(m) {
  const type = m.media_type;
  if (!type) return null;
  const url = m.media_url;  // outbound (admin-provided/uploaded public URL)
  const downloadUrl = url ? `${url}${url.includes("?") ? "&" : "?"}download=1` : null;
  const filename = m.filename || (url ? url.split("/").pop() : "media");
  if (type === "image" && url) {
    return (
      <div className="relative group/media" data-testid={`msg-media-image-${m.id}`}>
        <a href={url} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("lightbox:open", { detail: { url, filename, downloadUrl, kind: "image" } })); }}>
          <img src={url} alt={filename} className="block w-full max-h-[320px] object-cover bg-gray-100 cursor-zoom-in" loading="lazy" />
        </a>
        <a href={downloadUrl} download={filename} className="absolute top-1.5 right-1.5 bg-black/60 hover:bg-black/80 text-white p-1.5 opacity-0 group-hover/media:opacity-100 transition-opacity" title={`Download ${filename}`} data-testid={`download-${m.id}`}>
          <DownloadSimple size={14} weight="bold" />
        </a>
      </div>
    );
  }
  if (type === "video" && url) {
    return (
      <div className="relative group/media" data-testid={`msg-media-video-${m.id}`}>
        <video controls preload="metadata" className="block w-full max-h-[320px] bg-black">
          <source src={url} />
        </video>
        <a href={downloadUrl} download={filename} className="absolute top-1.5 right-1.5 bg-black/60 hover:bg-black/80 text-white p-1.5 opacity-0 group-hover/media:opacity-100 transition-opacity" title={`Download ${filename}`} data-testid={`download-${m.id}`}>
          <DownloadSimple size={14} weight="bold" />
        </a>
      </div>
    );
  }
  if (type === "document" && url) {
    return (
      <div className="flex items-center gap-2 bg-white/60 px-3 py-2 border border-gray-200 text-gray-800" data-testid={`msg-media-document-${m.id}`}>
        <span className="text-lg">📄</span>
        <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 hover:underline">
          <div className="text-xs font-semibold truncate">{filename}</div>
          <div className="text-[10px] text-gray-500 uppercase tracking-widest">Document · Click to preview</div>
        </a>
        <a href={downloadUrl} download={filename} className="text-gray-500 hover:text-[#25D366] p-1" title={`Download ${filename}`} data-testid={`download-${m.id}`}>
          <DownloadSimple size={14} weight="bold" />
        </a>
      </div>
    );
  }
  if (type === "audio" && url) {
    return (
      <div className="flex items-center gap-2" data-testid={`msg-media-audio-${m.id}`}>
        <audio controls preload="metadata" className="block flex-1 min-w-[220px]">
          <source src={url} />
        </audio>
        <a href={downloadUrl} download={filename} className="text-gray-500 hover:text-[#25D366] p-1" title={`Download ${filename}`} data-testid={`download-${m.id}`}>
          <DownloadSimple size={14} weight="bold" />
        </a>
      </div>
    );
  }
  // Inbound without a downloaded URL — show a lightweight placeholder using media_id
  if (m.media_id) {
    const icon = type === "image" ? "🖼️" : type === "video" ? "🎬" : type === "audio" ? "🎧" : "📄";
    return (
      <div className="flex items-center gap-2 bg-gray-100 px-3 py-2 text-gray-700" data-testid={`msg-media-placeholder-${m.id}`}>
        <span className="text-lg">{icon}</span>
        <div className="text-[11px] uppercase tracking-widest font-bold">Incoming {type}</div>
      </div>
    );
  }
  return null;
}

function Lightbox() {
  const [state, setState] = useState(null);  // { url, filename, downloadUrl, kind }
  useEffect(() => {
    const onOpen = (e) => setState(e.detail);
    const onKey = (e) => { if (e.key === "Escape") setState(null); };
    window.addEventListener("lightbox:open", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("lightbox:open", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!state) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-4" onClick={() => setState(null)} data-testid="lightbox">
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <a href={state.downloadUrl} download={state.filename} onClick={(e) => e.stopPropagation()}
          className="bg-white/10 hover:bg-white/20 text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1.5"
          data-testid="lightbox-download">
          <DownloadSimple size={14} weight="bold" /> Download
        </a>
        <button onClick={() => setState(null)} className="bg-white/10 hover:bg-white/20 text-white p-2" data-testid="lightbox-close">
          <X size={18} weight="bold" />
        </button>
      </div>
      <div className="max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <img src={state.url} alt={state.filename} className="max-w-full max-h-[90vh] object-contain" />
        <div className="text-center text-white text-xs mt-2 opacity-70">{state.filename}</div>
      </div>
    </div>
  );
}

function renderLocation(m) {
  const loc = m.location || {};
  const lat = loc.latitude, lng = loc.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  const mapSrc = `https://maps.google.com/maps?q=${lat},${lng}&z=15&output=embed`;
  const openHref = `https://maps.google.com/maps?q=${lat},${lng}`;
  return (
    <div className="-mx-1.5 -my-1.5 mb-0.5 overflow-hidden" data-testid={`msg-location-${m.id}`}>
      <iframe title={`map-${m.id}`} src={mapSrc} width="100%" height="160" loading="lazy" className="block border-0" />
      <a href={openHref} target="_blank" rel="noreferrer" className="block px-3 py-2 bg-white text-xs border-t border-gray-200 hover:bg-gray-50">
        <div className="flex items-center gap-1.5">
          <span className="text-[#0891B2]">📍</span>
          <div className="min-w-0 flex-1">
            {loc.name && <div className="font-semibold truncate">{loc.name}</div>}
            {loc.address && <div className="text-gray-500 truncate">{loc.address}</div>}
            {!loc.name && !loc.address && <div className="font-mono text-[10px] text-gray-500">{lat.toFixed(4)}, {lng.toFixed(4)}</div>}
          </div>
          <span className="text-[10px] uppercase tracking-widest text-[#002FA7] font-bold">Open →</span>
        </div>
      </a>
    </div>
  );
}

function renderContacts(m) {
  const contacts = m.contacts || [];
  if (!contacts.length) return null;
  return (
    <div className="space-y-1.5" data-testid={`msg-contacts-${m.id}`}>
      {contacts.map((c, i) => {
        const name = (c.name || {}).formatted_name || (c.name || {}).first_name || "Contact";
        const firstPhone = (c.phones || [])[0]?.phone;
        const firstEmail = (c.emails || [])[0]?.email;
        const org = (c.org || {}).company;
        return (
          <div key={i} className="bg-white/70 border border-gray-200 px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-full bg-[#25D366] flex items-center justify-center text-white font-bold">
                {(name || "?").slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate">{name}</div>
                {org && <div className="text-[10px] text-gray-500 truncate">{org}</div>}
                {firstPhone && <a href={`tel:${firstPhone}`} className="text-[11px] text-[#002FA7] hover:underline block truncate">{firstPhone}</a>}
                {firstEmail && <a href={`mailto:${firstEmail}`} className="text-[11px] text-[#002FA7] hover:underline block truncate">{firstEmail}</a>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
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


// ---------------- Internal Admin ↔ Agent Q&A ----------------
function InternalChat({ leadId, currentUser, assignedTo, execs, quote, clearQuote, preselectAgentId, onPreselectConsumed, onJumpToWa }) {
  const isAdmin = currentUser?.role === "admin";
  const [threads, setThreads] = useState([]); // admin view
  const [activeAgentId, setActiveAgentId] = useState(preselectAgentId || null); // admin: selected thread
  const [msgs, setMsgs] = useState([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  // Consume the preselect on mount (admin deep-link from /qa)
  useEffect(() => {
    if (preselectAgentId && !activeAgentId) {
      setActiveAgentId(preselectAgentId);
    }
    if (preselectAgentId) onPreselectConsumed?.();
    // eslint-disable-next-line
  }, [preselectAgentId]);

  const canPost = isAdmin ? !!activeAgentId : (assignedTo === currentUser?.id);

  const load = useCallback(async () => {
    if (!leadId) return;
    try {
      if (isAdmin && !activeAgentId) {
        const { data } = await api.get(`/internal-chat/${leadId}`);
        setThreads(data.threads || []);
        return;
      }
      const params = isAdmin ? { agent_id: activeAgentId } : {};
      const { data } = await api.get(`/internal-chat/${leadId}`, { params });
      setMsgs(data.thread || []);
      try { await api.post(`/internal-chat/${leadId}/mark-read`, null, { params: isAdmin ? { agent_id: activeAgentId } : {} }); } catch { /* ignore */ }
    } catch (e) {
      const msg = errMsg(e, "");
      if (msg && !msg.toLowerCase().includes("network")) toast.error(msg);
    }
  }, [leadId, isAdmin, activeAgentId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [msgs.length]);

  const send = async () => {
    if (!draft.trim() || !canPost) return;
    setSending(true);
    try {
      const payload = { lead_id: leadId, body: draft };
      if (isAdmin) payload.to_user_id = activeAgentId;
      if (quote?.id) payload.message_id = quote.id;
      await api.post("/internal-chat/send", payload);
      setDraft("");
      clearQuote?.();
      await load();
    } catch (e) { toast.error(errMsg(e, "Failed to send")); }
    finally { setSending(false); }
  };

  if (isAdmin && !activeAgentId) {
    return (
      <div className="flex-1 overflow-y-auto p-4" data-testid="internal-admin-thread-list">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-3">Private Q&amp;A threads</div>
        {threads.length === 0 && (
          <div className="text-xs text-gray-400 italic">
            No agents have started a private conversation on this lead yet.
            Agents can ask a question by clicking the <Question size={10} className="inline" weight="bold" /> icon on any WhatsApp message.
          </div>
        )}
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Start thread with</div>
          <select
            onChange={(e) => e.target.value && setActiveAgentId(e.target.value)}
            value=""
            className="w-full border border-gray-300 px-2 py-2 text-sm"
            data-testid="internal-admin-start-with"
          >
            <option value="">— Select agent —</option>
            {execs.filter((x) => x.role === "executive").map((x) => (
              <option key={x.id} value={x.id}>{x.name} (@{x.username})</option>
            ))}
          </select>
        </div>
        <div className="mt-4 space-y-2">
          {threads.map((t) => (
            <button
              key={t.agent_id}
              onClick={() => setActiveAgentId(t.agent_id)}
              className="w-full text-left border border-gray-200 hover:border-[#002FA7] hover:bg-[#002FA7]/5 p-3"
              data-testid={`internal-thread-${t.agent_username}`}
            >
              <div className="flex items-center justify-between">
                <div className="font-semibold text-sm">{t.agent_name || t.agent_username || t.agent_id}</div>
                {t.unread_for_admin > 0 && (
                  <span className="bg-[#E60000] text-white text-[10px] px-1.5 py-0.5 font-bold rounded-full">{t.unread_for_admin}</span>
                )}
              </div>
              <div className="text-xs text-gray-600 truncate mt-1">{t.last_body || "—"}</div>
              <div className="text-[10px] text-gray-400 font-mono mt-1">{t.last_at ? fmtIST(t.last_at) : ""} · {t.count} msg{t.count === 1 ? "" : "s"}</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const headerName = isAdmin
    ? (execs.find((x) => x.id === activeAgentId)?.name || "Agent")
    : "Admin";

  return (
    <div className="flex flex-col flex-1 min-h-0" data-testid="internal-chat-thread">
      <div className="px-4 py-2 border-b border-gray-200 shrink-0 flex items-center gap-2">
        {isAdmin && (
          <button onClick={() => { setActiveAgentId(null); clearQuote?.(); }} className="text-gray-500 hover:text-gray-900" title="Back to threads" data-testid="internal-back-btn">
            <CaretLeft size={14} weight="bold" />
          </button>
        )}
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
          Private with {headerName} · invisible to customer
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 bg-[#F7F7F5]" data-testid="internal-messages-area">
        {msgs.length === 0 && (
          <div className="text-center text-xs text-gray-400 italic py-6">No messages yet — start the conversation.</div>
        )}
        {msgs.map((m) => {
          const mine = m.from_user_id === currentUser?.id;
          return (
            <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`} data-testid={`internal-msg-${m.id}`}>
              <div className={`max-w-[85%] px-3 py-2 text-sm shadow-sm ${mine ? "bg-[#D6E4FF] border border-[#002FA7]/20" : "bg-white border border-gray-200"}`}>
                {m.quoted && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (m.quoted?.id && onJumpToWa) onJumpToWa(m.quoted.id);
                    }}
                    className="block w-full text-left mb-1 border-l-[3px] pl-2 py-1 text-[11px] bg-black/5 hover:bg-black/10 active:bg-black/15 transition-colors cursor-pointer"
                    style={{ borderColor: m.quoted.direction === "out" ? "#25D366" : "#002FA7" }}
                    title="Jump to original WA message"
                    data-testid={`internal-quoted-${m.id}`}
                  >
                    <div className="text-[9px] uppercase tracking-widest font-bold" style={{ color: m.quoted.direction === "out" ? "#128C7E" : "#002FA7" }}>
                      {m.quoted.direction === "out" ? "You (WA)" : "Customer"}
                    </div>
                    <div className="text-gray-700 truncate">{m.quoted.body || "(media)"}</div>
                  </button>
                )}
                <div className="whitespace-pre-wrap break-words">{m.body}</div>
                <div className="text-[10px] text-gray-500 font-mono mt-1 flex items-center justify-between gap-2">
                  <span>{m.from_role === "admin" ? "Admin" : "Agent"}</span>
                  <span title={fmtSmartLong(m.at)}>{fmtTime12(m.at)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {canPost ? (
        <div className="border-t border-gray-200 bg-white shrink-0">
          {quote && (
            <div className="px-3 pt-2 flex items-start gap-2" data-testid="internal-quote-preview">
              <div className="flex-1 min-w-0 border-l-[3px] pl-2 py-1 text-xs bg-black/5" style={{ borderColor: quote.direction === "out" ? "#25D366" : "#002FA7" }}>
                <div className="text-[9px] uppercase tracking-widest font-bold" style={{ color: quote.direction === "out" ? "#128C7E" : "#002FA7" }}>
                  Asking about {quote.direction === "out" ? "your message" : "customer message"}
                </div>
                <div className="text-gray-700 truncate">{quote.preview || "(media)"}</div>
              </div>
              <button onClick={clearQuote} className="text-gray-500 hover:text-gray-900 p-1" data-testid="internal-quote-cancel">
                <X size={12} />
              </button>
            </div>
          )}
          <div className="p-2 flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={isAdmin ? "Reply privately to agent…" : "Ask admin privately…"}
              rows={1}
              className="flex-1 resize-none border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#002FA7]"
              data-testid="internal-chat-input"
            />
            <button
              onClick={send}
              disabled={!draft.trim() || sending}
              className="bg-[#002FA7] hover:bg-[#002288] text-white p-2 disabled:opacity-50"
              data-testid="internal-send-btn"
            >
              <PaperPlaneRight size={16} weight="fill" />
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-[#E60000] bg-[#FFE9E9] text-[#E60000] text-xs p-3 text-center shrink-0">
          You can only use internal Q&amp;A on leads assigned to you.
        </div>
      )}
    </div>
  );
}
