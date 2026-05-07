import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { FloppyDisk, ArrowCounterClockwise, Eye, EyeSlash, ShieldCheck, Copy, Link as LinkIcon, Phone, Plus, Trash, Lightning, Users as UsersIcon, Calendar, X, EnvelopeSimple, Paperclip, PaperPlaneTilt } from "@phosphor-icons/react";
import { fmtIST } from "@/lib/format";

const FIELDS = [
  { k: "access_token",          label: "Access Token",              secret: true,  hint: "Permanent System User token with whatsapp_business_messaging + whatsapp_business_management scopes." },
  { k: "phone_number_id",       label: "Phone Number ID",           hint: "Meta → WhatsApp Manager → Phone numbers. Numeric id." },
  { k: "waba_id",               label: "WhatsApp Business Account ID", hint: "The parent Business Account id (needed to list templates)." },
  { k: "api_version",           label: "API Version",               hint: "e.g. v22.0 — update when Meta releases a newer stable version." },
  { k: "verify_token",          label: "Webhook Verify Token",      hint: "Paste this exact string into Meta → WhatsApp → Configuration → Webhooks → Verify token." },
  { k: "app_secret",            label: "App Secret (optional)",     secret: true,  hint: "Meta App → Settings → Basic → App Secret. Used to verify webhook signatures." },
  { k: "default_template",      label: "Default Welcome Template",  hint: "Template name used for the first-touch message when a new lead is created. Must be APPROVED in Meta." },
  { k: "default_template_lang", label: "Default Template Language", hint: "Language code registered on the template, e.g. en_US, en, hi." },
];

