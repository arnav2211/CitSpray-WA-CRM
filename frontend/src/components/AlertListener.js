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

  useEffect(() => {
    if (alerts.length > 0) startAlarm();
    else stopAlarm();
    return () => stopAlarm();
  }, [alerts, startAlarm, stopAlarm]);

  const acknowledge = async (alertId) => {
    try {
      await api.put(`/admin/alerts/${alertId}/acknowledge`);
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } catch {}
  };

  if (alerts.length === 0) return null;

  const current = alerts[0];
  const ts = current.created_at
    ? new Date(current.created_at).toLocaleString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "numeric",
        month: "short",
      })
    : "";

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in"
      data-testid="alert-popup-overlay"
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border-2 border-red-500 w-[90vw] max-w-md mx-4 overflow-hidden animate-in zoom-in-95"
        data-testid="alert-popup"
      >
        {/* Header */}
        <div className="bg-red-600 px-5 py-3 flex items-center gap-3">
          <AlertTriangle className="w-6 h-6 text-white animate-pulse" />
          <div className="flex-1">
            <p className="text-white font-bold text-lg leading-tight">
              Urgent Alert
            </p>
            <p className="text-red-100 text-xs">
              From: {current.sent_by} &middot; {ts}
            </p>
          </div>
          {alerts.length > 1 && (
            <span className="bg-white text-red-600 text-xs font-bold px-2 py-0.5 rounded-full">
              {alerts.length}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
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
        <div className="px-5 pb-5">
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
  );
}
