import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PhoneCall, ChatCircleText, X } from "@phosphor-icons/react";
import { api } from "@/lib/api";

/* While I'm on a WhatsApp call (answered on my phone), every other screen I'm signed in on -
   my PC / laptop - shows a green bar at the top with "Open chat", so the chat is right there
   for reference. When the tab is in the background a desktop notification pops up as well. */
const POLL_MS = 5000;

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export default function ActiveWaCallBar() {
  const navigate = useNavigate();
  const [call, setCall] = useState(null);
  const [hidden, setHidden] = useState(() => sessionStorage.getItem("wa_call_bar_hidden") || "");
  const [now, setNow] = useState(Date.now());
  const notified = useRef("");

  useEffect(() => {
    let stop = false;
    let t;
    const tick = async () => {
      try {
        const { data } = await api.get("/wa-calls/mine/active");
        if (!stop) setCall(data?.call || null);
      } catch { /* offline / logged out: try again next time */ }
      if (!stop) t = setTimeout(tick, document.hidden ? POLL_MS * 2 : POLL_MS);
    };
    tick();
    return () => { stop = true; clearTimeout(t); };
  }, []);

  useEffect(() => {
    if (!call) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call]);

  const openChat = () => {
    if (!call?.lead_id) return;
    if ("Notification" in window && Notification.permission === "default") {
      try { Notification.requestPermission(); } catch { /* ignore */ }
    }
    const cur = localStorage.getItem("active_company");
    if (call.company && cur && call.company !== cur) {
      localStorage.setItem("active_company", call.company);
      window.location.href = `/chat?lead=${call.lead_id}`;     // other company: reload so everything switches over
      return;
    }
    navigate(`/chat?lead=${call.lead_id}`);
  };

  // Desktop notification once per call when this tab isn't in front
  useEffect(() => {
    if (!call?.id || notified.current === call.id) return;
    notified.current = call.id;
    if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const n = new Notification(`On a WhatsApp call: ${call.name || call.from || "customer"}`, {
        body: "Click to open the chat", tag: `wa-call-${call.id}`,
      });
      n.onclick = () => { window.focus(); openChat(); n.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.id]);

  // the device that has the call shows the call's own floating bar instead
  if (!call || hidden === call.id || document.body.dataset.waCallLive) return null;
  // phone app 2.2.8+: the call runs in its own window - one tap brings it back
  const nat = window.LeadOrbitNative;
  const backToCall = nat && nat.hasCall && nat.openCall && nat.hasCall() ? () => nat.openCall() : null;
  const started = call.accepted_at ? new Date(call.accepted_at).getTime() : null;
  const secs = started ? Math.max(0, Math.round((now - started) / 1000)) : null;
  const who = call.name || call.from || "customer";

  return (
    <div className="shrink-0 z-30 bg-[#075E54] text-white px-3 md:px-6 py-2 flex items-center gap-3 shadow-md" data-testid="active-wa-call-bar">
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15">
        <span className="absolute inline-flex h-full w-full rounded-full bg-[#25D366] opacity-40 animate-ping" />
        <PhoneCall size={16} weight="fill" className="relative" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold truncate">
          On a WhatsApp call with {who}
          {call.from && call.name && call.name !== call.from && <span className="font-normal text-emerald-100"> · {call.from}</span>}
        </div>
        <div className="text-[11px] text-emerald-100">
          {call.direction === "outgoing" ? "Outgoing" : "Incoming"} · {call.status === "active" && secs !== null ? fmt(secs) : "connecting…"}
        </div>
      </div>
      {backToCall && (
        <button type="button" onClick={backToCall} data-testid="active-wa-call-back"
          className="shrink-0 flex items-center gap-1.5 bg-[#25D366] text-white font-bold text-xs uppercase tracking-wider px-3 py-2 hover:bg-[#1da851]">
          <PhoneCall size={16} weight="fill" /> Back to call
        </button>
      )}
      {call.lead_id && (
        <button type="button" onClick={openChat} data-testid="active-wa-call-open-chat"
          className="shrink-0 flex items-center gap-1.5 bg-white text-[#075E54] font-bold text-xs uppercase tracking-wider px-3 py-2 hover:bg-emerald-50">
          <ChatCircleText size={16} weight="fill" /> Open chat
        </button>
      )}
      <button type="button" onClick={() => { sessionStorage.setItem("wa_call_bar_hidden", call.id); setHidden(call.id); }}
        className="shrink-0 p-1.5 hover:bg-white/10" title="Hide for this call" aria-label="Hide">
        <X size={16} />
      </button>
    </div>
  );
}
