import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Phone, PhoneOff, Mic, MicOff, Volume2, Ear, MessageCircle } from "lucide-react";
import { api, errMsg } from "@/lib/api";

/**
 * Incoming WhatsApp call (Cloud API Calling) answered inside the LeadOrbit app.
 * Meta sends the caller's WebRTC offer; this page builds the answer, the server
 * accepts it with Meta, and the voice flows browser <-> WhatsApp directly.
 * The conversation is recorded here and uploaded for the usual AI call summary.
 * Incoming only: there is no way to place a WhatsApp call from the CRM.
 */
const native = () => (typeof window !== "undefined" ? window.LeadOrbitNative : null);

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function WaCall({ outgoing = false }) {
  const { id: routeId, leadId } = useParams();
  const [params] = useSearchParams();
  const [id, setId] = useState(outgoing ? null : routeId);
  const [call, setCall] = useState(null);
  const [phase, setPhase] = useState("loading"); // loading | ringing | connecting | active | ended | gone | error
  const [note, setNote] = useState("");
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const pcRef = useRef(null);
  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const audioRef = useRef(null);
  const recRef = useRef({ recorder: null, chunks: [], ctx: null });
  const acceptedAtRef = useRef(null);
  const startedMsRef = useRef(0);
  const phaseRef = useRef(phase);
  const autoTried = useRef(false);
  phaseRef.current = phase;

  const load = useCallback(async () => {
    if (!id) return null;
    try {
      const { data } = await api.get(`/wa-calls/${id}`);
      setCall(data);
      return data;
    } catch (e) {
      setPhase("error");
      setNote(errMsg(e, "Call not found"));
      return null;
    }
  }, [id]);

  const uploadRecording = useCallback(async (blob, seconds, c) => {
    if (!blob || blob.size < 2000 || !acceptedAtRef.current || !c?.from) return;
    const fd = new FormData();
    fd.append("phone", c.from);
    fd.append("timestamp", acceptedAtRef.current);
    fd.append("duration_seconds", String(Math.round(seconds)));
    fd.append("direction", outgoing ? "outgoing" : "incoming");
    fd.append("source", "whatsapp");
    fd.append("file", blob, "whatsapp-call.webm");
    try {
      await api.post("/calls/recording", fd);
    } catch (e) {
      /* the call itself is already logged; the summary is best-effort */
    }
  }, [outgoing]);

  const cleanup = useCallback((reason) => {
    if (phaseRef.current === "ended" || phaseRef.current === "gone") return;
    const seconds = startedMsRef.current ? (Date.now() - startedMsRef.current) / 1000 : 0;
    const r = recRef.current;
    const c = call;
    if (r.recorder && r.recorder.state !== "inactive") {
      r.recorder.onstop = () => {
        const blob = new Blob(r.chunks, { type: "audio/webm" });
        uploadRecording(blob, seconds, c);
        try { r.ctx && r.ctx.close(); } catch (e) { /* ignore */ }
      };
      try { r.recorder.stop(); } catch (e) { /* ignore */ }
    }
    try { pcRef.current && pcRef.current.close(); } catch (e) { /* ignore */ }
    try { localRef.current && localRef.current.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    pcRef.current = null;
    try { native()?.callState("ended", ""); } catch (e) { /* ignore */ }
    setPhase(startedMsRef.current ? "ended" : "gone");
    if (reason) setNote(reason);
  }, [call, uploadRecording]);

  const startRecording = (local, remote) => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(local).connect(dest);
      ctx.createMediaStreamSource(remote).connect(dest);
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      const recorder = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      recRef.current = { recorder, chunks: [], ctx };
      recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) recRef.current.chunks.push(ev.data); };
      recorder.start(5000);
    } catch (e) {
      /* recording is optional */
    }
  };

  const answer = useCallback(async () => {
    if (phaseRef.current !== "ringing") return;
    const c = call;
    if (!c?.offer_sdp) return;
    setPhase("connecting");
    setNote("Connecting…");
    try {
      const local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localRef.current = local;
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pcRef.current = pc;
      local.getTracks().forEach((t) => pc.addTrack(t, local));
      const remote = new MediaStream();
      pc.ontrack = (ev) => {
        ev.streams[0] ? ev.streams[0].getTracks().forEach((t) => remote.addTrack(t)) : remote.addTrack(ev.track);
        if (audioRef.current) {
          audioRef.current.srcObject = remote;
          audioRef.current.play().catch(() => {});
        }
      };
      pc.onconnectionstatechange = () => {
        if (["failed", "closed"].includes(pc.connectionState) && phaseRef.current === "active") {
          api.post(`/wa-calls/${id}/hangup`).catch(() => {});
          cleanup("Connection lost");
        }
      };
      await pc.setRemoteDescription({ type: "offer", sdp: c.offer_sdp });
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const t = setTimeout(resolve, 2500);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
        };
      });
      const { data } = await api.post(`/wa-calls/${id}/accept`, { sdp: pc.localDescription.sdp });
      acceptedAtRef.current = data.accepted_at;
      startedMsRef.current = Date.now();
      setPhase("active");
      setNote("");
      try { native()?.callState("active", c.name || c.from || ""); } catch (e) { /* ignore */ }
      try { native()?.setSpeaker(false); } catch (e) { /* ignore */ }
      startRecording(local, remote);
    } catch (e) {
      try { pcRef.current && pcRef.current.close(); } catch (er) { /* ignore */ }
      try { localRef.current && localRef.current.getTracks().forEach((t) => t.stop()); } catch (er) { /* ignore */ }
      const msg = e?.name === "NotAllowedError" ? "Microphone permission is off for LeadOrbit" : errMsg(e, "Could not answer");
      setPhase("gone");
      setNote(msg);
      try { native()?.callState("ended", ""); } catch (er) { /* ignore */ }
    }
  }, [call, id, cleanup]);

  // OUTGOING (admin-approved): our offer -> Meta rings the customer -> their answer arrives by webhook
  const dial = useCallback(async () => {
    setPhase("connecting");
    setNote("Calling…");
    try {
      const { data: lead } = await api.get(`/leads/${leadId}`);
      const base = { name: lead.customer_name, from: lead.active_wa_phone || lead.phone, lead_id: leadId, company: lead.company };
      setCall(base);
      const local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localRef.current = local;
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pcRef.current = pc;
      local.getTracks().forEach((t) => pc.addTrack(t, local));
      const remote = new MediaStream();
      remoteRef.current = remote;
      pc.ontrack = (ev) => {
        ev.streams[0] ? ev.streams[0].getTracks().forEach((t) => remote.addTrack(t)) : remote.addTrack(ev.track);
        if (audioRef.current) {
          audioRef.current.srcObject = remote;
          audioRef.current.play().catch(() => {});
        }
      };
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const t = setTimeout(resolve, 2500);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
        };
      });
      const { data } = await api.post("/wa-calls/outgoing", { lead_id: leadId, sdp: pc.localDescription.sdp });
      setId(data.call_id);
      try { native()?.callState("active", base.name || base.from || ""); } catch (e) { /* ignore */ }
      try { native()?.setSpeaker(false); } catch (e) { /* ignore */ }
    } catch (e) {
      try { pcRef.current && pcRef.current.close(); } catch (er) { /* ignore */ }
      try { localRef.current && localRef.current.getTracks().forEach((t) => t.stop()); } catch (er) { /* ignore */ }
      const d = e?.response?.data?.detail;
      const msg = e?.name === "NotAllowedError" ? "Microphone permission is off for LeadOrbit"
        : d === "no_permission" ? "The customer has not allowed WhatsApp calls yet. Go back and tap \"Ask customer to allow calls\"."
        : errMsg(e, "Could not call");
      setPhase("gone");
      setNote(msg);
      try { native()?.callState("ended", ""); } catch (er) { /* ignore */ }
    }
  }, [leadId]);

  const hangup = useCallback(() => {
    if (id) api.post(`/wa-calls/${id}/hangup`).catch(() => {});
    cleanup("Call ended");
  }, [id, cleanup]);

  const decline = useCallback(async () => {
    await api.post(`/wa-calls/${id}/decline`).catch(() => {});
    setPhase("gone");
    setNote("Declined");
  }, [id]);

  // first load
  useEffect(() => {
    if (outgoing) {
      if (!autoTried.current) { autoTried.current = true; dial(); }
      return;
    }
    (async () => {
      const c = await load();
      if (!c) return;
      if (c.status === "ringing") setPhase("ringing");
      else {
        setPhase("gone");
        setNote(c.status === "active" || c.status === "answering"
          ? `Answered by ${c.answered_by_name || "someone else"}`
          : "This call has ended");
      }
    })();
  }, [load, outgoing, dial]);

  // auto-answer when the app opened this page from the "Answer" button
  useEffect(() => {
    if (!outgoing && phase === "ringing" && params.get("answer") === "1" && !autoTried.current) {
      autoTried.current = true;
      answer();
    }
  }, [phase, params, answer, outgoing]);

  // follow the call's status (caller hung up, someone else answered, …)
  useEffect(() => {
    if (!id || !["ringing", "connecting", "active"].includes(phase)) return undefined;
    const t = setInterval(async () => {
      try {
        const { data } = await api.get(`/wa-calls/${id}`);
        if (outgoing && phaseRef.current === "connecting") {
          if (data.status === "ringing_remote") setNote("Ringing…");
          if (data.status === "active" && data.answer_sdp && pcRef.current && !pcRef.current.remoteDescription) {
            await pcRef.current.setRemoteDescription({ type: "answer", sdp: data.answer_sdp });
            acceptedAtRef.current = data.accepted_at;
            startedMsRef.current = Date.now();
            setPhase("active");
            setNote("");
            startRecording(localRef.current, remoteRef.current);
            return;
          }
          if (data.status === "rejected") { cleanup("Customer declined the call"); return; }
          if (data.status === "ended" || data.status === "failed") { cleanup("Not answered"); return; }
          return;
        }
        if (data.status === "ended" || data.status === "rejected" || data.status === "failed") {
          if (phaseRef.current === "ringing") { setPhase("gone"); setNote("Caller hung up"); }
          else cleanup("Call ended");
        } else if (phaseRef.current === "ringing" && data.status !== "ringing") {
          setPhase("gone");
          setNote(`Answered by ${data.answered_by_name || "someone else"}`);
        }
      } catch (e) { /* keep trying */ }
    }, outgoing ? 700 : 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, id, cleanup, outgoing]);

  // timer
  useEffect(() => {
    if (phase !== "active") return undefined;
    const t = setInterval(() => setElapsed((Date.now() - startedMsRef.current) / 1000), 500);
    return () => clearInterval(t);
  }, [phase]);

  // hang-up button on the app's "call in progress" notification
  useEffect(() => {
    window.__waCallHangup = () => hangup();
    return () => { delete window.__waCallHangup; };
  }, [hangup]);

  // leaving the page ends the call
  useEffect(() => () => {
    if (id && (phaseRef.current === "active" || phaseRef.current === "connecting")) {
      api.post(`/wa-calls/${id}/hangup`).catch(() => {});
    }
  }, [id]);

  const toggleMute = () => {
    const next = !muted;
    (localRef.current?.getAudioTracks() || []).forEach((t) => { t.enabled = !next; });
    setMuted(next);
  };
  const toggleSpeaker = () => {
    const next = !speaker;
    try { native()?.setSpeaker(next); } catch (e) { /* ignore */ }
    setSpeaker(next);
  };
  const openChat = () => {
    if (!call?.lead_id) return;
    if (call.company) localStorage.setItem("active_company", call.company);
    window.location.href = `/chat?lead=${call.lead_id}`;
  };

  const name = call?.name || call?.from || "WhatsApp caller";
  const btn = "h-16 w-16 rounded-full flex items-center justify-center shadow-lg active:scale-95 transition";

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-between bg-gradient-to-b from-[#075E54] to-[#04332d] text-white px-6 py-10" data-testid="wa-call-page">
      <audio ref={audioRef} autoPlay playsInline />
      <div className="flex flex-col items-center gap-3 mt-6 text-center">
        <div className="text-xs uppercase tracking-[0.25em] text-emerald-200">
          {outgoing ? "Outgoing " : ""}WhatsApp call{call?.company ? ` · ${call.company === "fragvansh" ? "Fragvansh" : "CitSpray"}` : ""}
        </div>
        <div className="h-24 w-24 rounded-full bg-white/15 flex items-center justify-center text-4xl font-semibold">
          {(name || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "W"}
        </div>
        <div className="text-2xl font-semibold break-words max-w-[90vw]">{name}</div>
        {call?.from && call.name && call.name !== call.from && <div className="text-sm text-emerald-100">{call.from}</div>}
        <div className="text-sm text-emerald-100 mt-1">
          {phase === "ringing" && "Incoming call…"}
          {phase === "connecting" && (note || "Connecting…")}
          {phase === "active" && fmt(elapsed)}
          {(phase === "ended" || phase === "gone" || phase === "error") && (note || "Call ended")}
          {phase === "loading" && "Loading…"}
        </div>
      </div>

      {phase === "ringing" && (
        <div className="flex w-full max-w-xs justify-between mb-8">
          <div className="flex flex-col items-center gap-2">
            <button type="button" onClick={decline} className={`${btn} bg-red-500`} aria-label="Decline"><PhoneOff className="h-7 w-7" /></button>
            <span className="text-xs">Decline</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <button type="button" onClick={answer} className={`${btn} bg-emerald-500 animate-pulse`} aria-label="Answer" data-testid="wa-call-answer"><Phone className="h-7 w-7" /></button>
            <span className="text-xs">Answer</span>
          </div>
        </div>
      )}

      {(phase === "active" || phase === "connecting") && (
        <div className="flex flex-col items-center gap-8 mb-8">
          <div className="flex gap-8">
            <div className="flex flex-col items-center gap-2">
              <button type="button" onClick={toggleMute} className={`${btn} ${muted ? "bg-white text-[#075E54]" : "bg-white/15"}`} aria-label="Mute">
                {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
              </button>
              <span className="text-xs">{muted ? "Muted" : "Mute"}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <button type="button" onClick={toggleSpeaker} className={`${btn} ${speaker ? "bg-white text-[#075E54]" : "bg-white/15"}`} aria-label="Speaker">
                {speaker ? <Volume2 className="h-6 w-6" /> : <Ear className="h-6 w-6" />}
              </button>
              <span className="text-xs">{speaker ? "Speaker" : "Earpiece"}</span>
            </div>
          </div>
          <button type="button" onClick={hangup} className={`${btn} bg-red-500`} aria-label="Hang up" data-testid="wa-call-hangup"><PhoneOff className="h-7 w-7" /></button>
        </div>
      )}

      {(phase === "ended" || phase === "gone" || phase === "error") && (
        <div className="flex flex-col items-center gap-3 mb-8 w-full max-w-xs">
          {phase === "ended" && <div className="text-xs text-emerald-100 text-center">The call is saved on the lead. The AI summary appears in a minute or two.</div>}
          {call?.lead_id && (
            <button type="button" onClick={openChat} className="w-full rounded-full bg-white text-[#075E54] font-medium py-3 flex items-center justify-center gap-2">
              <MessageCircle className="h-5 w-5" /> Open chat
            </button>
          )}
          <button type="button" onClick={() => { window.location.href = "/chat"; }} className="w-full rounded-full bg-white/15 py-3">Close</button>
        </div>
      )}
    </div>
  );
}
