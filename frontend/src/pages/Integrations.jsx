import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import { ArrowSquareOut, Plug, ArrowsClockwise, X, EnvelopeSimple, CheckCircle, Warning } from "@phosphor-icons/react";
import { fmtIST } from "@/lib/format";

export default function Integrations() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { const { data } = await api.get("/integrations/gmail/status"); setStatus(data); }
    catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  // Handle redirect-back from Google OAuth
  useEffect(() => {
    const s = params.get("gmail_status");
    if (!s) return;
    if (s === "connected") toast.success(`Gmail connected: ${params.get("email") || ""}`);
    else if (s === "error") toast.error(`Gmail connect failed: ${params.get("reason") || "unknown"}`);
    setParams({}, { replace: true });
    load();
  }, [params, setParams]);

  const connect = async () => {
    setBusy(true);
    try {
      const { data } = await api.get("/integrations/gmail/auth/init");
      window.location.href = data.auth_url;
    } catch (e) { toast.error(errMsg(e)); setBusy(false); }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect Gmail? Justdial leads will stop being pulled automatically.")) return;
    setBusy(true);
    try { await api.post("/integrations/gmail/disconnect"); toast.success("Gmail disconnected"); load(); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/integrations/gmail/sync-now");
      const lp = data.last_poll || {};
      toast.success(`Synced — fetched ${lp.fetched ?? 0}, ingested ${lp.ingested ?? 0}, errors ${lp.errors ?? 0}`);
      load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="p-6 md:p-8 space-y-6">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Sources</div>
        <h1 className="font-chivo font-black text-3xl md:text-4xl">Integrations</h1>
      </div>

      {/* Gmail / Justdial */}
      <div className="border border-gray-200 bg-white" data-testid="gmail-integration-card">
        <div className="flex items-start justify-between p-5 border-b border-gray-200">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-[#E60000] flex items-center justify-center shrink-0">
              <EnvelopeSimple size={22} weight="bold" color="white" />
            </div>
            <div>
              <h2 className="font-chivo font-bold text-xl">Gmail · Justdial Pull</h2>
              <p className="text-sm text-gray-600 mt-1 max-w-2xl">
                Connect a Gmail account that receives Justdial enquiry notifications.
                The system polls every {status?.poll_interval_minutes ?? "?"} minute(s) for unread emails matching{" "}
                <span className="kbd">{status?.query || "from:instantemail@justdial.com"}</span>,
                parses them, creates leads and marks them read.
              </p>
            </div>
          </div>
          {status?.connected ? (
            <Pill tone="good" icon={CheckCircle}>Connected</Pill>
          ) : status?.enabled ? (
            <Pill tone="warn" icon={Warning}>Not connected</Pill>
          ) : (
            <Pill tone="bad" icon={X}>Disabled</Pill>
          )}
        </div>

        {!status?.enabled && (
          <div className="p-5 text-sm text-gray-600">
            <div className="text-[#E60000] font-bold uppercase tracking-widest text-[10px] mb-1">Reason</div>
            {status?.reason || "Configuration missing"}
          </div>
        )}

        {status?.enabled && !status?.connected && (
          <div className="p-5 space-y-4">
            <div className="border border-gray-200 bg-gray-50 p-4 text-sm space-y-2">
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Before you connect</div>
              <ol className="list-decimal pl-5 space-y-1 text-gray-700">
                <li>Open Google Cloud Console → APIs &amp; Services → Credentials → your OAuth 2.0 Client.</li>
                <li>Under <span className="kbd">Authorized redirect URIs</span>, add this URL exactly:</li>
                <li>
                  <div className="font-mono text-xs bg-white border border-gray-300 p-2 break-all" data-testid="redirect-uri-display">
                    {status.redirect_uri}
                  </div>
                </li>
                <li>Save in Google Cloud Console, then click <b>Connect Gmail</b> below.</li>
                <li>On the consent screen, sign in with the Gmail account that receives the Justdial notifications and grant access.</li>
              </ol>
            </div>
            <button onClick={connect} disabled={busy}
              className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-2 disabled:opacity-50"
              data-testid="connect-gmail-btn">
              <Plug size={14} weight="bold" /> {busy ? "Redirecting…" : "Connect Gmail"}
            </button>
          </div>
        )}

        {status?.enabled && status?.connected && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-0 border-b border-gray-200">
              <Cell k="Connected account" v={status.email} mono />
              <Cell k="Connected at" v={fmtIST(status.connected_at)} />
              <Cell k="Token expires" v={status.expires_at ? fmtIST(status.expires_at) : "—"} />
              <Cell k="Poll interval" v={`${status.poll_interval_minutes} min`} />
            </div>
            <div className="p-5 space-y-4">
              {status.last_poll ? (
                <div className="border border-gray-200 bg-gray-50 p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm" data-testid="last-poll-stats">
                  <Stat k="Last run" v={fmtIST(status.last_poll.ran_at)} />
                  <Stat k="Fetched" v={status.last_poll.fetched ?? 0} />
                  <Stat k="Ingested" v={status.last_poll.ingested ?? 0} tone={status.last_poll.ingested ? "good" : null} />
                  <Stat k="Errors" v={status.last_poll.errors ?? 0} tone={status.last_poll.errors ? "bad" : null} />
                  {status.last_poll.fatal && (
                    <div className="col-span-full text-xs text-[#E60000]">Fatal: {status.last_poll.fatal}</div>
                  )}
                </div>
              ) : (
                <div className="text-xs uppercase tracking-widest text-gray-400">No poll has run yet — click Sync now.</div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={syncNow} disabled={busy}
                  className="border border-gray-900 px-3 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-900 hover:text-white flex items-center gap-2 disabled:opacity-50"
                  data-testid="gmail-sync-now-btn">
                  <ArrowsClockwise size={14} weight="bold" /> {busy ? "Syncing…" : "Sync now"}
                </button>
                <button onClick={disconnect} disabled={busy}
                  className="border border-[#E60000] text-[#E60000] hover:bg-[#E60000] hover:text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-2 disabled:opacity-50"
                  data-testid="gmail-disconnect-btn">
                  <Plug size={14} weight="bold" /> Disconnect
                </button>
                <a href="https://mail.google.com/" target="_blank" rel="noreferrer"
                  className="ml-auto text-[10px] uppercase tracking-widest font-bold text-gray-500 hover:text-gray-900 flex items-center gap-1">
                  Open Gmail <ArrowSquareOut size={12} />
                </a>
              </div>
            </div>
          </>
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
    <div className="p-4 border-r last:border-r-0 border-gray-200">
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
      <div className={`mt-1 font-chivo font-black text-2xl ${t}`}>{v}</div>
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
