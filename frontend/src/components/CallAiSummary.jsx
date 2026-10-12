import React, { useEffect, useState } from "react";
import { Sparkle } from "@phosphor-icons/react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";

/* AI summary of a recorded call (the phone's recording is summarised by Gemini
   on the server and then deleted). Shown under the call in every call list. */

const INTEREST = {
  hot: ["Hot", "bg-[#FDECEC] text-[#B00000] border-[#E60000]"],
  warm: ["Warm", "bg-[#FFF4E5] text-[#B85F00] border-[#E67E00]"],
  cold: ["Cold", "bg-[#EAF1FF] text-[#002FA7] border-[#002FA7]"],
  not_interested: ["Not interested", "bg-gray-100 text-gray-600 border-gray-300"],
};

export default function CallAiSummary({ ai, compact = false }) {
  if (!ai || !ai.summary) return null;
  const facts = [
    ai.products?.length ? ["Products", ai.products.join(", ")] : null,
    ai.quantity ? ["Quantity", ai.quantity] : null,
    ai.price_discussed ? ["Price", ai.price_discussed] : null,
    ai.next_step ? ["Next step", ai.next_step] : null,
    ai.follow_up ? ["Follow up", ai.follow_up] : null,
  ].filter(Boolean);
  const it = INTEREST[ai.interest];
  return (
    <div className="mt-2 border border-[#DDD6FE] bg-[#F5F3FF] p-2 text-xs" data-testid="call-ai-summary">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest font-bold text-[#6D28D9] flex items-center gap-1">
          <Sparkle size={11} weight="fill" /> AI call summary
        </span>
        {it && <span className={`border px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold ${it[1]}`}>{it[0]}</span>}
      </div>
      <div className="text-gray-800 mt-1 leading-relaxed whitespace-pre-wrap">{ai.summary}</div>
      {!compact && facts.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {facts.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[72px_1fr] gap-2">
              <span className="text-[9px] uppercase tracking-widest font-bold text-gray-500 pt-0.5">{k}</span>
              <span className="text-gray-800 break-words">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* Settings → AI call summaries */
export function CallAiSettingsPanel() {
  const [cfg, setCfg] = useState(null);
  const [extra, setExtra] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get("/settings/call-ai");
      setCfg(data);
      setExtra((data.internal_numbers || []).join("\n"));
    } catch { /* admin only */ }
  };
  useEffect(() => { load(); }, []);

  const save = async (patch) => {
    setSaving(true);
    try {
      const { data } = await api.put("/settings/call-ai", patch);
      setCfg(data); setExtra((data.internal_numbers || []).join("\n"));
      toast.success("Saved");
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  if (!cfg) return null;
  const s = cfg.stats_24h || {};
  return (
    <div className="border border-gray-200 bg-white" data-testid="call-ai-panel">
      <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-chivo font-bold text-lg flex items-center gap-2"><Sparkle size={18} weight="fill" className="text-[#6D28D9]" /> AI call summaries</h2>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            The LeadOrbit app uploads the phone's own call recording after each call; Gemini writes a summary that shows under the
            call, then the recording is deleted from the server and the phone. Calls with team / admin numbers are skipped.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={!!cfg.enabled} disabled={saving} onChange={(e) => save({ enabled: e.target.checked })} data-testid="call-ai-enabled" />
          Enabled
        </label>
      </div>
      <div className="p-5 grid md:grid-cols-2 gap-5 text-sm">
        <div className="space-y-3">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Last 24 hours</div>
          <div className="flex gap-4 text-xs">
            <span><b className="text-lg font-chivo">{s.done || 0}</b> summarised</span>
            <span><b className="text-lg font-chivo">{(s.pending || 0) + (s.processing || 0)}</b> waiting</span>
            <span><b className="text-lg font-chivo">{s.failed || 0}</b> failed</span>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={cfg.include_admins !== false} disabled={saving}
              onChange={(e) => save({ include_admins: e.target.checked })} data-testid="call-ai-include-admins" />
            <span><b>Admins too</b><span className="block text-xs text-gray-500">Also summarise calls made from phones logged in as admin. Off = admins' calls are left alone (not uploaded, not deleted).</span></span>
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Skip calls shorter than (seconds)</span>
            <input type="number" min={0} max={600} defaultValue={cfg.min_seconds} key={cfg.min_seconds}
              onBlur={(e) => Number(e.target.value) !== cfg.min_seconds && save({ min_seconds: Number(e.target.value) })}
              className="mt-1 w-28 border border-gray-300 px-2 py-1.5" data-testid="call-ai-min-seconds" />
          </label>
        </div>
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Internal numbers (never summarised)</div>
          <div className="text-xs text-gray-600 space-y-0.5">
            {(cfg.team_numbers || []).map((t) => (
              <div key={t.name}><b>{t.name}:</b> {t.numbers.length ? t.numbers.join(", ") : <span className="text-[#B85F00]">no number — add it on the Users page (receiver numbers)</span>}</div>
            ))}
          </div>
          <textarea value={extra} onChange={(e) => setExtra(e.target.value)} rows={3} placeholder="Extra numbers, one per line (office landline, owner's second phone…)"
            className="w-full border border-gray-300 px-2 py-1.5 text-xs font-mono" data-testid="call-ai-extra-numbers" />
          <button disabled={saving} onClick={() => save({ internal_numbers: extra.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean) })}
            className="bg-[#002FA7] text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50">Save numbers</button>
        </div>
      </div>
    </div>
  );
}
