import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { FloppyDisk, ArrowCounterClockwise, Eye, EyeSlash, ShieldCheck, Copy, Link as LinkIcon } from "@phosphor-icons/react";

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
    <div className="p-6 md:p-8 space-y-6 max-w-4xl">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Admin</div>
        <h1 className="font-chivo font-black text-3xl md:text-4xl">Settings</h1>
      </div>

      {hooks && <WebhooksPanel hooks={hooks} />}

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
    { ...hooks.gmail,                key: "gmail" },
    { ...hooks.justdial_manual_ingest, key: "justdial" },
  ].filter(Boolean);
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

