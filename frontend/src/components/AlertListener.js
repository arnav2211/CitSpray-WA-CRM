import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle } from "lucide-react";

export function AlertListener() {
  const [alerts, setAlerts] = useState([]);
  const audioCtxRef = useRef(null);
  const oscRef = useRef(null);
  const intervalRef = useRef(null);

  // Poll for pending alerts every 3 seconds
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const res = await api.get("/admin/alerts/pending");
        if (mounted) {
          setAlerts(res.data || []);
        }
      } catch {}
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  // Start/stop alarm sound based on alerts
  const startAlarm = useCallback(() => {
    if (oscRef.current) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = ctx;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      // Softer waveform
      osc.type = "triangle";

      // Pleasant alert base tone
      osc.frequency.value = 660;

      // Lower volume
      gain.gain.value = 0.12;

      osc.start();
      oscRef.current = osc;

      // Gentle alternating tone
      intervalRef.current = setInterval(() => {
        if (!oscRef.current) return;
        oscRef.current.frequency.value =
          oscRef.current.frequency.value === 660 ? 550 : 660;
      }, 700);
    } catch {}
  }, []);

  const stopAlarm = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (oscRef.current) {
      try {
        oscRef.current.stop();
      } catch {}
      oscRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {}
      audioCtxRef.current = null;
    }
  }, []);

  // Only urgent alerts (sent by a person, unassigned leads, COD problems) get the red pop-up and
  // the tone. Reports, attendance, leave requests ... are small cards without sound.
  const isUrgent = (a) => a?.urgent !== false && !(a?.meta?.silent || a?.meta?.type === "ai_promise_missed");
  const urgent = alerts.filter(isUrgent);
  const quiet = alerts.filter((a) => !isUrgent(a));
  const loud = urgent.length > 0;
  useEffect(() => {
    if (loud) startAlarm();
    else stopAlarm();
    return () => stopAlarm();
  }, [loud, startAlarm, stopAlarm]);

  const acknowledge = async (alertId) => {
    try {
      await api.put(`/admin/alerts/${alertId}/acknowledge`);
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } catch {}
  };

  const acknowledgeAll = async (list) => {
    for (const a of list) {
      try { await api.put(`/admin/alerts/${a.id}/acknowledge`); } catch {}
    }
    const ids = new Set(list.map((a) => a.id));
    setAlerts((prev) => prev.filter((a) => !ids.has(a.id)));
  };

  if (alerts.length === 0) return null;

  const quietCards = quiet.length > 0 && (
    <div className="fixed top-2 inset-x-2 md:inset-x-auto md:right-4 md:top-4 md:w-96 z-[9998] space-y-2" data-testid="alert-cards">
      {quiet.slice(0, 3).map((a) => (
        <div key={a.id} className="bg-white dark:bg-zinc-900 border border-gray-200 border-l-4 border-l-[#002FA7] shadow-lg rounded-md px-3 py-2 flex gap-2 items-start" data-testid="alert-card">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-gray-900 dark:text-white">{a.title}</div>
            <div className="text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap line-clamp-4">{a.message}</div>
          </div>
          <button onClick={() => acknowledge(a.id)} className="text-xs font-bold text-[#002FA7] px-2 py-1 hover:bg-gray-100 rounded shrink-0" data-testid="alert-card-ok">OK</button>
        </div>
      ))}
      {quiet.length > 1 && (
        <button onClick={() => acknowledgeAll(quiet)} className="w-full text-[11px] font-bold uppercase tracking-widest bg-white/95 border border-gray-200 shadow rounded-md py-1.5 text-gray-700 hover:bg-gray-50" data-testid="alert-cards-clear">
          {quiet.length > 3 ? `+${quiet.length - 3} more · ` : ""}Clear all {quiet.length}
        </button>
      )}
    </div>
  );
  if (urgent.length === 0) return quietCards;

  const current = urgent[0];
  const ts = current.created_at
    ? new Date(current.created_at).toLocaleString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "numeric",
        month: "short",
      })
    : "";

  return (
    <>
    {quietCards}
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in p-3"
      data-testid="alert-popup-overlay"
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border-2 border-red-500 w-full max-w-md overflow-hidden animate-in zoom-in-95 flex flex-col"
        style={{ maxHeight: "calc(100dvh - 1.5rem)" }}
        data-testid="alert-popup"
      >
        {/* Header */}
        <div className="bg-red-600 px-5 py-3 flex items-center gap-3 shrink-0">
          <AlertTriangle className="w-6 h-6 text-white animate-pulse" />
          <div className="flex-1">
            <p className="text-white font-bold text-lg leading-tight">
              Urgent Alert
            </p>
            <p className="text-red-100 text-xs">
              From: {current.sent_by} &middot; {ts}
            </p>
          </div>
          {urgent.length > 1 && (
            <span className="bg-white text-red-600 text-xs font-bold px-2 py-0.5 rounded-full">
              {urgent.length}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3 overflow-y-auto min-h-0 flex-1">
          <h3 className="font-bold text-lg text-gray-900 dark:text-white" data-testid="alert-title">
            {current.title}
          </h3>
          <p
            className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap"
            data-testid="alert-message"
          >
            {current.message}
          </p>
          {current.order_id && (
            <div className="text-xs bg-gray-100 dark:bg-zinc-800 rounded-lg p-2 space-y-0.5">
              {current.order_id && (
                <p>
                  <span className="font-medium text-gray-700 dark:text-gray-300">Order:</span> {current.order_id}
                </p>
              )}
              {current.customer_name && (
                <p>
                  <span className="font-medium text-gray-700 dark:text-gray-300">Customer:</span> {current.customer_name}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Action */}
        <div className="px-5 pb-5 pt-3 shrink-0 border-t border-gray-100" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}>
          <Button
            className="w-full bg-red-600 hover:bg-red-700 text-white h-12 text-base font-bold"
            onClick={() => acknowledge(current.id)}
            data-testid="alert-acknowledge-btn"
          >
            <CheckCircle className="w-5 h-5 mr-2" /> Acknowledge
          </Button>
        </div>
      </div>
    </div>
    </>
  );
}
