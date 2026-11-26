import React, { useCallback, useEffect, useRef, useState } from "react";
import { FilmStrip, Play, X, CheckCircle, XCircle } from "@phosphor-icons/react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthContext";

/* Video of the Day: a short sales-training video for the executives.
   Optional - a strip under the top bar invites them; the CRM only records how much they
   watched and their answer to the one question, for the admin's report. */

const fmtDur = (s) => {
  const t = Math.round(s || 0);
  return t ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}` : "";
};

export function VideoPlayerModal({ video, onClose, onDone, track = true }) {
  const vref = useRef(null);
  const maxPct = useRef(0);
  const secs = useRef(0);
  const lastSent = useRef(0);
  const opened = useRef(Date.now());
  const [src, setSrc] = useState(null);
  const [pct, setPct] = useState(0);
  const [answer, setAnswer] = useState(video.quiz_answer != null ? { answer: video.quiz_answer, choice: video.my_choice } : null);
  const isYt = video.source === "youtube";

  const send = useCallback((force = false) => {
    if (!track) return;
    const now = Date.now();
    if (!force && now - lastSent.current < 8000) return;
    lastSent.current = now;
    api.post(`/daily-video/${video.id}/progress`, { pct: maxPct.current, seconds: secs.current }).catch(() => {});
  }, [video.id, track]);

  useEffect(() => {
    if (isYt) return;
    api.post(`/daily-video/${video.id}/link`).then(({ data }) => setSrc(`${window.location.origin}${data.url}`))
      .catch((e) => toast.error(errMsg(e, "Could not load the video")));
  }, [video.id, isYt]);

  // YouTube: we can't read the player position, so count the time the video is open
  useEffect(() => {
    if (!isYt) return undefined;
    const dur = video.duration || 120;
    const id = setInterval(() => {
      const s = (Date.now() - opened.current) / 1000;
      secs.current = s;
      maxPct.current = Math.max(maxPct.current, Math.min(100, (s / dur) * 100));
      setPct(maxPct.current);
      send();
    }, 2000);
    return () => clearInterval(id);
  }, [isYt, video.duration, send]);

  const onTime = () => {
    const v = vref.current;
    if (!v || !v.duration) return;
    const p = (v.currentTime / v.duration) * 100;
    secs.current = Math.max(secs.current, v.currentTime);
    if (p > maxPct.current) {
      maxPct.current = p;
      setPct(p);
    }
    send();
  };

  const close = () => {
    send(true);
    onClose?.(maxPct.current);
  };

  const pick = async (i) => {
    if (answer) return;
    if (!track) { setAnswer({ choice: i, answer: video.quiz_full?.answer, correct: i === video.quiz_full?.answer }); return; }
    try {
      const { data } = await api.post(`/daily-video/${video.id}/answer`, { choice: i });
      setAnswer(data);
      onDone?.();
    } catch (e) { toast.error(errMsg(e, "Could not save the answer")); }
  };

  const showQuiz = video.quiz && (pct >= 90 || answer);
  return (
    <div className="fixed inset-0 z-[70] bg-black/90 flex flex-col items-center justify-center p-2 md:p-6" data-testid="daily-video-modal">
      <button type="button" onClick={close} className="absolute top-3 right-3 text-white/80 hover:text-white p-2" aria-label="Close">
        <X size={28} weight="bold" />
      </button>
      <div className="text-white text-sm md:text-base font-bold mb-2 px-10 text-center">{video.title}</div>
      <div className="flex flex-col md:flex-row items-center gap-4 max-h-[88vh] w-full justify-center">
        <div className="bg-black shrink-0" style={{ height: showQuiz ? "min(52vh, 720px)" : "min(80vh, 900px)", aspectRatio: "9 / 16" }}>
          {isYt ? (
            <iframe title={video.title} className="w-full h-full" allow="autoplay; encrypted-media; fullscreen" allowFullScreen
              src={`https://www.youtube-nocookie.com/embed/${video.youtube_id}?autoplay=1&playsinline=1&rel=0`} />
          ) : src ? (
            <video ref={vref} src={src} className="w-full h-full" controls autoPlay playsInline
              onTimeUpdate={onTime} onPause={() => send(true)} onEnded={() => { maxPct.current = 100; setPct(100); send(true); }} />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white/60 text-sm">Loading…</div>
          )}
        </div>
        {showQuiz && (
          <div className="bg-white w-full md:w-[380px] p-4 max-h-[34vh] md:max-h-none overflow-y-auto" data-testid="daily-video-quiz">
            <div className="text-[10px] uppercase tracking-widest font-bold text-[#7C3AED] mb-1">Aaj ka sawaal</div>
            <div className="font-bold text-sm mb-3">{video.quiz.q}</div>
            <div className="flex flex-col gap-2">
              {video.quiz.options.map((o, i) => {
                const right = answer && i === answer.answer;
                const wrongPick = answer && i === answer.choice && i !== answer.answer;
                return (
                  <button key={i} type="button" onClick={() => pick(i)} disabled={!!answer}
                    className={`text-left text-sm border px-3 py-2 flex items-start gap-2 ${right ? "border-green-600 bg-green-50" : wrongPick ? "border-[#E60000] bg-red-50" : "border-gray-300 hover:border-[#7C3AED]"}`}>
                    <span className="font-bold text-gray-500 w-4 shrink-0">{String.fromCharCode(65 + i)}</span>
                    <span className="flex-1">{o}</span>
                    {right && <CheckCircle size={18} weight="fill" className="text-green-600 shrink-0" />}
                    {wrongPick && <XCircle size={18} weight="fill" className="text-[#E60000] shrink-0" />}
                  </button>
                );
              })}
            </div>
            {answer && (
              <div className={`mt-3 text-sm font-bold ${answer.choice === answer.answer ? "text-green-700" : "text-[#E60000]"}`}>
                {answer.choice === answer.answer ? "Sahi jawab! 👏" : "Galat - sahi jawab hara wala hai."}
              </div>
            )}
          </div>
        )}
      </div>
      {video.quiz && !showQuiz && <div className="text-white/60 text-xs mt-2">Video dekhne ke baad ek chhota sawaal aayega</div>}
    </div>
  );
}

