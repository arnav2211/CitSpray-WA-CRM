import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Phone, PhoneOff, Mic, MicOff, Volume2, Ear, MessageCircle } from "lucide-react";
import { api, errMsg } from "@/lib/api";

/**
 * WhatsApp call (Cloud API Calling) inside the LeadOrbit app.
 * Incoming: Meta sends the caller's WebRTC offer; this page answers it.
 * Outgoing (admin-approved): we send an offer; Meta returns the answer at once (media
 * path ready) but the customer has only ANSWERED when the ACCEPTED status arrives -
 * until then the screen says "Ringing…" with a ringback tone and no timer.
 * Audio plays on the loudspeaker by default (Earpiece button to switch); if the phone
 * blocks playback a big "Tap to hear" button appears. Every call reports what audio was
 * sent / received (diagnostics) so problems can be checked afterwards.
 * The conversation is recorded here and uploaded for the usual AI call summary.
 */
const native = () => (typeof window !== "undefined" ? window.LeadOrbitNative : null);

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Indian ringback: 400 Hz, 0.4 s on / 0.2 s off / 0.4 s on / 2 s off
function makeRingback() {
  let ctx = null;
  let timer = null;
  const beep = (at, len) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 400;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
    g.gain.setValueAtTime(0.18, at + len - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(g).connect(ctx.destination);
    o.start(at);
    o.stop(at + len + 0.02);
  };
  return {
    start() {
      if (timer) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        ctx = ctx || new Ctx();
        ctx.resume?.();
        const cycle = () => { const t = ctx.currentTime + 0.05; beep(t, 0.4); beep(t + 0.6, 0.4); };
        cycle();
        timer = setInterval(cycle, 3000);
      } catch (e) { /* no tone - not critical */ }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      try { ctx && ctx.close(); } catch (e) { /* ignore */ }
      ctx = null;
    },
  };
}

