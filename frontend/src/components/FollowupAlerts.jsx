import React, { useEffect, useRef, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { Bell, BellRinging, X } from "@phosphor-icons/react";

const POLL_MS = 30 * 1000;       // check every 30s
const RING_WINDOW_S = 90;        // ring if a follow-up is due within this many seconds (past or future)
const ACK_KEY = "fu_ack_v1";

// Generate a loud, attention-grabbing tone using WebAudio.
// Plays a 4-second alternating two-tone alarm. Returns a "stop" function.
function playAlarm() {
  let stopped = false;
  let ctx;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return () => {}; }

  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.6;
  masterGain.connect(ctx.destination);

  const start = ctx.currentTime;
  const beepDur = 0.18;
  const gap = 0.12;
  const totalDur = 6; // seconds of alarm
  let t = start;
  while (t < start + totalDur && !stopped) {
    [880, 660].forEach((freq) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.9, t + 0.01);
      g.gain.linearRampToValueAtTime(0.0, t + beepDur);
      o.connect(g);
      g.connect(masterGain);
      o.start(t);
      o.stop(t + beepDur + 0.02);
      t += beepDur + gap;
    });
  }
  return () => {
    stopped = true;
    try { masterGain.disconnect(); ctx.close(); } catch { /* empty */ }
  };
}

function loadAck() {
  try { return JSON.parse(localStorage.getItem(ACK_KEY) || "{}"); } catch { return {}; }
}
function saveAck(map) { try { localStorage.setItem(ACK_KEY, JSON.stringify(map)); } catch { /* empty */ } }

export default function FollowupAlerts() {
  const { user } = useAuth();
  const [active, setActive] = useState(null); // {id, lead_id, due_at, note, lead_customer_name, lead_phone}
  const stopRingRef = useRef(null);

  const stopRing = useCallback(() => {
    if (stopRingRef.current) { try { stopRingRef.current(); } catch { /* empty */ } stopRingRef.current = null; }
  }, []);

  const dismiss = useCallback(async () => {
    if (!active) return;
    const ack = loadAck();
    ack[active.id] = Date.now();
    saveAck(ack);
    stopRing();
    setActive(null);
  }, [active, stopRing]);

  const markDone = useCallback(async () => {
    if (!active) return;
    try { await api.patch(`/followups/${active.id}`, { status: "done" }); } catch { /* empty */ }
    dismiss();
  }, [active, dismiss]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const { data } = await api.get("/followups", { params: { status: "pending" } });
        if (cancelled) return;
        const ack = loadAck();
        const now = Date.now();
        const due = (data || []).find((f) => {
          const at = new Date(f.due_at).getTime();
          if (Number.isNaN(at)) return false;
          const deltaSec = (at - now) / 1000;
          // ring once due time is within +/- window AND not already acknowledged in last 30 min
          if (deltaSec > RING_WINDOW_S) return false;
          if (ack[f.id] && (now - ack[f.id]) < 30 * 60 * 1000) return false;
          return true;
        });
        if (due && (!active || active.id !== due.id)) {
          setActive(due);
          stopRing();
          stopRingRef.current = playAlarm();
        }
      } catch { /* empty */ }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); stopRing(); };
    // eslint-disable-next-line
  }, [user]);

  if (!active) return null;
  const dueDate = new Date(active.due_at);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 animate-pulse" data-testid="followup-alert">
      <div className="bg-white border-4 border-[#E60000] w-full max-w-md p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-3">
          <div className="bg-[#E60000] p-2 text-white">
            <BellRinging size={28} weight="fill" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-widest font-bold text-[#E60000]">Follow-up due NOW</div>
            <div className="font-chivo font-black text-xl truncate">{active.lead_customer_name || "Lead"}</div>
            {active.lead_phone && <div className="text-xs text-gray-500 font-mono">{active.lead_phone}</div>}
          </div>
          <button onClick={dismiss} className="text-gray-400 hover:text-gray-900 p-2" data-testid="followup-dismiss-btn">
            <X size={20} />
          </button>
        </div>
        <div className="text-xs text-gray-700 mb-4">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Due at</div>
          <div className="font-mono">{dueDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</div>
          {active.note && (
            <>
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mt-2">Note</div>
              <div>{active.note}</div>
            </>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={markDone} className="flex-1 bg-[#008A00] hover:bg-[#006600] text-white px-3 py-3 text-[11px] uppercase tracking-widest font-bold" data-testid="followup-done-btn">
            Mark Done
          </button>
          <button onClick={dismiss} className="flex-1 border border-gray-900 hover:bg-gray-900 hover:text-white px-3 py-3 text-[11px] uppercase tracking-widest font-bold flex items-center justify-center gap-1" data-testid="followup-snooze-btn">
            <Bell size={12} weight="bold" /> Snooze 30 min
          </button>
        </div>
      </div>
    </div>
  );
}
