import React, { useEffect, useState } from "react";
import { Sparkle, WhatsappLogo, PaperPlaneRight } from "@phosphor-icons/react";
import { useAuth } from "@/context/AuthContext";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { fmtSmartLong } from "@/lib/format";

/* AI summary of a recorded call (the phone's recording is summarised by Gemini
   on the server and then deleted). Shown under the call in every call list. */

const INTEREST = {
  hot: ["Hot", "bg-[#FDECEC] text-[#B00000] border-[#E60000]"],
  warm: ["Warm", "bg-[#FFF4E5] text-[#B85F00] border-[#E67E00]"],
  cold: ["Cold", "bg-[#EAF1FF] text-[#002FA7] border-[#002FA7]"],
  not_interested: ["Not interested", "bg-gray-100 text-gray-600 border-gray-300"],
};

function WhatsAppDraft({ text, leadId }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(text);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const send = async () => {
    if (!draft.trim()) return;
    setSending(true);
    try {
      await api.post("/whatsapp/send", { lead_id: leadId, body: draft.trim() });
      toast.success("Sent on WhatsApp");
      setSent(true); setOpen(false);
    } catch (e) {
      toast.error(errMsg(e, "Could not send") + " — if it's outside the 24-hour window, send a template first");
    } finally { setSending(false); }
  };
  if (sent) return <div className="mt-1.5 text-[11px] font-semibold text-[#008A00]">✓ WhatsApp follow-up sent</div>;
  return (
    <div className="mt-1.5 border-t border-[#DDD6FE] pt-1.5" data-testid="call-ai-wa-draft">
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-[11px] font-semibold text-[#128C7E] flex items-center gap-1 hover:underline">
          <WhatsappLogo size={13} weight="fill" /> WhatsApp follow-up ready — review &amp; send
        </button>
      ) : (
        <div className="space-y-1.5">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4}
            className="w-full border border-gray-300 bg-white p-1.5 text-xs outline-none focus:border-[#128C7E]" data-testid="call-ai-wa-text" />
          <div className="flex gap-1.5">
            {leadId && (
              <button onClick={send} disabled={sending} data-testid="call-ai-wa-send"
                className="bg-[#25D366] hover:bg-[#1da851] text-white px-2.5 py-1 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50 flex items-center gap-1">
                <PaperPlaneRight size={11} weight="fill" /> {sending ? "Sending…" : "Send"}
              </button>
            )}
            <button onClick={() => { navigator.clipboard?.writeText(draft); toast.success("Copied"); }}
              className="border border-gray-300 bg-white px-2.5 py-1 text-[10px] uppercase tracking-widest font-bold">Copy</button>
            <button onClick={() => setOpen(false)} className="px-2 py-1 text-[10px] uppercase tracking-widest font-bold text-gray-500">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

const CHECKS = [["asked_quantity", "Asked quantity"], ["asked_purpose", "Asked purpose"],
  ["explained_product", "Explained product"], ["asked_for_order", "Asked for order"]];

export default function CallAiSummary({ ai, compact = false, leadId = null }) {
  const { user } = useAuth();
  const [showTx, setShowTx] = useState(false);
  if (!ai || !ai.summary) return null;
  const facts = [
    ai.products?.length ? ["Products", ai.products.join(", ")] : null,
    ai.quantity ? ["Quantity", ai.quantity] : null,
    ai.price_discussed ? ["Price", ai.price_discussed] : null,
    ai.next_step ? ["Next step", ai.next_step] : null,
    ai.follow_up ? ["Follow up", ai.follow_up] : null,
    ai.customer_company ? ["Company", ai.customer_company] : null,
    ai.customer_city ? ["City", ai.customer_city] : null,
  ].filter(Boolean);
  const it = INTEREST[ai.interest];
  const co = ai.coaching;
  return (
    <div className="mt-2 border border-[#DDD6FE] bg-[#F5F3FF] p-2 text-xs" data-testid="call-ai-summary">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest font-bold text-[#6D28D9] flex items-center gap-1">
          <Sparkle size={11} weight="fill" /> AI call summary
        </span>
        {it && <span className={`border px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold ${it[1]}`}>{it[0]}</span>}
        {user?.role === "admin" && co?.score != null && (
          <span className="border border-gray-300 bg-white px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold text-gray-700" title="Call handling score">
            Score {co.score}/10
          </span>
        )}
      </div>
      <div className="text-gray-800 mt-1 leading-relaxed whitespace-pre-wrap">{ai.summary}</div>
      {ai.followup_due_at && (
        <div className="mt-1 text-[11px] font-semibold text-[#002FA7]" data-testid="call-ai-followup">
          Follow-up set automatically for {fmtSmartLong(ai.followup_due_at)}
        </div>
      )}
      {ai.promise?.made && ai.promise?.channel === "whatsapp" && (
        <div className="mt-1 text-[11px] font-semibold text-[#B85F00]" data-testid="call-ai-promise">
          Promised on WhatsApp: {ai.promise.what}{ai.promise_due_at ? ` — reminder if not sent by ${fmtSmartLong(ai.promise_due_at)}` : ""}
        </div>
      )}
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
      {!compact && ai.key_points?.length > 0 && (
        <div className="mt-1.5 border-t border-[#DDD6FE] pt-1.5" data-testid="call-ai-key-points">
          <div className="text-[9px] uppercase tracking-widest font-bold text-gray-500">Everything said</div>
          <ul className="list-disc pl-4 mt-0.5 space-y-0.5 text-gray-800">{ai.key_points.map((k, i) => <li key={i}>{k}</li>)}</ul>
        </div>
      )}
      {!compact && ai.transcript && (
        <div className="mt-1.5">
          <button onClick={() => setShowTx((v) => !v)} className="text-[10px] uppercase tracking-widest font-bold text-[#6D28D9] hover:underline" data-testid="call-ai-transcript-toggle">
            {showTx ? "Hide full conversation" : "Full conversation"}
          </button>
          {showTx && (
            <div className="mt-1 bg-white border border-gray-200 p-2 text-[11px] text-gray-800 whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto" data-testid="call-ai-transcript">
              {ai.transcript}
            </div>
          )}
        </div>
      )}
      {!compact && user?.role === "admin" && co && (co.tip || co.score != null) && (
        <div className="mt-1.5 border-t border-[#DDD6FE] pt-1.5" data-testid="call-ai-coaching">
          <div className="flex flex-wrap gap-1">
            {CHECKS.map(([k, label]) => (
              <span key={k} className={`px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold border ${co[k] ? "border-[#008A00] text-[#008A00] bg-white" : "border-gray-300 text-gray-400 bg-white line-through"}`}>{label}</span>
            ))}
          </div>
          {co.tip && <div className="mt-1 text-[11px] text-gray-700"><b>Coaching tip:</b> {co.tip}</div>}
        </div>
      )}
      {!compact && ai.whatsapp_draft && <WhatsAppDraft text={ai.whatsapp_draft} leadId={leadId} />}
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
            call, then the recording is deleted. Calls between two team members are skipped; team ↔ admin calls go to Team Calls.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={!!cfg.enabled} disabled={saving} onChange={(e) => save({ enabled: e.target.checked })} data-testid="call-ai-enabled" />
          Enabled
        </label>
      </div>
      {cfg.phones?.length > 0 && (
        <div className="border-b border-gray-200" data-testid="call-ai-phones">
          <div className="px-5 pt-4 text-[10px] uppercase tracking-widest text-gray-500 font-bold">Phones — is each one recording?</div>
          <div className="px-5 py-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[9px] uppercase tracking-widest text-gray-400">
                <tr><th className="text-left py-1 pr-3">Person</th><th className="text-left pr-3">Status</th>
                  <th className="text-right">Answered calls / recordings (24 h)</th></tr>
              </thead>
              <tbody>
                {cfg.phones.map((p) => (
                  <tr key={p.user_id} className="border-t border-gray-100 align-top">
                    <td className="py-1.5 pr-3 font-semibold whitespace-nowrap">{p.name}</td>
                    <td className="pr-3">
                      <span className={`inline-block px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold border ${
                        p.state === "ok" ? "border-[#008A00] text-[#008A00]" : p.state === "unknown" ? "border-gray-300 text-gray-500" : "border-[#E60000] text-[#B00000]"}`}>
                        {p.state === "ok" ? "OK" : p.state.replace("_", " ")}
                      </span>
                      <div className="text-gray-600 mt-0.5">{p.message}{p.delete_permission === false ? " · can't auto-delete (file access off)" : ""}</div>
                    </td>
                    <td className="text-right font-mono">{p.answered_calls_24h} / {p.recordings_24h}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-[11px] text-gray-500 mt-2">
              Android does not let apps record calls themselves — each phone's own Phone app must have <b>automatic call recording ON for all calls</b>.
              The <b>Call recording setup</b> button at the bottom of the menu shows the steps for each phone brand.
            </div>
          </div>
        </div>
      )}
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
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={cfg.auto_followup !== false} disabled={saving}
              onChange={(e) => save({ auto_followup: e.target.checked })} data-testid="call-ai-auto-followup" />
            <span><b>Automatic follow-ups</b><span className="block text-xs text-gray-500">When the customer asks to be called back ("call me Monday", "send the rate, I'll decide next week") a follow-up is created for the lead's owner. Not created when the customer isn't interested or one is already set around that time.</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={cfg.summarize_internal !== false} disabled={saving}
              onChange={(e) => save({ summarize_internal: e.target.checked })} data-testid="call-ai-internal" />
            <span><b>Summarise team calls</b><span className="block text-xs text-gray-500">Calls between a team member and an admin are summarised (rates, decisions, to-dos) on the Team Calls page. Calls between two team members are never summarised.</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={cfg.auto_delete !== false} disabled={saving}
              onChange={(e) => save({ auto_delete: e.target.checked })} data-testid="call-ai-auto-delete" />
            <span><b>Auto-delete recordings from phones</b><span className="block text-xs text-gray-500">After a recording is safely uploaded the phone deletes its copy. Off = recordings stay on the phones. (The server always deletes its copy once the summary is made.)</span></span>
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Skip calls shorter than (seconds)</span>
            <input type="number" min={0} max={600} defaultValue={cfg.min_seconds} key={cfg.min_seconds}
              onBlur={(e) => Number(e.target.value) !== cfg.min_seconds && save({ min_seconds: Number(e.target.value) })}
              className="mt-1 w-28 border border-gray-300 px-2 py-1.5" data-testid="call-ai-min-seconds" />
          </label>
        </div>
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Team / internal numbers (their calls go to Team Calls)</div>
          <div className="text-xs text-gray-600 space-y-0.5">
            {(cfg.team_numbers || []).map((t) => (
              <div key={t.name}><b>{t.name}:</b> {t.numbers.length ? t.numbers.join(", ") : <span className="text-[#B85F00]">no number — add it in Settings → Lead routing → Receiver numbers</span>}</div>
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

/* "Call recording setup" help (menu button): Android doesn't let apps record calls,
   so each phone's own Phone app must record every call automatically. */
const REC_STEPS = [
  ["Samsung", "Phone app → ⋮ (top right) → Settings → Record calls → turn ON “Auto record calls” → All calls."],
  ["Xiaomi / Redmi / POCO", "Phone app → ⚙ or ⋮ → Settings → Call recording → turn ON “Record calls automatically” → All numbers."],
  ["Vivo / iQOO", "Phone app → ⋮ / Settings → Call recording → turn ON automatic recording → All calls."],
  ["Oppo / Realme / OnePlus", "Phone app → ⋮ → Settings → Call recording → Auto-record calls → All calls."],
  ["Google Phone app (Pixel, Motorola, Nokia…)", "Its recordings are private to Google's app, so LeadOrbit can't read them. If the phone has another Phone app, make that the default and turn on auto recording there."],
];

export function RecordingSetupModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onClose} data-testid="recording-setup-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white border border-gray-900 w-full max-w-lg p-5 space-y-3 max-h-[90vh] overflow-y-auto">
        <div className="font-chivo font-black text-lg">Turn on call recording</div>
        <p className="text-xs text-gray-600">
          AI call summaries, automatic follow-ups and coaching need each call's recording. Android doesn't let apps record
          calls themselves, so the phone's own <b>Phone app</b> must record <b>every call automatically</b>. Do this once on each phone:
        </p>
        <div className="space-y-2">
          {REC_STEPS.map(([brand, step]) => (
            <div key={brand} className="border border-gray-200 p-2.5">
              <div className="text-xs font-bold">{brand}</div>
              <div className="text-xs text-gray-700 mt-0.5">{step}</div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-gray-500">
          Then keep using the LeadOrbit app as usual — after each call of 10 seconds or more the recording is picked up,
          summarised, and removed from the phone.
        </p>
        <div className="flex justify-end">
          <button onClick={onClose} className="bg-[#002FA7] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold">Got it</button>
        </div>
      </div>
    </div>
  );
}