export default function WaCall({ outgoing = false }) {
  const { id: routeId, leadId } = useParams();
  const [params] = useSearchParams();
  const [id, setId] = useState(outgoing ? null : routeId);
  const [call, setCall] = useState(null);
  const [phase, setPhase] = useState("loading"); // loading | ringing | connecting | active | ended | gone | error
  const [note, setNote] = useState("");
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(true);
  const [needTap, setNeedTap] = useState(false);
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
  const ringbackRef = useRef(null);
  const diagRef = useRef({ playErrors: [], events: [] });
  const idRef = useRef(id);
  phaseRef.current = phase;
  idRef.current = id;

  const diagEvent = (e) => { diagRef.current.events.push(`${new Date().toISOString().slice(11, 19)} ${e}`); };

  const playRemote = useCallback(() => {
    const el = audioRef.current;
    if (!el || !remoteRef.current) return;
    if (el.srcObject !== remoteRef.current) el.srcObject = remoteRef.current;
    el.muted = false;
    el.volume = 1;
    const p = el.play();
    if (p && p.then) {
      p.then(() => setNeedTap(false)).catch((err) => {
        diagRef.current.playErrors.push(String(err?.name || err));
        setNeedTap(true);
      });
    }
  }, []);

  // what audio actually flowed - sent to the server for checking problems later
  const collectStats = useCallback(async () => {
    const pc = pcRef.current;
    const out = {
      at: new Date().toISOString(), phase: phaseRef.current, speaker, muted,
      audio_paused: audioRef.current ? audioRef.current.paused : null,
      play_errors: diagRef.current.playErrors.slice(-3), events: diagRef.current.events.slice(-12),
      ua: navigator.userAgent.slice(0, 160),
    };
    if (pc) {
      out.connection = pc.connectionState;
      out.ice = pc.iceConnectionState;
      try {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type === "inbound-rtp" && (r.kind === "audio" || r.mediaType === "audio")) {
            out.in_bytes = r.bytesReceived; out.in_packets = r.packetsReceived; out.in_lost = r.packetsLost;
            out.in_energy = r.totalAudioEnergy; out.in_level = r.audioLevel;
          }
          if (r.type === "outbound-rtp" && (r.kind === "audio" || r.mediaType === "audio")) {
            out.out_bytes = r.bytesSent; out.out_packets = r.packetsSent;
          }
          if (r.type === "media-source" && r.kind === "audio") { out.mic_energy = r.totalAudioEnergy; out.mic_level = r.audioLevel; }
          if (r.type === "candidate-pair" && r.nominated) { out.pair_state = r.state; out.rtt = r.currentRoundTripTime; }
        });
      } catch (e) { out.stats_error = String(e); }
    }
    return out;
  }, [speaker, muted]);

  const sendDiag = useCallback(async (label) => {
    const cid = idRef.current;
    if (!cid) return;
    try {
      const d = await collectStats();
      d.label = label;
      await api.post(`/wa-calls/${cid}/diag`, d);
    } catch (e) { /* diagnostics are best-effort */ }
  }, [collectStats]);

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
    ringbackRef.current?.stop();
    diagEvent(`end: ${reason || ""}`);
    sendDiag("end");
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
    setTimeout(() => {
      try { pcRef.current && pcRef.current.close(); } catch (e) { /* ignore */ }
      pcRef.current = null;
    }, 400);   // let the final diagnostics read the stats first
    try { localRef.current && localRef.current.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { native()?.callState("ended", ""); } catch (e) { /* ignore */ }
    setPhase(startedMsRef.current ? "ended" : "gone");
    setNeedTap(false);
    if (reason) setNote(reason);
  }, [call, uploadRecording, sendDiag]);

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

  const newPeer = (local) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pcRef.current = pc;
    local.getTracks().forEach((t) => pc.addTrack(t, local));
    const remote = new MediaStream();
    remoteRef.current = remote;
    pc.ontrack = (ev) => {
      ev.streams[0] ? ev.streams[0].getTracks().forEach((t) => remote.addTrack(t)) : remote.addTrack(ev.track);
      diagEvent("remote track");
      playRemote();
    };
    pc.onconnectionstatechange = () => {
      diagEvent(`connection ${pc.connectionState}`);
      if (pc.connectionState === "connected") playRemote();
      if (["failed", "closed"].includes(pc.connectionState) && phaseRef.current === "active") {
        if (idRef.current) api.post(`/wa-calls/${idRef.current}/hangup`).catch(() => {});
        cleanup("Connection lost");
      }
    };
    return pc;
  };

  const gatherIce = (pc) => new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const t = setTimeout(resolve, 2500);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
    };
  });

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
      const pc = newPeer(local);
      await pc.setRemoteDescription({ type: "offer", sdp: c.offer_sdp });
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await gatherIce(pc);
      const { data } = await api.post(`/wa-calls/${id}/accept`, { sdp: pc.localDescription.sdp });
      acceptedAtRef.current = data.accepted_at;
      startedMsRef.current = Date.now();
      setPhase("active");
      setNote("");
      diagEvent("answered");
      try { native()?.callState("active", c.name || c.from || ""); } catch (e) { /* ignore */ }
      try { native()?.setSpeaker(true); } catch (e) { /* ignore */ }
      playRemote();
      startRecording(local, remoteRef.current);
      setTimeout(() => sendDiag("8s"), 8000);
    } catch (e) {
      try { pcRef.current && pcRef.current.close(); } catch (er) { /* ignore */ }
      try { localRef.current && localRef.current.getTracks().forEach((t) => t.stop()); } catch (er) { /* ignore */ }
      const msg = e?.name === "NotAllowedError" ? "Microphone permission is off for LeadOrbit" : errMsg(e, "Could not answer");
      setPhase("gone");
      setNote(msg);
      try { native()?.callState("ended", ""); } catch (er) { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const pc = newPeer(local);
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await gatherIce(pc);
      const { data } = await api.post("/wa-calls/outgoing", { lead_id: leadId, sdp: pc.localDescription.sdp });
      setId(data.call_id);
      idRef.current = data.call_id;
      diagEvent("dialled");
      setNote("Ringing…");
      if (!ringbackRef.current) ringbackRef.current = makeRingback();
      ringbackRef.current.start();
      try { native()?.callState("active", base.name || base.from || ""); } catch (e) { /* ignore */ }
    } catch (e) {
      ringbackRef.current?.stop();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // follow the call's status (caller hung up, someone else answered, customer picked up, …)
  useEffect(() => {
    if (!id || !["ringing", "connecting", "active"].includes(phase)) return undefined;
    const t = setInterval(async () => {
      try {
        const { data } = await api.get(`/wa-calls/${id}`);
        if (outgoing && phaseRef.current === "connecting") {
          // Meta's answer = the media path; apply it at once so audio flows the moment they pick up
          if (data.answer_sdp && pcRef.current && !pcRef.current.remoteDescription) {
            await pcRef.current.setRemoteDescription({ type: "answer", sdp: data.answer_sdp });
            diagEvent("answer sdp applied");
          }
          // fallback if Meta's ACCEPTED is late: the customer's voice is actually arriving
          let voice = false;
          if (pcRef.current && pcRef.current.remoteDescription && data.status !== "active") {
            try {
              const st = await pcRef.current.getStats();
              st.forEach((r) => {
                if (r.type === "inbound-rtp" && (r.kind === "audio" || r.mediaType === "audio") && (r.totalAudioEnergy || 0) > 0.02) voice = true;
              });
            } catch (e) { /* ignore */ }
            if (voice) {
              diagEvent("voice detected before ACCEPTED");
              api.post(`/wa-calls/${id}/client-answered`).catch(() => {});
            }
          }
          if (data.status === "active" || voice) {  // ACCEPTED (or their voice): the customer really answered
            ringbackRef.current?.stop();
            acceptedAtRef.current = data.accepted_at || new Date().toISOString();
            startedMsRef.current = Date.now();
            setPhase("active");
            setNote("");
            diagEvent("customer answered");
            try { native()?.setSpeaker(true); } catch (e) { /* ignore */ }
            playRemote();
            startRecording(localRef.current, remoteRef.current);
            setTimeout(() => sendDiag("8s"), 8000);
            return;
          }
          if (data.status === "rejected") { cleanup("Customer declined the call"); return; }
          if (data.status === "ended" || data.status === "failed") { cleanup("Not answered"); return; }
          return;
        }
        // the server's answer time (matches the call log, so the recording's AI summary attaches to it)
        if (data.accepted_at) acceptedAtRef.current = data.accepted_at;
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

  // timer + make sure the customer's audio keeps playing
  useEffect(() => {
    if (phase !== "active") return undefined;
    const t = setInterval(() => {
      setElapsed((Date.now() - startedMsRef.current) / 1000);
      if (audioRef.current && remoteRef.current && audioRef.current.paused) playRemote();
    }, 1000);
    return () => clearInterval(t);
  }, [phase, playRemote]);

  // hang-up button on the app's "call in progress" notification
  useEffect(() => {
    window.__waCallHangup = () => hangup();
    return () => { delete window.__waCallHangup; };
  }, [hangup]);

  // leaving the page ends the call
  useEffect(() => () => {
    ringbackRef.current?.stop();
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
    diagEvent(next ? "speaker on" : "earpiece on");
    setSpeaker(next);
    playRemote();
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
        {needTap && phase === "active" && (
          <button type="button" onClick={playRemote} data-testid="wa-call-tap-to-hear"
            className="mt-4 rounded-full bg-yellow-400 text-black font-bold px-6 py-3 shadow-lg animate-pulse">
            🔊 Tap to hear the customer
          </button>
        )}
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