export default function DailyVideoStrip() {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const enabled = !!user && user.role === "executive";

  const load = useCallback(() => {
    if (!enabled) return;
    api.get("/daily-video/today").then(({ data }) => setD(data)).catch(() => {});
  }, [enabled]);
  useEffect(() => { load(); }, [load]);

  if (!enabled || !d?.video || hidden) return null;
  const v = d.video;
  const view = d.view || {};
  const done = view.completed && (!v.quiz || view.quiz_choice != null);
  if (done && !open) return null;
  if (view.dismissed && !open) return null;
  const video = { ...v, my_choice: view.quiz_choice };

  return (
    <>
      <div className="chat-hide shrink-0 bg-gradient-to-r from-[#4C1D95] to-[#7C3AED] text-white px-4 py-2 text-xs md:text-sm flex items-center gap-3" data-testid="daily-video-strip">
        <FilmStrip size={20} weight="fill" className="shrink-0" />
        <button type="button" onClick={() => setOpen(true)} className="flex-1 text-left min-w-0">
          <b>Aaj ka video:</b> <span className="truncate">{v.title}</span>
          <span className="opacity-75"> · {v.format_label}{v.duration ? ` · ${fmtDur(v.duration)}` : ""}{view.max_pct ? ` · ${Math.round(view.max_pct)}% dekha` : ""}</span>
        </button>
        <button type="button" onClick={() => setOpen(true)} className="bg-white text-[#4C1D95] font-bold px-3 py-1 flex items-center gap-1 shrink-0">
          <Play size={14} weight="fill" /> {view.max_pct ? "Continue" : "Watch"}
        </button>
        <button type="button" title="Hide for today" className="opacity-70 hover:opacity-100 shrink-0"
          onClick={() => { setHidden(true); api.post(`/daily-video/${v.id}/progress`, { pct: 0, dismissed: true }).catch(() => {}); }}>
          <X size={16} weight="bold" />
        </button>
      </div>
      {open && <VideoPlayerModal video={video} onClose={() => { setOpen(false); load(); }} onDone={load} />}
    </>
  );
}
