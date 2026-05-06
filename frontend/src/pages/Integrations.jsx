import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import { ArrowSquareOut, Plug, ArrowsClockwise, X, EnvelopeSimple, CheckCircle, Warning } from "@phosphor-icons/react";
import { fmtIST } from "@/lib/format";

const SLOT_LABELS = { primary: "Primary", secondary: "Secondary" };

export default function Integrations() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState({});

  const load = async () => {
    try { const { data } = await api.get("/integrations/gmail/status"); setStatus(data); }
    catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  // Handle redirect-back from Google OAuth
  useEffect(() => {
    const s = params.get("gmail_status");
    if (!s) return;
    const slot = params.get("slot") || "primary";
    if (s === "connected") toast.success(`Gmail (${SLOT_LABELS[slot] || slot}) connected: ${params.get("email") || ""}`);
    else if (s === "error") {
      const reason = params.get("reason") || "unknown";
      toast.error(reason === "duplicate_account"
        ? `That Gmail account is already connected on the other slot.`
        : `Gmail connect failed: ${reason}`);
    }
    setParams({}, { replace: true });
    load();
  }, [params, setParams]);

  const setSlotBusy = (slot, v) => setBusy((b) => ({ ...b, [slot]: v }));

  const connect = async (slot) => {
    setSlotBusy(slot, true);
    try {
      const { data } = await api.get(`/integrations/gmail/auth/init?slot=${slot}`);
      window.location.href = data.auth_url;
    } catch (e) { toast.error(errMsg(e)); setSlotBusy(slot, false); }
  };

  const disconnect = async (slot) => {
    if (!window.confirm(`Disconnect ${SLOT_LABELS[slot]} Gmail? Justdial leads from this inbox will stop being pulled.`)) return;
    setSlotBusy(slot, true);
    try {
      await api.post(`/integrations/gmail/disconnect?slot=${slot}`);
      toast.success(`${SLOT_LABELS[slot]} Gmail disconnected`);
      load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSlotBusy(slot, false); }
  };

  const syncNow = async (slot) => {
    setSlotBusy(slot, true);
    try {
      const { data } = await api.post(`/integrations/gmail/sync-now?slot=${slot}`);
      const lp = data.last_poll || {};
      toast.success(`${SLOT_LABELS[slot]}: fetched ${lp.fetched ?? 0}, ingested ${lp.ingested ?? 0}, dupe ${lp.skipped_dupe ?? 0}, errors ${lp.errors ?? 0}`);
      load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSlotBusy(slot, false); }
  };

  const syncAll = async () => {
    setSlotBusy("all", true);
    try {
      const { data } = await api.post("/integrations/gmail/sync-now");
      const lp = data.last_poll || {};
      toast.success(`All accounts — fetched ${lp.fetched ?? 0}, ingested ${lp.ingested ?? 0}, dupe ${lp.skipped_dupe ?? 0}, errors ${lp.errors ?? 0}`);
      load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSlotBusy("all", false); }
  };

  const slots = status?.slots || {};

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Sources</div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Integrations</h1>
        </div>
        {status?.enabled && (slots.primary?.connected || slots.secondary?.connected) && (
          <button onClick={syncAll} disabled={!!busy.all}
            className="border border-gray-900 px-3 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-900 hover:text-white flex items-center gap-2 disabled:opacity-50"
            data-testid="gmail-sync-all-btn">
            <ArrowsClockwise size={14} weight="bold" /> {busy.all ? "Syncing…" : "Sync all accounts"}
          </button>
        )}
      </div>

      {/* Gmail / Justdial — Dual slot */}
      <div className="border border-gray-200 bg-white" data-testid="gmail-integration-card">
        <div className="flex items-start gap-4 p-5 border-b border-gray-200">
          <div className="w-12 h-12 bg-[#E60000] flex items-center justify-center shrink-0">
            <EnvelopeSimple size={22} weight="bold" color="white" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-chivo font-bold text-xl">Gmail · Justdial Pull</h2>
            <p className="text-sm text-gray-600 mt-1 max-w-3xl">
              Connect up to <b>two</b> Gmail accounts that receive Justdial enquiry notifications.
              The system polls each inbox every <b>{status?.poll_interval_seconds ?? "?"}</b>s for unread emails matching{" "}
              <span className="kbd">{status?.query || "from:instantemail@justdial.com"}</span>,
              parses them, de-duplicates by profile URL + mobile + gmail-id, creates leads and marks them read.
              Both accounts share the same extraction logic and assignment rules.
            </p>
            <PollIntervalEditor currentSeconds={status?.poll_interval_seconds} onSaved={load} />
          </div>
        </div>

        {!status?.enabled && (
          <div className="p-5 text-sm text-gray-600">
            <div className="text-[#E60000] font-bold uppercase tracking-widest text-[10px] mb-1">Reason</div>
            {status?.reason || "Configuration missing"}
          </div>
        )}

        {status?.enabled && (
          <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-200">
            {["primary", "secondary"].map((slot) => (
              <SlotPanel
                key={slot}
                slot={slot}
                status={status}
                info={slots[slot] || {}}
                busy={!!busy[slot]}
                onConnect={() => connect(slot)}
                onDisconnect={() => disconnect(slot)}
                onSyncNow={() => syncNow(slot)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Read-only preview of other sources */}
      <div className="grid md:grid-cols-2 gap-4">
        <SourceTile name="IndiaMART Webhook" status="Live" desc={
          <>POST <span className="kbd">/api/webhooks/indiamart</span> — paste this in IndiaMART Lead Manager → Push API.</>
        } />
        <SourceTile name="WhatsApp Cloud API" status="Live" desc={
          <>Configured at <span className="kbd">/templates</span>. Inbound messages auto-create leads.</>
        } />
      </div>
    </div>
  );
}

function SlotPanel({ slot, status, info, busy, onConnect, onDisconnect, onSyncNow }) {
  const label = SLOT_LABELS[slot];
  const connected = !!info.connected;
  return (
    <div className="p-5 space-y-3" data-testid={`gmail-slot-${slot}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Gmail · {label}</div>
          <div className="mt-0.5 text-sm font-semibold break-all" data-testid={`gmail-slot-email-${slot}`}>
            {connected ? (info.email || "—") : <span className="text-gray-400 italic">Not connected</span>}
          </div>
        </div>
        {connected ? (
          <Pill tone="good" icon={CheckCircle}>Connected</Pill>
        ) : (
          <Pill tone="warn" icon={Warning}>Not connected</Pill>
        )}
      </div>

      {!connected && (
        <>
          <div className="border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 leading-relaxed">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Redirect URI</div>
            <div className="font-mono bg-white border border-gray-300 p-2 break-all" data-testid={`redirect-uri-display-${slot}`}>
              {status.redirect_uri}
            </div>
            <div className="mt-2">Ensure this URI is present under <b>Authorized redirect URIs</b> in your Google Cloud OAuth client, then click Connect.</div>
          </div>
          <button onClick={onConnect} disabled={busy}
            className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-2 disabled:opacity-50"
            data-testid={`connect-gmail-btn-${slot}`}>
            <Plug size={14} weight="bold" /> {busy ? "Redirecting…" : `Connect ${label} Gmail`}
          </button>
        </>
      )}

      {connected && (
        <>
          <div className="grid grid-cols-2 gap-0 border border-gray-200">
            <Cell k="Connected at" v={fmtIST(info.connected_at)} />
            <Cell k="Token expires" v={info.expires_at ? fmtIST(info.expires_at) : "—"} />
          </div>
          {info.last_poll ? (
            <div className="border border-gray-200 bg-gray-50 p-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm" data-testid={`last-poll-stats-${slot}`}>
              <Stat k="Last run" v={info.last_poll.ran_at ? fmtIST(info.last_poll.ran_at) : "—"} />
              <Stat k="Fetched" v={info.last_poll.fetched ?? 0} />
              <Stat k="Ingested" v={info.last_poll.ingested ?? 0} tone={info.last_poll.ingested ? "good" : null} />
              <Stat k="Errors" v={info.last_poll.errors ?? 0} tone={info.last_poll.errors ? "bad" : null} />
              {info.last_poll.skipped_dupe > 0 && (
                <div className="col-span-full text-xs text-gray-600">Skipped as duplicate: <b>{info.last_poll.skipped_dupe}</b></div>
              )}
              {info.last_poll.fatal && (
                <div className="col-span-full text-xs text-[#E60000]">Fatal: {info.last_poll.fatal}</div>
              )}
            </div>
          ) : (
            <div className="text-xs uppercase tracking-widest text-gray-400">No poll has run yet — click Sync now.</div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={onSyncNow} disabled={busy}
              className="border border-gray-900 px-3 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-900 hover:text-white flex items-center gap-2 disabled:opacity-50"
              data-testid={`gmail-sync-now-btn-${slot}`}>
              <ArrowsClockwise size={14} weight="bold" /> {busy ? "Syncing…" : "Sync now"}
            </button>
            <button onClick={onDisconnect} disabled={busy}
              className="border border-[#E60000] text-[#E60000] hover:bg-[#E60000] hover:text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-2 disabled:opacity-50"
              data-testid={`gmail-disconnect-btn-${slot}`}>
              <Plug size={14} weight="bold" /> Disconnect
            </button>
            <a href="https://mail.google.com/" target="_blank" rel="noreferrer"
              className="ml-auto text-[10px] uppercase tracking-widest font-bold text-gray-500 hover:text-gray-900 flex items-center gap-1">
              Open Gmail <ArrowSquareOut size={12} />
            </a>
          </div>
        </>
      )}
    </div>
  );
}

function Pill({ tone, icon: Icon, children }) {
  const cls = tone === "good"
    ? "bg-[#008A00] text-white"
    : tone === "warn"
      ? "bg-[#FFCC00] text-gray-900"
      : "bg-[#E60000] text-white";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-widest font-bold ${cls}`}>
      <Icon size={12} weight="bold" /> {children}
    </span>
  );
}

function Cell({ k, v, mono }) {
  return (
    <div className="p-3 border-r last:border-r-0 border-gray-200">
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{k}</div>
      <div className={`mt-1 ${mono ? "font-mono text-xs" : "text-sm font-semibold"} break-all`}>{v ?? "—"}</div>
    </div>
  );
}

function Stat({ k, v, tone }) {
  const t = tone === "good" ? "text-[#008A00]" : tone === "bad" ? "text-[#E60000]" : "text-gray-900";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{k}</div>
      <div className={`mt-1 font-chivo font-black text-xl ${t}`}>{v}</div>
    </div>
  );
}

function SourceTile({ name, status, desc }) {
  return (
    <div className="border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <div className="font-chivo font-bold">{name}</div>
        <span className="text-[10px] uppercase tracking-widest font-bold text-[#008A00]">{status}</span>
      </div>
      <div className="mt-2 text-sm text-gray-600">{desc}</div>
    </div>
  );
}

function PollIntervalEditor({ currentSeconds, onSaved }) {
  const [val, setVal] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setVal(String(currentSeconds ?? 60));
  }, [currentSeconds]);

  const save = async () => {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 10) {
      toast.error("Interval must be at least 10 seconds");
      return;
    }
    setSaving(true);
    try {
      await api.put("/settings/gmail-poll", { interval_seconds: Math.floor(n) });
      toast.success(`Polling every ${Math.floor(n)}s`);
      setEditing(false);
      await onSaved?.();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  if (!editing) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-gray-500">Polling interval:</span>
        <span className="font-mono font-bold text-gray-900">{currentSeconds ?? "—"}s</span>
        <button onClick={() => setEditing(true)} className="text-[#002FA7] hover:underline text-[10px] uppercase tracking-widest font-bold" data-testid="gmail-poll-edit-btn">
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="mt-2 flex items-center gap-2 text-xs flex-wrap">
      <span className="text-gray-500">Polling interval:</span>
      <input type="number" min={10} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()}
        className="border border-gray-300 px-2 py-1 text-xs w-24 font-mono" data-testid="gmail-poll-input" />
      <span className="text-gray-500">seconds</span>
      <button onClick={save} disabled={saving} className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-1 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="gmail-poll-save-btn">
        {saving ? "Saving…" : "Save"}
      </button>
      <button onClick={() => setEditing(false)} className="text-gray-400 hover:text-gray-900 text-[10px] uppercase tracking-widest font-bold" data-testid="gmail-poll-cancel-btn">
        Cancel
      </button>
      <span className="text-gray-400 ml-2">min 10s · default 60s</span>
    </div>
  );
}

