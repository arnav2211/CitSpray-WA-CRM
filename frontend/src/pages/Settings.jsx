import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { FloppyDisk, ArrowCounterClockwise, Eye, EyeSlash, ShieldCheck, Copy, Link as LinkIcon, Phone, Plus, Trash } from "@phosphor-icons/react";

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

      <ExportersIndiaPanel onChanged={load} />

      <CallRoutingPanel />

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
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const load = async () => {
    try {
      const { data } = await api.get("/settings/exportersindia");
      setCfg(data);
      setKey("");
    } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);
  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast.success(`${label} copied`); }
    catch { toast.error("Copy failed — please copy manually"); }
  };
  const save = async (clear = false) => {
    setSaving(true);
    try {
      await api.put("/settings/exportersindia", { api_key: clear ? "" : key.trim() });
      toast.success(clear ? "Key cleared" : "API key saved");
      await load();
      onChanged?.();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };
  if (!cfg) return null;
  return (
    <div className="border border-gray-200 bg-white" data-testid="exportersindia-panel">
      <div className="px-5 py-4 border-b border-gray-200">
        <h2 className="font-chivo font-bold text-lg flex items-center gap-2"><ShieldCheck size={18} weight="bold" /> ExportersIndia API key</h2>
        <p className="text-xs text-gray-500 mt-1">
          Paste the API key that ExportersIndia issued for your account. Once saved, the webhook
          only accepts payloads where the URL includes <span className="kbd">?key=…</span>.
        </p>
      </div>
      <div className="p-5 space-y-4">
        <div className="bg-gray-50 border border-gray-200 p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Current key</div>
          <div className="font-mono text-sm">{cfg.has_key ? cfg.api_key_masked : <span className="text-gray-400">Not set — webhook currently public</span>}</div>
        </div>
        <label className="block">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">New key</div>
          <div className="flex items-stretch gap-2">
            <input
              type={reveal ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Paste API key (e.g. bDE1QTVzaGUxYUU1UlRvK0JiU0REZz09)"
              className="flex-1 border border-gray-300 px-3 py-2 text-sm font-mono"
              data-testid="exportersindia-api-key-input"
            />
            <button type="button" onClick={() => setReveal(v => !v)} className="border border-gray-300 px-3 py-2 text-gray-700 hover:bg-gray-50" title={reveal ? "Hide" : "Reveal"}>
              {reveal ? <EyeSlash size={16} weight="bold" /> : <Eye size={16} weight="bold" />}
            </button>
            <button type="button" onClick={() => save(false)} disabled={!key.trim() || saving}
              className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50"
              data-testid="exportersindia-save-key-btn">
              <FloppyDisk size={14} weight="bold" /> {saving ? "Saving…" : "Save"}
            </button>
            {cfg.has_key && (
              <button type="button" onClick={() => { if (window.confirm("Clear the API key? Webhook will become public again.")) save(true); }}
                disabled={saving} className="border border-[#E60000] text-[#E60000] hover:bg-[#E60000] hover:text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold" data-testid="exportersindia-clear-key-btn">
                Clear
              </button>
            )}
          </div>
        </label>
        {cfg.has_key && (
          <div className="border border-[#008A00] bg-[#F0FDF4] p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-widest text-[#008A00] font-bold">
                Full integration URL (paste this on ExportersIndia)
              </div>
              <button type="button" onClick={() => copy(cfg.full_integration_url, "Integration URL")}
                className="text-[10px] uppercase tracking-widest text-[#002FA7] hover:underline flex items-center gap-1"
                data-testid="exportersindia-copy-url-btn">
                <Copy size={12} weight="bold" /> Copy
              </button>
            </div>
            <div className="font-mono text-xs break-all bg-white border border-gray-200 p-2">
              {cfg.full_integration_url}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

