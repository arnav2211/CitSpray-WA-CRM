import React, { useCallback, useEffect, useState } from "react";
import { FilmStrip, Play, Trash, ArrowUp, ArrowDown, ChartBar, UploadSimple, YoutubeLogo, CalendarBlank } from "@phosphor-icons/react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { VideoPlayerModal } from "@/components/DailyVideo";

/* Admin: Video of the Day queue + who watched it. One video a day goes to every executive
   (optional for them). Undated videos wait in the queue and the next one is used each day. */

const inp = "w-full border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:border-[#7C3AED]";
const EMPTY = { title: "", format: "rewind", youtube_url: "", date: "", notes: "", q: "", options: ["", "", "", ""], answer: null };

function fmtDate(d) {
  try { return new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }); } catch { return d; }
}

function videoDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => { resolve(v.duration || 0); URL.revokeObjectURL(v.src); };
    v.onerror = () => resolve(0);
    v.src = URL.createObjectURL(file);
  });
}

function Report({ id }) {
  const [r, setR] = useState(null);
  useEffect(() => { api.get(`/daily-videos/${id}/report`).then(({ data }) => setR(data)).catch((e) => toast.error(errMsg(e))); }, [id]);
  if (!r) return <div className="text-xs text-gray-500 p-3">Loading…</div>;
  const opts = r.video.quiz_full?.options || [];
  return (
    <table className="w-full text-xs">
      <thead><tr className="text-left text-gray-500 border-b"><th className="py-1 px-2">Executive</th><th className="px-2">Watched</th><th className="px-2">Answer</th></tr></thead>
      <tbody>
        {r.rows.map((x) => (
          <tr key={x.user_id} className="border-b border-gray-100">
            <td className="py-1 px-2 font-bold">{x.name}</td>
            <td className={`px-2 ${x.completed ? "text-green-700 font-bold" : x.opened ? "text-[#B36200]" : "text-gray-400"}`}>
              {x.completed ? "✓ Full" : x.opened ? `${Math.round(x.max_pct)}%` : "Not opened"}
            </td>
            <td className={`px-2 ${x.quiz_correct ? "text-green-700" : x.quiz_choice != null ? "text-[#E60000]" : "text-gray-400"}`}>
              {x.quiz_choice == null ? "-" : `${x.quiz_correct ? "✓" : "✗"} ${String.fromCharCode(65 + x.quiz_choice)}. ${opts[x.quiz_choice] || ""}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function DailyVideos() {
  const [data, setData] = useState(null);
  const [f, setF] = useState(EMPTY);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [play, setPlay] = useState(null);
  const [report, setReport] = useState(null);

  const load = useCallback(() => {
    api.get("/daily-videos").then(({ data: d }) => setData(d)).catch((e) => toast.error(errMsg(e, "Could not load videos")));
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const add = async () => {
    if (!f.title.trim()) { toast.error("Give the video a title"); return; }
    if (!file && !f.youtube_url.trim()) { toast.error("Choose an MP4 or paste a YouTube link"); return; }
    const fd = new FormData();
    fd.append("title", f.title);
    fd.append("format", file ? f.format : (f.format === "rewind" ? "youtube" : f.format));
    fd.append("youtube_url", f.youtube_url);
    fd.append("date", f.date);
    fd.append("notes", f.notes);
    if (f.q.trim()) fd.append("quiz", JSON.stringify({ q: f.q, options: f.options, answer: f.answer }));
    if (file) {
      fd.append("file", file);
      fd.append("duration", String(Math.round(await videoDuration(file))));
    }
    setBusy(true); setProgress(0);
    try {
      await api.post("/daily-videos", fd, { onUploadProgress: (e) => e.total && setProgress(Math.round((e.loaded / e.total) * 100)) });
      toast.success("Video added");
      setF(EMPTY); setFile(null); load();
    } catch (e) { toast.error(errMsg(e, "Upload failed")); }
    finally { setBusy(false); }
  };

  const upd = async (id, body) => {
    try { await api.put(`/daily-videos/${id}`, body); load(); } catch (e) { toast.error(errMsg(e)); }
  };
  const del = async (v) => {
    if (!window.confirm(`Delete "${v.title}"?`)) return;
    try { await api.delete(`/daily-videos/${v.id}`); load(); } catch (e) { toast.error(errMsg(e)); }
  };
  const setDate = (v) => {
    const d = window.prompt("Show on which date? (YYYY-MM-DD) - leave empty to put it back in the queue", v.date || "");
    if (d === null) return;
    upd(v.id, { date: d.trim() });
  };

  const queued = (data?.videos || []).filter((v) => v.state === "queued");
  const badge = (v) => {
    if (v.state === "today") return <span className="bg-[#7C3AED] text-white px-1.5 py-0.5 text-[10px] font-bold">TODAY</span>;
    if (v.state === "queued") return <span className="bg-gray-100 text-gray-700 px-1.5 py-0.5 text-[10px] font-bold">QUEUE #{queued.indexOf(v) + 1}</span>;
    if (v.state === "scheduled") return <span className="bg-blue-50 text-[#002FA7] px-1.5 py-0.5 text-[10px] font-bold">{fmtDate(v.date)}</span>;
    return <span className="text-gray-500 text-[10px] font-bold">{fmtDate(v.date)}</span>;
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl" data-testid="daily-videos-page">
      <h1 className="text-xl font-black flex items-center gap-2"><FilmStrip size={24} weight="fill" className="text-[#7C3AED]" /> Video of the Day</h1>
      <p className="text-xs text-gray-500 mt-1 mb-5">
        One short training video a day for every executive, shown as a strip at the top of their CRM. Watching is optional;
        you see who watched and how they answered the question. Videos without a date wait in the queue - the next one goes out each day.
      </p>

      <div className="border border-gray-200 p-4 mb-6">
        <div className="font-bold text-sm mb-3">Add a video</div>
        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-xs font-bold">Title
            <input className={inp} value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Rate pucha? Rate batao." />
          </label>
          <label className="text-xs font-bold">Format
            <select className={inp} value={f.format} onChange={(e) => set("format", e.target.value)}>
              {Object.entries(data?.formats || {}).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold flex flex-col gap-1">
            <span className="flex items-center gap-1"><UploadSimple size={14} /> MP4 file</span>
            <input type="file" accept="video/mp4,video/*" onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-xs" />
          </label>
          <label className="text-xs font-bold">
            <span className="flex items-center gap-1"><YoutubeLogo size={14} /> …or YouTube link</span>
            <input className={inp} value={f.youtube_url} onChange={(e) => set("youtube_url", e.target.value)} placeholder="https://youtube.com/shorts/…" disabled={!!file} />
          </label>
          <label className="text-xs font-bold">
            <span className="flex items-center gap-1"><CalendarBlank size={14} /> Date (optional - empty = queue)</span>
            <input type="date" className={inp} value={f.date} onChange={(e) => set("date", e.target.value)} />
          </label>
          <label className="text-xs font-bold">Note for yourself (optional)
            <input className={inp} value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Based on 18 Nov call" />
          </label>
        </div>
        <div className="mt-4 text-xs font-bold">Question after the video (optional) - tick the right answer</div>
        <input className={`${inp} mt-1`} value={f.q} onChange={(e) => set("q", e.target.value)} placeholder='Customer pooche "Rate kya hai?" - sabse sahi jawab?' />
        <div className="grid md:grid-cols-2 gap-2 mt-2">
          {f.options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="radio" name="dv-answer" checked={f.answer === i} onChange={() => set("answer", i)} />
              <input className={inp} value={o} placeholder={`Option ${String.fromCharCode(65 + i)}`}
                onChange={(e) => set("options", f.options.map((x, k) => (k === i ? e.target.value : x)))} />
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button type="button" onClick={add} disabled={busy} className="bg-[#7C3AED] text-white font-bold text-sm px-4 py-2 disabled:opacity-50">
            {busy ? `Uploading ${progress}%…` : "Add video"}
          </button>
        </div>
      </div>

      <div className="font-bold text-sm mb-2">Videos {data ? <span className="text-gray-400 font-normal">· {data.executives} executives</span> : null}</div>
      {!data ? <div className="text-xs text-gray-500">Loading…</div> : !data.videos.length ? (
        <div className="text-xs text-gray-500 border border-dashed border-gray-300 p-6 text-center">No videos yet - add the first one above.</div>
      ) : (
        <div className="border border-gray-200 divide-y divide-gray-100">
          {data.videos.map((v) => (
            <div key={v.id} className={v.state === "past" ? "bg-gray-50/60" : ""}>
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <div className="w-24 shrink-0">{badge(v)}</div>
                <div className="flex-1 min-w-[180px]">
                  <div className="font-bold text-sm">{v.title}</div>
                  <div className="text-[11px] text-gray-500">
                    {v.format_label}{v.source === "youtube" ? " · YouTube" : ""}{v.quiz ? " · has question" : ""}{v.notes ? ` · ${v.notes}` : ""}
                  </div>
                </div>
                <div className="text-[11px] text-gray-600 w-40 shrink-0">
                  {v.state === "queued" || v.state === "scheduled" ? "-" : (
                    <>Watched <b>{v.stats.watched}/{data.executives}</b>{v.quiz ? <> · correct <b>{v.stats.correct}/{v.stats.answered}</b></> : null}</>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" title="Play" onClick={() => setPlay(v)} className="p-1.5 hover:bg-gray-100"><Play size={16} weight="fill" /></button>
                  {v.state !== "queued" && v.state !== "scheduled" && (
                    <button type="button" title="Who watched" onClick={() => setReport(report === v.id ? null : v.id)} className="p-1.5 hover:bg-gray-100"><ChartBar size={16} /></button>
                  )}
                  {v.state === "queued" && <>
                    <button type="button" title="Move up" onClick={() => upd(v.id, { move: "up" })} className="p-1.5 hover:bg-gray-100"><ArrowUp size={16} /></button>
                    <button type="button" title="Move down" onClick={() => upd(v.id, { move: "down" })} className="p-1.5 hover:bg-gray-100"><ArrowDown size={16} /></button>
                  </>}
                  {v.state !== "past" && <button type="button" title="Set date" onClick={() => setDate(v)} className="p-1.5 hover:bg-gray-100"><CalendarBlank size={16} /></button>}
                  <button type="button" title="Delete" onClick={() => del(v)} className="p-1.5 hover:bg-red-50 text-[#E60000]"><Trash size={16} /></button>
                </div>
              </div>
              {report === v.id && <div className="px-3 pb-3"><Report id={v.id} /></div>}
            </div>
          ))}
        </div>
      )}
      {play && <VideoPlayerModal video={play} track={false} onClose={() => setPlay(null)} />}
    </div>
  );
}