export default function Settings() {
  const [cfg, setCfg] = useState(null);
  const [hooks, setHooks] = useState(null);
  const [form, setForm] = useState({});
  const [reveal, setReveal] = useState({});
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const [{ data: cfgD }, { data: hooksD }] = await Promise.all([
        api.get("/settings/whatsapp"),
        api.get("/settings/webhooks-info"),
      ]);
      setCfg(cfgD); resetForm(cfgD);
      setHooks(hooksD);
    } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const resetForm = (data) => {
    const f = {};
    for (const { k, secret } of FIELDS) {
      if (secret) {
        f[k] = ""; // don't pre-fill secrets — leave blank means "keep current"
      } else {
        f[k] = data?.effective?.[k] ?? "";
      }
    }
    setForm(f);
  };

  const onChange = (k, v) => setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    // Only send fields that differ from current or are non-blank for secrets
    const patch = {};
    for (const { k, secret } of FIELDS) {
      const v = form[k];
      if (secret) {
        // For secrets: empty input => don't change. Use a separate CLEAR button per-field.
        if (v && v.trim()) patch[k] = v.trim();
      } else {
        const current = cfg?.effective?.[k] ?? "";
        if ((v ?? "") !== current) patch[k] = v;
      }
    }
    if (Object.keys(patch).length === 0) {
      toast.info("Nothing to update");
      setSaving(false);
      return;
    }
    try {
      await api.put("/settings/whatsapp", patch);
      toast.success("Saved — new config is live");
      await load();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setSaving(false); }
  };

  const clearField = async (k) => {
    if (!window.confirm(`Clear the saved override for "${k}" and fall back to the .env default?`)) return;
    try {
      await api.put("/settings/whatsapp", { [k]: "" });
      toast.success(`${k} override cleared`);
      await load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  if (!cfg) return <div className="p-8 text-xs uppercase tracking-widest text-gray-500">Loading…</div>;

  const hasOverride = (k) => Object.prototype.hasOwnProperty.call(cfg.overrides || {}, k)
    || Object.prototype.hasOwnProperty.call(cfg.overrides || {}, `${k}_masked`);

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Admin</div>
        <h1 className="font-chivo font-black text-2xl md:text-4xl">Settings</h1>
      </div>

      {hooks && <WebhooksPanel hooks={hooks} />}

      <BuyleadsRoutingPanel />

      <LeaveManagementPanel />

      <ExportersIndiaPanel onChanged={load} />

      <CallRoutingPanel />

      <EmailAutoSendPanel />

      <form onSubmit={submit} className="border border-gray-200 bg-white" data-testid="whatsapp-settings-form">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="font-chivo font-bold text-lg">WhatsApp Cloud API</h2>
            <p className="text-xs text-gray-500 mt-1">
              Values live-override the defaults from <span className="kbd">backend/.env</span>.
              Leave secret fields blank to keep the current value; use <b>Clear</b> to drop an override.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {cfg.effective.enabled
              ? <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-widest font-bold bg-[#008A00] text-white"><ShieldCheck size={12} /> Active</span>
              : <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-widest font-bold bg-[#E60000] text-white">Disabled</span>}
          </div>
        </div>

        <div className="divide-y divide-gray-200">
          {FIELDS.map(({ k, label, secret, hint }) => {
            const overridden = hasOverride(k);
            const currentMasked = secret
              ? (cfg.effective?.[`${k}_masked`] || "(not set)")
              : (cfg.effective?.[k] ?? "(not set)");
            return (
              <div key={k} className="px-5 py-4 grid grid-cols-1 md:grid-cols-3 gap-4" data-testid={`wa-field-${k}`}>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-2">
                    {label}
                    {overridden && <span className="bg-[#002FA7] text-white px-1.5 py-0.5 text-[9px] font-bold">OVERRIDE</span>}
                  </div>
                  <div className="text-xs text-gray-500 mt-1 leading-relaxed">{hint}</div>
                  <div className="text-[10px] uppercase tracking-widest text-gray-400 font-bold mt-2">Current</div>
                  <div className="font-mono text-xs break-all" data-testid={`wa-current-${k}`}>{String(currentMasked) || "—"}</div>
                </div>
                <div className="md:col-span-2">
                  <div className="flex gap-2 items-center">
                    <input
                      type={secret && !reveal[k] ? "password" : "text"}
                      value={form[k] ?? ""}
                      onChange={(e) => onChange(k, e.target.value)}
                      placeholder={secret ? "Leave blank to keep current" : "Enter value"}
                      className="flex-1 border border-gray-300 px-3 py-2 text-sm font-mono focus:border-[#002FA7] focus:ring-2 focus:ring-[#002FA7] outline-none"
                      data-testid={`wa-input-${k}`}
                    />
                    {secret && (
                      <button type="button" onClick={() => setReveal((r) => ({ ...r, [k]: !r[k] }))} className="text-gray-500 hover:text-gray-900 p-2 border border-gray-300" title="Toggle reveal">
                        {reveal[k] ? <EyeSlash size={14} /> : <Eye size={14} />}
                      </button>
                    )}
                    {overridden && (
                      <button type="button" onClick={() => clearField(k)} className="text-[10px] uppercase tracking-widest font-bold text-[#E60000] border border-[#E60000] hover:bg-[#E60000] hover:text-white px-2 py-2" data-testid={`wa-clear-${k}`}>
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-4 border-t border-gray-200 flex items-center justify-between bg-gray-50">
          <div className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">
            Webhook URL (paste in Meta)
            <div className="font-mono text-xs text-gray-700 mt-1 normal-case tracking-normal break-all">
              {window.location.origin}/api/webhooks/whatsapp
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => resetForm(cfg)} className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100 flex items-center gap-1" data-testid="wa-reset-btn">
              <ArrowCounterClockwise size={12} /> Reset
            </button>
            <button type="submit" disabled={saving} className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50" data-testid="wa-save-btn">
              <FloppyDisk size={12} weight="bold" /> {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function WebhooksPanel({ hooks }) {
  const items = [
    { ...hooks.whatsapp,             key: "whatsapp" },
    { ...hooks.indiamart,            key: "indiamart" },
    { ...hooks.exportersindia,       key: "exportersindia" },
    { ...hooks.gmail,                key: "gmail" },
    { ...hooks.justdial_manual_ingest, key: "justdial" },
  ].filter((x) => x && (x.url || x.label));
  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast.success(`${label} copied`); }
    catch { toast.error("Copy failed — please copy manually"); }
  };
  return (
    <div className="border border-gray-200 bg-white" data-testid="webhooks-panel">
      <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h2 className="font-chivo font-bold text-lg flex items-center gap-2"><LinkIcon size={18} weight="bold" /> Webhook URLs</h2>
          <p className="text-xs text-gray-500 mt-1">Paste these into the respective platform dashboards.</p>
        </div>
      </div>
      <div className="divide-y divide-gray-200">
        {items.map(it => (
          <div key={it.key} className="px-5 py-4" data-testid={`hook-${it.key}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="font-chivo font-bold">{it.label}</div>
                <div className="text-xs text-gray-500 mt-1">{it.where_to_paste}</div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="kbd">{it.method}</span>
                  {it.subscribe_fields && it.subscribe_fields.length > 0 && (
                    <span className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">Subscribe: {it.subscribe_fields.join(", ")}</span>
                  )}
                  {it.auth && <span className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">Auth: {it.auth}</span>}
                </div>
              </div>
            </div>
            <div className="mt-3 flex gap-2 items-stretch">
              <code className="flex-1 font-mono text-xs bg-gray-50 border border-gray-200 px-3 py-2 break-all" data-testid={`hook-url-${it.key}`}>
                {it.url}
              </code>
              <button onClick={() => copy(it.url, "URL")} className="border border-gray-900 px-3 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-900 hover:text-white flex items-center gap-1" data-testid={`copy-url-${it.key}`}>
                <Copy size={12} /> Copy
              </button>
            </div>
            {it.verify_token && (
              <div className="mt-2 flex gap-2 items-stretch">
                <div className="flex-1 flex">
                  <span className="bg-gray-100 border border-gray-200 border-r-0 px-2 py-2 text-[10px] uppercase tracking-widest text-gray-500 font-bold">Verify token</span>
                  <code className="flex-1 font-mono text-xs bg-gray-50 border border-gray-200 px-3 py-2 break-all" data-testid={`hook-verify-${it.key}`}>{it.verify_token}</code>
                </div>
                <button onClick={() => copy(it.verify_token, "Verify token")} className="border border-gray-900 px-3 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-900 hover:text-white flex items-center gap-1">
                  <Copy size={12} /> Copy
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}


function CallRoutingPanel() {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState({}); // { user_id: "new number input" }

  const load = async () => {
    try {
      const { data } = await api.get("/settings/receiver-routing");
      setRows(data.users || []);
    } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const saveNumbers = async (userId, numbers) => {
    setBusy(true);
    try {
      await api.put(`/users/${userId}/receiver-numbers`, { receiver_numbers: numbers });
      toast.success("Receiver numbers updated");
      setDrafts((d) => ({ ...d, [userId]: "" }));
      await load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const addNumber = (row) => {
    const draft = (drafts[row.id] || "").trim();
    if (!draft) return;
    const next = [...(row.receiver_numbers || []), draft];
    saveNumbers(row.id, next);
  };

  const removeNumber = (row, n) => {
    const next = (row.receiver_numbers || []).filter(x => x !== n);
    saveNumbers(row.id, next);
  };

  return (
    <div className="border border-gray-200 bg-white" data-testid="call-routing-panel">
      <div className="px-5 py-4 border-b border-gray-200">
        <h2 className="font-chivo font-bold text-lg flex items-center gap-2"><Phone size={18} weight="bold" /> Call Routing / Receiver Numbers</h2>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Map each user to one or more <b>IndiaMART receiver numbers</b>. When a PNS / call-tracked
          enquiry arrives, the lead is auto-assigned to the user whose receiver number matched.
          A number can only belong to one user.
        </p>
      </div>
      <div className="divide-y divide-gray-200">
        {rows.map(row => (
          <div key={row.id} className="px-5 py-4" data-testid={`routing-row-${row.username}`}>
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div>
                <div className="font-semibold text-sm">{row.name} <span className="text-gray-400 text-xs font-mono">@{row.username}</span></div>
                <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{row.role}</div>
              </div>
              <div className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">
                {(row.receiver_numbers || []).length} number{(row.receiver_numbers || []).length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 mb-2">
              {(row.receiver_numbers || []).length === 0 && (
                <span className="text-xs text-gray-400 italic">No numbers mapped — calls / PNS leads on these numbers will go through round-robin instead.</span>
              )}
              {(row.receiver_numbers || []).map(n => (
                <span key={n} className="inline-flex items-center gap-1 bg-gray-100 border border-gray-300 px-2 py-1 text-xs font-mono" data-testid={`receiver-${row.username}-${n}`}>
                  {n}
                  <button onClick={() => removeNumber(row, n)} disabled={busy} className="text-[#E60000] hover:bg-[#E60000] hover:text-white p-0.5" title="Remove">
                    <Trash size={11} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={drafts[row.id] || ""}
                onChange={(e) => setDrafts(d => ({ ...d, [row.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNumber(row); } }}
                placeholder="+91 9876543210"
                className="flex-1 border border-gray-300 px-3 py-1.5 text-sm font-mono outline-none focus:border-[#002FA7]"
                data-testid={`add-receiver-input-${row.username}`}
              />
              <button
                onClick={() => addNumber(row)}
                disabled={busy || !(drafts[row.id] || "").trim()}
                className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50"
                data-testid={`add-receiver-btn-${row.username}`}
              >
                <Plus size={12} weight="bold" /> Add
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExportersIndiaPanel({ onChanged }) {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [email, setEmail] = useState("");
  const [mins, setMins] = useState(1);
  const [secs, setSecs] = useState(0);
  const [reveal, setReveal] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get("/settings/exportersindia-pull");
      setCfg(data);
      setEmail(data.email || "");
      setMins(data.interval_minutes ?? 1);
      setSecs(data.interval_seconds ?? 0);
      setApiKey("");
    } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const save = async (patch) => {
    setSaving(true);
    try {
      await api.put("/settings/exportersindia-pull", patch);
      toast.success("Saved");
      await load();
      onChanged?.();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const { data } = await api.post("/settings/exportersindia-pull/run-now");
      const n = (data.created || []).length;
      toast.success(n ? `Pulled ${n} new lead(s)` : `Pull OK — ${data.skipped_empty ? "no new enquiries" : "nothing to do"}`);
      await load();
      onChanged?.();
    } catch (e) { toast.error(errMsg(e, "Pull failed")); }
    finally { setRunning(false); }
  };

  const toggleEnabled = async () => {
    const next = !cfg.enabled;
    if (next && (!apiKey.trim() && !cfg.has_key)) { toast.error("Set an API key first"); return; }
    if (next && !email.trim()) { toast.error("Set an email first"); return; }
    await save({ enabled: next });
  };

  if (!cfg) return null;
  const lastSuccess = cfg.last_success_at ? fmtIST(cfg.last_success_at) : "Never";
  return (
    <div className="border border-gray-200 bg-white" data-testid="exportersindia-panel">
      <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-chivo font-bold text-lg flex items-center gap-2"><ShieldCheck size={18} weight="bold" /> ExportersIndia Pull API</h2>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            LeadOrbit polls ExportersIndia on an interval you choose and imports new enquiries
            automatically — no webhook needed on their side. You can rotate the API key any time.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 cursor-pointer" data-testid="ei-pull-enable-toggle">
          <input type="checkbox" checked={cfg.enabled} onChange={toggleEnabled} className="w-4 h-4 accent-[#25D366]" />
          <span className="text-[10px] uppercase tracking-widest font-bold">{cfg.enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>

      <div className="p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Current key</div>
            <div className="font-mono text-sm bg-gray-50 border border-gray-200 p-2">
              {cfg.has_key ? cfg.api_key_masked : <span className="text-gray-400">Not set</span>}
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Last successful pull</div>
            <div className="text-sm bg-gray-50 border border-gray-200 p-2">
              {lastSuccess}
              {cfg.last_date_from && <span className="text-[10px] text-gray-500 ml-2">(date_from: {cfg.last_date_from})</span>}
              {typeof cfg.last_created_count === "number" && (
                <span className="ml-2 text-[10px] uppercase tracking-widest text-[#008A00] font-bold">+{cfg.last_created_count} new</span>
              )}
            </div>
            {cfg.last_error && <div className="text-[11px] text-[#E60000] font-mono bg-[#FFE9E9] p-2 border border-[#E60000]">⚠ {cfg.last_error}</div>}
          </div>
        </div>

        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">API key (rotate anytime)</div>
          <div className="flex items-stretch gap-2">
            <input
              type={reveal ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={cfg.has_key ? "Paste new key to replace, or leave blank" : "Paste ExportersIndia API key (e.g. RFVOVXlpV2NlQVMvVzl4Wk92VkcwUT09)"}
              className="flex-1 border border-gray-300 px-3 py-2 text-sm font-mono"
              data-testid="ei-pull-apikey-input"
            />
            <button type="button" onClick={() => setReveal(v => !v)} className="border border-gray-300 px-3 py-2 text-gray-700 hover:bg-gray-50" title={reveal ? "Hide" : "Reveal"}>
              {reveal ? <EyeSlash size={16} weight="bold" /> : <Eye size={16} weight="bold" />}
            </button>
            <button type="button" onClick={() => save({ api_key: apiKey })} disabled={!apiKey.trim() || saving}
              className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50"
              data-testid="ei-pull-save-key-btn">
              <FloppyDisk size={14} weight="bold" /> {saving ? "Saving…" : "Save key"}
            </button>
          </div>
        </label>

        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Account email</div>
          <div className="flex items-stretch gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g. citspray@gmail.com"
              className="flex-1 border border-gray-300 px-3 py-2 text-sm"
              data-testid="ei-pull-email-input"
            />
            <button type="button" onClick={() => save({ email })} disabled={saving}
              className="border border-gray-900 hover:bg-gray-900 hover:text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold" data-testid="ei-pull-save-email-btn">
              Save email
            </button>
          </div>
        </label>

        <div className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Pull interval</div>
          <div className="flex items-stretch gap-2 flex-wrap">
            <div className="flex items-center gap-1">
              <input type="number" min="0" max="60" value={mins} onChange={(e) => setMins(Number(e.target.value))}
                className="w-20 border border-gray-300 px-2 py-2 text-sm" data-testid="ei-pull-mins-input" />
              <span className="text-xs text-gray-500">min</span>
            </div>
            <div className="flex items-center gap-1">
              <input type="number" min="0" max="59" value={secs} onChange={(e) => setSecs(Number(e.target.value))}
                className="w-20 border border-gray-300 px-2 py-2 text-sm" data-testid="ei-pull-secs-input" />
              <span className="text-xs text-gray-500">sec</span>
            </div>
            <button type="button" onClick={() => save({ interval_minutes: mins, interval_seconds: secs })} disabled={saving}
              className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold" data-testid="ei-pull-save-interval-btn">
              Save interval
            </button>
            <span className="text-[10px] text-gray-500 self-center">Minimum 10s. Current: every {cfg.interval_minutes}m {cfg.interval_seconds}s.</span>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 pt-4">
          <div className="text-[11px] text-gray-500 font-mono break-all">
            GET {cfg.pull_url}?k=…&amp;email={email || "…"}&amp;date_from=YYYY-MM-DD
          </div>
          <button type="button" onClick={runNow} disabled={running || !cfg.has_key || !email}
            className="bg-[#25D366] hover:bg-[#1da851] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50"
            data-testid="ei-pull-run-now-btn">
            <Lightning size={14} weight="bold" /> {running ? "Pulling…" : "Run pull now"}
          </button>
        </div>
      </div>
    </div>
  );
}




// ---------------- Buyleads Routing (admin) ----------------
function BuyleadsRoutingPanel() {
  const [configs, setConfigs] = useState([]);
  const [execs, setExecs] = useState([]);
  const [draft, setDraft] = useState({}); // { IndiaMART: {mode, agent_ids}, ExportersIndia: {...} }
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get("/settings/buyleads-routing");
      setConfigs(data.configs || []);
      setExecs(data.executives || []);
      const d = {};
      (data.configs || []).forEach((c) => {
        d[c.source] = { mode: c.mode || "all", agent_ids: c.agent_ids || [] };
      });
      setDraft(d);
    } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const toggleAgent = (source, agentId) => {
    setDraft((d) => {
      const cur = d[source] || { mode: "selected", agent_ids: [] };
      const has = cur.agent_ids.includes(agentId);
      return {
        ...d,
        [source]: { ...cur, agent_ids: has ? cur.agent_ids.filter((x) => x !== agentId) : [...cur.agent_ids, agentId] },
      };
    });
  };

  const save = async (source) => {
    const cur = draft[source];
    if (!cur) return;
    if (cur.mode === "selected" && cur.agent_ids.length === 0) {
      toast.error("Select at least one agent — or switch to All agents");
      return;
    }
    setBusy(true);
    try {
      await api.put(`/settings/buyleads-routing/${source}`, cur);
      toast.success(`${source} buyleads routing saved`);
      await load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const setMode = (source, mode) => {
    setDraft((d) => ({ ...d, [source]: { ...(d[source] || { agent_ids: [] }), mode } }));
  };

  return (
    <div className="border border-gray-200 bg-white" data-testid="buyleads-routing-panel">
      <div className="px-5 py-4 border-b border-gray-200">
        <h2 className="font-chivo font-bold text-lg flex items-center gap-2">
          <UsersIcon size={18} weight="bold" /> Buyleads Routing
        </h2>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Route high-intent buyleads to a specific set of agents per source (round-robin).
          IndiaMART buyleads = <span className="kbd">QUERY_TYPE = B</span>.
          ExportersIndia buyleads = <span className="kbd">inq_type = "buyleads"</span>.
          All other leads continue to use the default round-robin.
        </p>
      </div>
      <div className="divide-y divide-gray-200">
        {configs.map((cfg) => {
          const d = draft[cfg.source] || { mode: "all", agent_ids: [] };
          return (
            <div key={cfg.source} className="px-5 py-4" data-testid={`buyleads-${cfg.source}`}>
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <div className="font-chivo font-bold">{cfg.source}</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setMode(cfg.source, "all")}
                    className={`px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold ${d.mode === "all" ? "bg-[#002FA7] text-white" : "border border-gray-300 hover:bg-gray-100"}`}
                    data-testid={`buyleads-mode-all-${cfg.source}`}
                  >All agents</button>
                  <button
                    onClick={() => setMode(cfg.source, "selected")}
                    className={`px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold ${d.mode === "selected" ? "bg-[#002FA7] text-white" : "border border-gray-300 hover:bg-gray-100"}`}
                    data-testid={`buyleads-mode-selected-${cfg.source}`}
                  >Selected agents</button>
                </div>
              </div>
              {d.mode === "selected" && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {execs.length === 0 && <span className="text-xs text-gray-400 italic">No active executives yet.</span>}
                  {execs.map((e) => {
                    const on = (d.agent_ids || []).includes(e.id);
                    return (
                      <button
                        key={e.id}
                        onClick={() => toggleAgent(cfg.source, e.id)}
                        className={`px-3 py-1.5 text-xs border ${on ? "bg-[#25D366] text-white border-[#25D366]" : "border-gray-300 hover:bg-gray-50"}`}
                        data-testid={`buyleads-agent-${cfg.source}-${e.username}`}
                      >
                        {on ? "✓ " : ""}{e.name} <span className="text-[10px] opacity-70">@{e.username}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">
                  {d.mode === "selected"
                    ? `${d.agent_ids.length} agent${d.agent_ids.length === 1 ? "" : "s"} selected`
                    : "Using default round-robin across all active executives"}
                  {cfg.updated_at && <span className="ml-2 normal-case tracking-normal">· last saved {fmtIST(cfg.updated_at)}</span>}
                </div>
                <button
                  onClick={() => save(cfg.source)}
                  disabled={busy}
                  className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50"
                  data-testid={`buyleads-save-${cfg.source}`}
                >
                  <FloppyDisk size={12} weight="bold" /> Save
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------- Leave / Holiday management (admin) ----------------
function LeaveManagementPanel() {
  const [leaves, setLeaves] = useState([]);
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ user_id: "", start_date: "", end_date: "", reason: "" });
  const [editId, setEditId] = useState(null);
  const [edit, setEdit] = useState({ start_date: "", end_date: "", reason: "" });

  const today = new Date().toISOString().slice(0, 10);

  const load = async () => {
    try {
      const [{ data: lvs }, { data: us }] = await Promise.all([
        api.get("/leaves"),
        api.get("/users"),
      ]);
      setLeaves(lvs || []);
      setUsers((us || []).filter((u) => u.role === "executive"));
    } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const addLeave = async (e) => {
    e.preventDefault();
    if (!form.user_id || !form.start_date || !form.end_date) {
      toast.error("Agent and dates are required");
      return;
    }
    if (form.start_date > form.end_date) {
      toast.error("Start date cannot be after end date");
      return;
    }
    setBusy(true);
    try {
      await api.post("/leaves", form);
      toast.success("Leave saved — agent will be logged out on next poll if active");
      setForm({ user_id: "", start_date: "", end_date: "", reason: "" });
      await load();
    } catch (e2) { toast.error(errMsg(e2)); }
    finally { setBusy(false); }
  };

  const cancelLeave = async (id) => {
    if (!window.confirm("Cancel this leave? The agent will regain access immediately.")) return;
    setBusy(true);
    try {
      await api.post(`/leaves/${id}/cancel`);
      toast.success("Leave cancelled");
      await load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const startEdit = (lv) => {
    setEditId(lv.id);
    setEdit({ start_date: lv.start_date, end_date: lv.end_date, reason: lv.reason || "" });
  };

  const saveEdit = async (id) => {
    if (edit.start_date > edit.end_date) { toast.error("Start date cannot be after end date"); return; }
    setBusy(true);
    try {
      await api.patch(`/leaves/${id}`, edit);
      toast.success("Leave updated");
      setEditId(null);
      await load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const active = leaves.filter((l) => l.is_active);
  const upcoming = leaves.filter((l) => !l.is_active && l.start_date > today);
  const past = leaves.filter((l) => !l.is_active && l.end_date < today);

  const renderRow = (lv) => (
    <div key={lv.id} className="px-5 py-3 flex flex-wrap items-center gap-3 border-b border-gray-100" data-testid={`leave-row-${lv.id}`}>
      <div className="flex-1 min-w-[200px]">
        <div className="font-semibold text-sm">
          {lv.user_name || lv.user_username || lv.user_id}
          {lv.is_active && <span className="ml-2 bg-[#E60000] text-white px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest">On leave</span>}
        </div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-mono">@{lv.user_username}</div>
      </div>
      {editId === lv.id ? (
        <>
          <input type="date" value={edit.start_date} onChange={(e) => setEdit((s) => ({ ...s, start_date: e.target.value }))} className="border border-gray-300 px-2 py-1 text-xs" data-testid={`edit-start-${lv.id}`} />
          <span className="text-gray-400">→</span>
          <input type="date" value={edit.end_date} onChange={(e) => setEdit((s) => ({ ...s, end_date: e.target.value }))} className="border border-gray-300 px-2 py-1 text-xs" data-testid={`edit-end-${lv.id}`} />
          <input type="text" placeholder="reason" value={edit.reason} onChange={(e) => setEdit((s) => ({ ...s, reason: e.target.value }))} className="border border-gray-300 px-2 py-1 text-xs flex-1 min-w-[140px]" data-testid={`edit-reason-${lv.id}`} />
          <button onClick={() => saveEdit(lv.id)} disabled={busy} className="bg-[#002FA7] hover:bg-[#002288] text-white px-2 py-1 text-[10px] uppercase tracking-widest font-bold" data-testid={`edit-save-${lv.id}`}>Save</button>
          <button onClick={() => setEditId(null)} className="border border-gray-300 px-2 py-1 text-[10px] uppercase tracking-widest font-bold">Cancel</button>
        </>
      ) : (
        <>
          <div className="text-xs font-mono">{lv.start_date} → {lv.end_date}</div>
          {lv.reason && <div className="text-xs text-gray-600 italic max-w-xs truncate">"{lv.reason}"</div>}
          <div className="flex items-center gap-2">
            <button onClick={() => startEdit(lv)} disabled={busy} className="border border-gray-300 hover:bg-gray-100 px-2 py-1 text-[10px] uppercase tracking-widest font-bold" data-testid={`leave-edit-${lv.id}`}>
              Modify
            </button>
            <button onClick={() => cancelLeave(lv.id)} disabled={busy} className="text-[#E60000] hover:bg-[#E60000] hover:text-white border border-[#E60000] px-2 py-1 text-[10px] uppercase tracking-widest font-bold" data-testid={`leave-cancel-${lv.id}`}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="border border-gray-200 bg-white" data-testid="leave-panel">
      <div className="px-5 py-4 border-b border-gray-200">
        <h2 className="font-chivo font-bold text-lg flex items-center gap-2">
          <Calendar size={18} weight="bold" /> Leave / Holiday Management
        </h2>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Mark executives on leave. They won't receive any new leads (auto / manual / PNS) and are
          soft-logged-out on their next API call. Past, current and future-dated leaves are all
          supported — modify or cancel any time.
        </p>
      </div>

      <form onSubmit={addLeave} className="px-5 py-4 border-b border-gray-200 bg-gray-50 grid grid-cols-1 md:grid-cols-5 gap-2 items-end" data-testid="leave-add-form">
        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Agent</div>
          <select required value={form.user_id} onChange={(e) => setForm((s) => ({ ...s, user_id: e.target.value }))} className="w-full border border-gray-300 px-2 py-2 text-sm" data-testid="leave-user-select">
            <option value="">— Select agent —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name} (@{u.username})</option>)}
          </select>
        </label>
        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Start</div>
          <input required type="date" value={form.start_date} onChange={(e) => setForm((s) => ({ ...s, start_date: e.target.value }))} className="w-full border border-gray-300 px-2 py-2 text-sm" data-testid="leave-start-date" />
        </label>
        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">End</div>
          <input required type="date" value={form.end_date} onChange={(e) => setForm((s) => ({ ...s, end_date: e.target.value }))} className="w-full border border-gray-300 px-2 py-2 text-sm" data-testid="leave-end-date" />
        </label>
        <label className="block md:col-span-1">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Reason (optional)</div>
          <input type="text" value={form.reason} onChange={(e) => setForm((s) => ({ ...s, reason: e.target.value }))} placeholder="e.g. wedding" className="w-full border border-gray-300 px-2 py-2 text-sm" data-testid="leave-reason" />
        </label>
        <button type="submit" disabled={busy} className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center justify-center gap-1 disabled:opacity-50" data-testid="leave-add-btn">
          <Plus size={12} weight="bold" /> Add leave
        </button>
      </form>

      {active.length > 0 && (
        <div>
          <div className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-widest text-[#E60000] font-bold">Active now ({active.length})</div>
          {active.map(renderRow)}
        </div>
      )}
      {upcoming.length > 0 && (
        <div>
          <div className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-widest text-[#002FA7] font-bold">Upcoming ({upcoming.length})</div>
          {upcoming.map(renderRow)}
        </div>
      )}
      {past.length > 0 && (
        <div>
          <div className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-widest text-gray-400 font-bold">Past ({past.length})</div>
          {past.map(renderRow)}
        </div>
      )}
      {leaves.length === 0 && (
        <div className="px-5 py-8 text-xs uppercase tracking-widest text-gray-400 font-bold text-center">No leaves on record yet.</div>
      )}
    </div>
  );
}

function EmailAutoSendPanel() {
  const [smtp, setSmtp] = useState(null);
  const [smtpForm, setSmtpForm] = useState({ host: "", port: 465, security: "ssl", email: "", password: "", from_name: "", enabled: false });
  const [revealPw, setRevealPw] = useState(false);
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [tpl, setTpl] = useState(null);
  const [tplForm, setTplForm] = useState({ subject: "", body: "", attachments: [] });
  const [savingTpl, setSavingTpl] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [uploadingAtt, setUploadingAtt] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [sendingTest, setSendingTest] = useState(false);
  const fileRef = React.useRef(null);

  // Detect HTML in the current draft and produce a preview with sample
  // variable substitution. Same heuristic as the backend.
  const bodyIsHtml = React.useMemo(() => {
    const s = (tplForm.body || "").toLowerCase();
    return /<\s*(html|body|table|div|p|h[1-6]|br|img|a|span|strong|em|ul|ol|li|tr|td|tbody)[\s>]/.test(s);
  }, [tplForm.body]);
  const previewHtml = React.useMemo(() => {
    const sample = { name: "Akash", requirement: "Pumps", phone: "+91 99999 00001", email: "akash@example.com", source: "Manual" };
    const sub = (s) => (s || "")
      .replaceAll("{{name}}", sample.name)
      .replaceAll("{{requirement}}", sample.requirement)
      .replaceAll("{{phone}}", sample.phone)
      .replaceAll("{{email}}", sample.email)
      .replaceAll("{{source}}", sample.source);
    return sub(tplForm.body);
  }, [tplForm.body]);

  const load = async () => {
    try {
      const [{ data: s }, { data: t }] = await Promise.all([
        api.get("/settings/email"),
        api.get("/settings/email-template"),
      ]);
      setSmtp(s);
      setSmtpForm({
        host: s.host || "smtp.hostinger.com",
        port: s.port || 465,
        security: s.security || "ssl",
        email: s.email || "",
        password: "", // never prefill — keeps current if blank
        from_name: s.from_name || "",
        enabled: !!s.enabled,
      });
      setTpl(t);
      setTplForm({
        subject: t.subject || "",
        body: t.body || "",
        attachments: t.attachments || [],
      });
    } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const saveSmtp = async (e) => {
    e?.preventDefault?.();
    setSavingSmtp(true);
    try {
      const patch = { ...smtpForm };
      if (!patch.password) delete patch.password; // keep existing
      patch.port = Number(patch.port) || 465;
      await api.put("/settings/email", patch);
      toast.success("SMTP settings saved");
      await load();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setSavingSmtp(false); }
  };

  const saveTpl = async (e) => {
    e?.preventDefault?.();
    setSavingTpl(true);
    try {
      await api.put("/settings/email-template", tplForm);
      toast.success("Template saved");
      await load();
    } catch (err) { toast.error(errMsg(err)); }
    finally { setSavingTpl(false); }
  };

  const onAttach = async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { toast.error("Max 25 MB per attachment"); return; }
    setUploadingAtt(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "document");
      const { data } = await api.post("/chatflows/upload-media", fd);
      // Extract stored_name from absolute URL: /api/media/<stored_name>
      const stored = (data.url || "").split("/api/media/").pop();
      const next = [
        ...(tplForm.attachments || []),
        { stored_name: stored, original_filename: file.name, mime_type: file.type || "application/octet-stream" },
      ];
      setTplForm((f) => ({ ...f, attachments: next }));
      // Persist immediately so the attachment survives a page refresh / SMTP save reload.
      // Sends current subject/body together so we don't accidentally clear them.
      try {
        await api.put("/settings/email-template", { subject: tplForm.subject, body: tplForm.body, attachments: next });
        toast.success(`${file.name} attached and saved`);
      } catch (saveErr) {
        toast.error(errMsg(saveErr, "Attached locally but auto-save failed — click Save template"));
      }
    } catch (err) { toast.error(errMsg(err, "Upload failed")); }
    finally {
      setUploadingAtt(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeAtt = async (idx) => {
    const next = (tplForm.attachments || []).filter((_, i) => i !== idx);
    setTplForm((f) => ({ ...f, attachments: next }));
    // Persist immediately so the removal survives a page refresh.
    try {
      await api.put("/settings/email-template", { subject: tplForm.subject, body: tplForm.body, attachments: next });
      toast.success("Attachment removed");
    } catch (err) {
      toast.error(errMsg(err, "Removed locally but auto-save failed — click Save template"));
    }
  };

  const testSend = async () => {
    if (!testTo.trim()) { toast.error("Enter a recipient email"); return; }
    setSendingTest(true);
    try {
      await api.post("/settings/email/test-send", { to: testTo.trim() });
      toast.success(`Test email sent to ${testTo.trim()}`);
    } catch (err) { toast.error(errMsg(err, "Test send failed")); }
    finally { setSendingTest(false); }
  };

  if (!smtp || !tpl) return <div className="border border-gray-200 bg-white p-5 text-xs uppercase tracking-widest text-gray-400">Loading email settings…</div>;

  return (
    <div className="border border-gray-200 bg-white" data-testid="email-autosend-panel">
      <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h2 className="font-chivo font-bold text-lg flex items-center gap-2"><EnvelopeSimple size={18} weight="bold" /> Email Auto-Send</h2>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            Sends a configured email to every lead's email address — at lead creation AND whenever a new email is added later.
            Each address is mailed exactly once per lead.
          </p>
        </div>
        <span className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-widest font-bold ${smtpForm.enabled ? "bg-[#008A00] text-white" : "bg-gray-200 text-gray-700"}`}>
          {smtpForm.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      {/* SMTP form */}
      <form onSubmit={saveSmtp} className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-4 border-b border-gray-200">
        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">SMTP Host</div>
          <input value={smtpForm.host} onChange={(e) => setSmtpForm((f) => ({ ...f, host: e.target.value }))}
            placeholder="smtp.hostinger.com"
            className="w-full border border-gray-300 px-3 py-2 text-sm font-mono"
            data-testid="email-smtp-host" />
        </label>
        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Port</div>
          <input type="number" value={smtpForm.port} onChange={(e) => setSmtpForm((f) => ({ ...f, port: e.target.value }))}
            className="w-full border border-gray-300 px-3 py-2 text-sm font-mono" data-testid="email-smtp-port" />
        </label>
        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Security</div>
          <select value={smtpForm.security} onChange={(e) => setSmtpForm((f) => ({ ...f, security: e.target.value }))}
            className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="email-smtp-security">
            <option value="ssl">SSL (465)</option>
            <option value="tls">TLS / STARTTLS (587)</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">From email</div>
          <input type="email" value={smtpForm.email} onChange={(e) => setSmtpForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="aroma@citspray.com"
            className="w-full border border-gray-300 px-3 py-2 text-sm font-mono" data-testid="email-smtp-email" />
        </label>
        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">From name (optional)</div>
          <input value={smtpForm.from_name} onChange={(e) => setSmtpForm((f) => ({ ...f, from_name: e.target.value }))}
            placeholder="Aroma"
            className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="email-smtp-fromname" />
        </label>
        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1 flex items-center justify-between">
            <span>Password</span>
            {smtp.has_password && <span className="text-gray-400 normal-case">current: <span className="font-mono">{smtp.password_masked}</span></span>}
          </div>
          <div className="flex items-center gap-2">
            <input type={revealPw ? "text" : "password"} value={smtpForm.password}
              onChange={(e) => setSmtpForm((f) => ({ ...f, password: e.target.value }))}
              placeholder={smtp.has_password ? "Leave blank to keep current" : "Enter password"}
              className="flex-1 border border-gray-300 px-3 py-2 text-sm font-mono"
              data-testid="email-smtp-password" />
            <button type="button" onClick={() => setRevealPw((v) => !v)} className="border border-gray-300 p-2" title="Reveal">
              {revealPw ? <EyeSlash size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </label>
        <label className="md:col-span-2 flex items-center gap-2">
          <input type="checkbox" checked={smtpForm.enabled} onChange={(e) => setSmtpForm((f) => ({ ...f, enabled: e.target.checked }))} data-testid="email-smtp-enabled" />
          <span className="text-sm">Enable auto-send</span>
        </label>
        <div className="md:col-span-2 flex items-center justify-end gap-2">
          <button type="submit" disabled={savingSmtp} className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50" data-testid="email-smtp-save-btn">
            <FloppyDisk size={12} weight="bold" /> {savingSmtp ? "Saving…" : "Save SMTP"}
          </button>
        </div>
      </form>

      {/* Template form */}
      <form onSubmit={saveTpl} className="px-5 py-4 space-y-3 border-b border-gray-200">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Email template</div>
        <div className="text-xs text-gray-500">
          Variables: <span className="kbd">{"{{name}}"}</span> <span className="kbd">{"{{requirement}}"}</span> <span className="kbd">{"{{phone}}"}</span> <span className="kbd">{"{{email}}"}</span> <span className="kbd">{"{{source}}"}</span>
          <span className="ml-2 text-gray-400">— HTML supported (auto-detected). Variables work inside HTML too.</span>
        </div>
        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Subject</div>
          <input value={tplForm.subject} onChange={(e) => setTplForm((f) => ({ ...f, subject: e.target.value }))}
            placeholder="Thank you for your enquiry, {{name}}"
            className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="email-tpl-subject" />
        </label>
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Body</div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setShowPreview(false)} className={`px-2 py-1 text-[10px] uppercase tracking-widest font-bold border ${!showPreview ? "bg-gray-900 text-white border-gray-900" : "border-gray-300 hover:bg-gray-100"}`} data-testid="email-tpl-tab-edit">Edit</button>
              <button type="button" onClick={() => setShowPreview(true)} className={`px-2 py-1 text-[10px] uppercase tracking-widest font-bold border ${showPreview ? "bg-gray-900 text-white border-gray-900" : "border-gray-300 hover:bg-gray-100"}`} data-testid="email-tpl-tab-preview">Preview</button>
            </div>
          </div>
          {showPreview ? (
            <div className="border border-gray-300 bg-white" data-testid="email-tpl-preview">
              {bodyIsHtml ? (
                <iframe
                  title="email-preview"
                  srcDoc={previewHtml}
                  sandbox=""
                  className="w-full"
                  style={{ height: 480, border: 0 }}
                  data-testid="email-tpl-preview-iframe"
                />
              ) : (
                <div className="p-4 text-sm whitespace-pre-wrap font-mono">{previewHtml || <span className="text-gray-400 italic">(empty)</span>}</div>
              )}
              <div className="px-3 py-1.5 border-t border-gray-200 text-[10px] uppercase tracking-widest text-gray-400 bg-gray-50">
                Detected: {bodyIsHtml ? "HTML" : "Plain text"} · variables substituted with sample values (Akash, Pumps, etc.)
              </div>
            </div>
          ) : (
            <textarea rows={12} value={tplForm.body} onChange={(e) => setTplForm((f) => ({ ...f, body: e.target.value }))}
              placeholder="Hi {{name}},&#10;&#10;Thanks for your enquiry about {{requirement}}…&#10;&#10;HTML works too — paste full <table>…</table> markup."
              className="w-full border border-gray-300 px-3 py-2 text-sm font-mono whitespace-pre-wrap"
              data-testid="email-tpl-body" />
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Attachments ({tplForm.attachments.length})</div>
          {tplForm.attachments.length > 0 && (
            <ul className="space-y-1 mb-2" data-testid="email-tpl-attachments">
              {tplForm.attachments.map((a, i) => (
                <li key={i} className="flex items-center gap-2 text-xs border border-gray-200 px-2 py-1">
                  <Paperclip size={11} className="text-[#475569] shrink-0" />
                  <span className="font-mono truncate flex-1">{a.original_filename || a.stored_name}</span>
                  <button type="button" onClick={() => removeAtt(i)} className="text-[#E60000] hover:underline text-[10px] uppercase tracking-widest font-bold" data-testid={`email-tpl-att-remove-${i}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input ref={fileRef} type="file" onChange={onAttach} disabled={uploadingAtt} className="hidden" id="email-tpl-att-file" data-testid="email-tpl-att-input" />
          <label htmlFor="email-tpl-att-file" className="inline-block border border-gray-300 hover:border-gray-900 cursor-pointer px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold">
            {uploadingAtt ? "Uploading…" : "Add attachment"}
          </label>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button type="submit" disabled={savingTpl} className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50" data-testid="email-tpl-save-btn">
            <FloppyDisk size={12} weight="bold" /> {savingTpl ? "Saving…" : "Save template"}
          </button>
        </div>
      </form>

      {/* Test send */}
      <div className="px-5 py-4 flex items-center gap-2 flex-wrap bg-gray-50">
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mr-1">Test send:</div>
        <input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="recipient@example.com"
          className="border border-gray-300 px-3 py-2 text-sm font-mono flex-1 min-w-[220px]" data-testid="email-test-to" />
        <button onClick={testSend} disabled={sendingTest || !smtpForm.email} className="border border-gray-900 hover:bg-gray-900 hover:text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50" data-testid="email-test-send-btn">
          <PaperPlaneTilt size={12} weight="bold" /> Send test
        </button>
      </div>
    </div>
  );
}

