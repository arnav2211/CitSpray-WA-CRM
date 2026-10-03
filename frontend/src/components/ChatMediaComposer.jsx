import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  X, PaperPlaneRight, Plus, FileText, Microphone, Camera, VideoCamera, ArrowsClockwise, Stop,
} from "@phosphor-icons/react";

/* WhatsApp-style media sending for /chat:
   - MediaPreviewModal: preview every picked / pasted / dropped / captured file,
     write a caption under each (images, videos, documents), add or remove files,
     then send them all.
   - CameraModal: take a photo or record a video straight from the camera.
     Photos are compressed in the browser before upload. */

export const CAPTION_MAX = 1024;                 // WhatsApp's caption limit
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;         // WhatsApp image limit
const VIDEO_MAX_BYTES = 16 * 1024 * 1024;        // WhatsApp video limit
const VIDEO_MAX_SECONDS = 90;                    // keeps a camera clip under 16 MB

let _seq = 0;

export function kindForFile(file) {
  const t = (file?.type || "").toLowerCase();
  if (t.startsWith("image/")) return t.includes("svg") ? "document" : "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  return "document";
}

function fmtSize(b) {
  if (!b && b !== 0) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/* Downscale + re-encode an image as JPEG. Returns the original file when the
   result would not be smaller (or the browser can't decode it). */
export async function compressImage(file, { maxDim = 1600, quality = 0.8 } = {}) {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";                 // transparent PNGs get a white background, not black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;
    const base = (file.name || "photo").replace(/\.[^.]+$/, "");
    return new File([blob], `${base}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    return file;
  }
}

/* Turn raw files into preview items. Images over WhatsApp's 5 MB limit are
   compressed so they can actually be delivered; camera photos come in already
   compressed. */
export async function makeMediaItems(files, { compressAllImages = false, forceKind = null } = {}) {
  const out = [];
  for (const f of files) {
    if (!f) continue;
    let file = f;
    // "Document" in the attach menu sends any file (even a photo) as a document,
    // uncompressed - same as before.
    const kind = forceKind || kindForFile(f);
    if (kind === "image" && (compressAllImages || f.size > IMAGE_MAX_BYTES)) {
      file = await compressImage(f);
    }
    out.push({ id: `m${Date.now()}_${_seq++}`, file, kind, url: URL.createObjectURL(file), caption: "" });
  }
  return out;
}

export function releaseMediaItems(items) {
  (items || []).forEach((it) => { try { URL.revokeObjectURL(it.url); } catch { /* ignore */ } });
}

function warningFor(it) {
  if (it.kind === "video" && it.file.size > VIDEO_MAX_BYTES && /mp4|3gpp/.test(it.file.type)) {
    return "Over WhatsApp's 16 MB video limit, so it may not deliver. Trim it or send as a document.";
  }
  if (it.kind === "image" && it.file.size > IMAGE_MAX_BYTES) return "Over WhatsApp's 5 MB image limit.";
  if (it.file.size > 50 * 1024 * 1024) return "Too large (max 50 MB).";
  return "";
}

function PreviewBody({ it }) {
  if (it.kind === "image") {
    return <img src={it.url} alt="" className="max-h-full max-w-full object-contain" data-testid="media-preview-image" />;
  }
  if (it.kind === "video") {
    return <video src={it.url} controls className="max-h-full max-w-full" data-testid="media-preview-video" />;
  }
  if (it.kind === "audio") {
    return (
      <div className="flex flex-col items-center gap-3 text-white">
        <Microphone size={56} weight="light" />
        <div className="text-sm break-all text-center px-4">{it.file.name}</div>
        <audio src={it.url} controls />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 text-white" data-testid="media-preview-document">
      <FileText size={72} weight="light" />
      <div className="text-sm break-all text-center px-4 max-w-md">{it.file.name}</div>
      <div className="text-xs text-white/60">{fmtSize(it.file.size)}</div>
    </div>
  );
}

function Thumb({ it, active, onClick, onRemove, disabled }) {
  return (
    <div className={`relative shrink-0 w-14 h-14 rounded-md overflow-hidden border-2 ${active ? "border-[#25D366]" : "border-transparent"} bg-white/10`}>
      <button type="button" onClick={onClick} className="w-full h-full flex items-center justify-center text-white" title={it.file.name}>
        {it.kind === "image" ? <img src={it.url} alt="" className="w-full h-full object-cover" />
          : it.kind === "video" ? <VideoCamera size={22} />
          : it.kind === "audio" ? <Microphone size={22} />
          : <FileText size={22} />}
      </button>
      {!disabled && (
        <button type="button" onClick={onRemove} title="Remove"
          className="absolute top-0 right-0 bg-black/70 text-white rounded-bl p-0.5" data-testid={`media-thumb-remove-${it.id}`}>
          <X size={10} weight="bold" />
        </button>
      )}
    </div>
  );
}

export function MediaPreviewModal({ items, setItems, onClose, onSend, sending, customerName }) {
  const [activeId, setActiveId] = useState(items[0]?.id);
  const addRef = useRef(null);
  const captionRef = useRef(null);
  const active = items.find((i) => i.id === activeId) || items[0];

  useEffect(() => {
    if (!items.find((i) => i.id === activeId) && items[0]) setActiveId(items[0].id);
  }, [items, activeId]);
  useEffect(() => { captionRef.current?.focus(); }, [activeId]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !sending) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  if (!active) return null;

  const setCaption = (v) => setItems((list) => list.map((i) => (i.id === active.id ? { ...i, caption: v } : i)));
  const remove = (id) => {
    const rest = items.filter((i) => i.id !== id);
    if (!rest.length) { onClose(); return; }      // parent releases everything on close
    const gone = items.find((i) => i.id === id);
    if (gone) releaseMediaItems([gone]);
    setItems(rest);
  };
  const addFiles = async (files) => {
    if (!files?.length) return;
    const more = await makeMediaItems(files);
    setItems((list) => [...list, ...more]);
    if (more[0]) setActiveId(more[0].id);
  };
  const onPaste = (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  const captionAllowed = active.kind !== "audio";
  const warn = warningFor(active);
  const total = items.length;

  return (
    <div className="fixed inset-0 z-[60] bg-[#0B141A]/95 flex flex-col" onPaste={onPaste} data-testid="media-preview-modal"
      onDragOver={(e) => { e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); addFiles(Array.from(e.dataTransfer?.files || [])); }}>
      {/* header */}
      <div className="flex items-center gap-3 px-4 py-3 text-white shrink-0">
        <button onClick={onClose} disabled={sending} className="p-1 hover:bg-white/10 rounded" title="Cancel" data-testid="media-preview-close">
          <X size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{active.file.name}</div>
          <div className="text-[11px] text-white/60">
            {fmtSize(active.file.size)}{total > 1 ? ` · ${items.indexOf(active) + 1} of ${total}` : ""}{customerName ? ` · to ${customerName}` : ""}
          </div>
        </div>
      </div>

      {/* preview */}
      <div className="flex-1 min-h-0 flex items-center justify-center px-4 pb-2">
        <PreviewBody it={active} />
      </div>

      {/* caption + thumbnails + send */}
      <div className="shrink-0 px-3 sm:px-6 pb-4 pt-2 space-y-3 max-w-3xl w-full mx-auto">
        {warn && <div className="text-[12px] text-[#FCD34D] text-center">{warn}</div>}
        {captionAllowed ? (
          <div className="flex items-end gap-2 bg-[#2A3942] rounded-lg px-3 py-2">
            <textarea
              ref={captionRef}
              value={active.caption}
              onChange={(e) => setCaption(e.target.value.slice(0, CAPTION_MAX))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !sending && window.matchMedia?.("(min-width: 768px)").matches) {
                  e.preventDefault();
                  onSend();
                }
              }}
              placeholder="Add a caption…"
              rows={1}
              maxLength={CAPTION_MAX}
              className="flex-1 bg-transparent text-white placeholder-white/50 text-sm resize-none outline-none max-h-28"
              data-testid="media-caption-input"
            />
            {active.caption.length > CAPTION_MAX - 100 && (
              <span className="text-[10px] text-white/50 shrink-0">{active.caption.length}/{CAPTION_MAX}</span>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-white/50 text-center">WhatsApp doesn't allow captions on audio files.</div>
        )}
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 overflow-x-auto pb-1">
            {items.map((it) => (
              <Thumb key={it.id} it={it} active={it.id === active.id} onClick={() => setActiveId(it.id)}
                onRemove={() => remove(it.id)} disabled={sending} />
            ))}
            <input ref={addRef} type="file" multiple className="hidden"
              onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
            <button type="button" onClick={() => addRef.current?.click()} disabled={sending}
              className="shrink-0 w-14 h-14 rounded-md border-2 border-dashed border-white/30 text-white/70 hover:text-white hover:border-white flex items-center justify-center"
              title="Add more files" data-testid="media-add-more">
              <Plus size={20} />
            </button>
          </div>
          <button onClick={onSend} disabled={sending}
            className="shrink-0 bg-[#25D366] hover:bg-[#1da851] text-white w-14 h-14 rounded-full flex items-center justify-center disabled:opacity-60 relative"
            title={total > 1 ? `Send ${total} files` : "Send"} data-testid="media-send-btn">
            {sending ? <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <PaperPlaneRight size={22} weight="fill" />}
            {total > 1 && !sending && (
              <span className="absolute -top-1 -right-1 bg-white text-[#25D366] text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">{total}</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Camera ---------------- */
function pickRecorderMime() {
  if (typeof MediaRecorder === "undefined") return "";
  // webm first: the server converts it to a proper WhatsApp MP4. Safari only does mp4.
  const opts = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return opts.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || "";
}

export function CameraModal({ onClose, onCaptured }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const fallbackRef = useRef(null);
  const [mode, setMode] = useState("photo");          // photo | video
  const [facing, setFacing] = useState("environment");
  const [canSwitch, setCanSwitch] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);

  const stopStream = () => {
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setReady(false); setError("");
      stopStream();
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This browser can't open the camera here.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: mode === "video",
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
        try {
          const devs = await navigator.mediaDevices.enumerateDevices();
          setCanSwitch(devs.filter((d) => d.kind === "videoinput").length > 1);
        } catch { /* ignore */ }
      } catch (e) {
        setError(e?.name === "NotAllowedError"
          ? "Camera permission was denied. Allow camera access for this site and try again."
          : "Couldn't start the camera.");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facing, mode]);

  useEffect(() => () => {
    clearInterval(timerRef.current);
    try { if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop(); } catch { /* ignore */ }
    stopStream();
  }, []);

  const close = () => {
    if (recording) return;
    stopStream();
    onClose();
  };

  const takePhoto = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setBusy(true);
    try {
      const maxDim = 1600;
      const scale = Math.min(1, maxDim / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(v, 0, 0, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
      if (!blob) throw new Error("capture failed");
      const file = new File([blob], `photo_${Date.now()}.jpg`, { type: "image/jpeg" });
      stopStream();
      onCaptured([file]);
    } catch {
      toast.error("Couldn't take the photo");
    } finally {
      setBusy(false);
    }
  };

  const startVideo = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const mimeType = pickRecorderMime();
    let rec;
    try {
      rec = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 1_200_000,     // ~1 MB per 7 s: a 90 s clip stays under WhatsApp's 16 MB
        audioBitsPerSecond: 96_000,
      });
    } catch {
      toast.error("Video recording isn't supported in this browser");
      return;
    }
    chunksRef.current = [];
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunksRef.current.push(ev.data); };
    rec.onstop = () => {
      clearInterval(timerRef.current);
      setRecording(false);
      const type = rec.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunksRef.current, { type });
      if (!blob.size) { toast.error("Nothing was recorded"); return; }
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const file = new File([blob], `video_${Date.now()}.${ext}`, { type: type.split(";")[0] });
      stopStream();
      onCaptured([file]);
    };
    rec.start(1000);
    recRef.current = rec;
    setRecording(true);
    setElapsed(0);
    const t0 = Date.now();
    timerRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setElapsed(s);
      if (s >= VIDEO_MAX_SECONDS && rec.state !== "inactive") rec.stop();
    }, 250);
  };

  const stopVideo = () => {
    try { if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop(); } catch { /* ignore */ }
  };

  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="fixed inset-0 z-[60] bg-black flex flex-col" data-testid="camera-modal">
      <div className="flex items-center justify-between px-4 py-3 text-white shrink-0">
        <button onClick={close} disabled={recording} className="p-1 hover:bg-white/10 rounded disabled:opacity-40" title="Close" data-testid="camera-close">
          <X size={20} />
        </button>
        {recording ? (
          <div className="flex items-center gap-2 text-sm font-mono">
            <span className="w-2 h-2 rounded-full bg-[#E60000] animate-pulse" /> {mmss(elapsed)} / {mmss(VIDEO_MAX_SECONDS)}
          </div>
        ) : <div className="text-sm font-semibold">{mode === "photo" ? "Photo" : "Video"}</div>}
        {canSwitch && !recording ? (
          <button onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))} className="p-1 hover:bg-white/10 rounded" title="Switch camera" data-testid="camera-switch">
            <ArrowsClockwise size={20} />
          </button>
        ) : <span className="w-7" />}
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center relative">
        <video ref={videoRef} playsInline muted autoPlay
          className="max-h-full max-w-full"
          style={facing === "user" ? { transform: "scaleX(-1)" } : undefined} />
        {!ready && !error && <div className="absolute text-white/70 text-sm">Starting camera…</div>}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white text-center px-6">
            <Camera size={48} weight="light" />
            <div className="text-sm max-w-sm">{error}</div>
            <input ref={fallbackRef} type="file" accept={mode === "photo" ? "image/*" : "video/*"} capture="environment" className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                const file = kindForFile(f) === "image" ? await compressImage(f) : f;
                onCaptured([file]);
              }} />
            <button onClick={() => fallbackRef.current?.click()}
              className="bg-white text-black px-4 py-2 text-xs uppercase tracking-widest font-bold rounded" data-testid="camera-fallback">
              Use the device camera app
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 pb-6 pt-3 flex flex-col items-center gap-3">
        {!recording && (
          <div className="flex gap-1 bg-white/10 rounded-full p-1">
            {[["photo", "Photo"], ["video", "Video"]].map(([k, label]) => (
              <button key={k} onClick={() => setMode(k)}
                className={`px-4 py-1 rounded-full text-xs font-bold uppercase tracking-widest ${mode === k ? "bg-white text-black" : "text-white"}`}
                data-testid={`camera-mode-${k}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        {mode === "photo" ? (
          <button onClick={takePhoto} disabled={!ready || busy}
            className="w-16 h-16 rounded-full border-4 border-white bg-white/90 hover:bg-white disabled:opacity-40" title="Take photo" data-testid="camera-shutter" />
        ) : recording ? (
          <button onClick={stopVideo}
            className="w-16 h-16 rounded-full border-4 border-white bg-[#E60000] flex items-center justify-center" title="Stop" data-testid="camera-stop">
            <Stop size={22} weight="fill" className="text-white" />
          </button>
        ) : (
          <button onClick={startVideo} disabled={!ready}
            className="w-16 h-16 rounded-full border-4 border-white bg-[#E60000] disabled:opacity-40" title="Start recording" data-testid="camera-record" />
        )}
      </div>
    </div>
  );
}
