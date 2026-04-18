import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";

export default function RoutingRules() {
  const [rules, setRules] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try { const { data } = await api.get("/routing-rules"); setRules(data); } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      const { round_robin_enabled, time_slot_enabled, unopened_reassign_minutes, no_action_reassign_minutes, auto_whatsapp_on_create } = rules;
      await api.put("/routing-rules", { round_robin_enabled, time_slot_enabled, unopened_reassign_minutes: Number(unopened_reassign_minutes), no_action_reassign_minutes: Number(no_action_reassign_minutes), auto_whatsapp_on_create });
      toast.success("Saved");
      load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  if (!rules) return <div className="p-8 text-xs uppercase tracking-widest text-gray-500">Loading…</div>;

  return (
    <div className="p-6 md:p-8 max-w-3xl space-y-5">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">System</div>
        <h1 className="font-chivo font-black text-3xl md:text-4xl">Routing Rules</h1>
      </div>

      <div className="border border-gray-200 bg-white p-6 space-y-6" data-testid="routing-form">
        <Toggle label="Round Robin Assignment"
          desc="Distribute incoming leads evenly across active executives."
          checked={rules.round_robin_enabled}
          onChange={(v) => setRules({ ...rules, round_robin_enabled: v })}
          testId="toggle-round-robin" />

        <Toggle label="Time-slot Routing"
          desc="Only send leads to executives currently within their configured working hours."
          checked={rules.time_slot_enabled}
          onChange={(v) => setRules({ ...rules, time_slot_enabled: v })}
          testId="toggle-time-slot" />

        <Toggle label="Auto-send WhatsApp welcome"
          desc="Send the welcome_lead template (mock) automatically when a lead is created."
          checked={rules.auto_whatsapp_on_create}
          onChange={(v) => setRules({ ...rules, auto_whatsapp_on_create: v })}
          testId="toggle-auto-whatsapp" />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumField label="Auto-reassign if unopened after (minutes)" value={rules.unopened_reassign_minutes} onChange={(v) => setRules({ ...rules, unopened_reassign_minutes: v })} testId="field-unopened-mins" />
          <NumField label="Auto-reassign if no action after (minutes)" value={rules.no_action_reassign_minutes} onChange={(v) => setRules({ ...rules, no_action_reassign_minutes: v })} testId="field-noaction-mins" />
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-200">
          <button onClick={save} disabled={saving} className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="routing-save-btn">
            {saving ? "Saving…" : "Save Rules"}
          </button>
        </div>
      </div>

      <div className="border border-gray-200 bg-gray-50 p-5 text-xs text-gray-600 leading-relaxed">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2">How it works</div>
        <ul className="list-disc pl-5 space-y-1">
          <li>New leads are auto-assigned to the next active executive (round-robin).</li>
          <li>If a lead is not opened within the unopened-minutes threshold, it is reassigned.</li>
          <li>If an opened lead has no activity within the no-action threshold, it is reassigned.</li>
          <li>Admin can manually override assignment at any time from the lead drawer.</li>
          <li>PNS from IndiaMART: leads received with a <span className="kbd">CALL_RECEIVER_NUMBER</span> are routed to the executive whose phone matches.</li>
        </ul>
      </div>
    </div>
  );
}

function Toggle({ label, desc, checked, onChange, testId }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="font-semibold text-sm">{label}</div>
        <div className="text-xs text-gray-500 mt-1">{desc}</div>
      </div>
      <button onClick={() => onChange(!checked)} data-testid={testId}
        className={`w-12 h-6 border border-gray-900 flex items-center transition-colors ${checked ? "bg-[#002FA7]" : "bg-white"}`}>
        <span className={`block w-5 h-5 bg-white border border-gray-900 transition-transform ${checked ? "translate-x-6" : "translate-x-0"}`} />
      </button>
    </div>
  );
}

function NumField({ label, value, onChange, testId }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">{label}</div>
      <input type="number" min={1} value={value} onChange={(e) => onChange(e.target.value)} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid={testId} />
    </label>
  );
}
