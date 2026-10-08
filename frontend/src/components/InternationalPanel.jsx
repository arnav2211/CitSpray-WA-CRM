import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { Globe, UsersThree, PencilSimple, Copy, Clock } from "@phosphor-icons/react";

/* International section (sidebar → International): team panel with today's
   presence + equal-share counts, tabs, manual entry and scraper CSV import.
   Leads themselves are listed by pages/Leads.jsx in `international` mode. */

export const INTL_TABS = [
  { k: "all", label: "All international" },
  { k: "scraper", label: "Scraper" },
  { k: "manual", label: "Manual" },
  { k: "waiting", label: "Waiting", adminOnly: true },
];

const CHANNEL_LABEL = { scraper: "Scraper", manual: "Manual" };

// Calling codes for the country picker (manual entry + scraper CSV import).
export const COUNTRY_CODES = [
  ["UAE", "971"], ["Saudi Arabia", "966"], ["Oman", "968"], ["Qatar", "974"], ["Kuwait", "965"], ["Bahrain", "973"],
  ["USA", "1"], ["Canada", "1"], ["UK", "44"], ["Germany", "49"], ["France", "33"], ["Spain", "34"], ["Italy", "39"],
  ["Netherlands", "31"], ["Turkey", "90"], ["Egypt", "20"], ["Nigeria", "234"], ["Ghana", "233"], ["Kenya", "254"],
  ["Tanzania", "255"], ["South Africa", "27"], ["Bangladesh", "880"], ["Nepal", "977"], ["Sri Lanka", "94"],
  ["Vietnam", "84"], ["Indonesia", "62"], ["Malaysia", "60"], ["Singapore", "65"], ["Thailand", "66"],
  ["Australia", "61"], ["New Zealand", "64"], ["Mexico", "52"], ["Brazil", "55"], ["Colombia", "57"],
];

const STATE_CLS = {
  present: "bg-[#E8F5E9] text-[#008A00] border-[#008A00]",
  punched_out: "bg-[#FFF4E5] text-[#B85F00] border-[#E67E00]",
  on_leave: "bg-[#FDECEC] text-[#B00000] border-[#E60000]",
  not_in: "bg-gray-100 text-gray-600 border-gray-300",
};

export function IntlTabs({ tab, onTab, isAdmin, pending }) {
  return (
    <div className="flex flex-wrap gap-1" data-testid="intl-tabs">
      {INTL_TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
        <button key={t.k} onClick={() => onTab(t.k)} data-testid={`intl-tab-${t.k}`}
          className={`px-3 py-2 text-[10px] uppercase tracking-widest font-bold border ${
            tab === t.k ? "bg-[#002FA7] text-white border-[#002FA7]" : "bg-white border-gray-300 text-gray-600 hover:border-gray-900"}`}>
          {t.label}
          {t.k === "waiting" && pending > 0 && (
            <span className="ml-1.5 bg-[#E67E00] text-white rounded-full px-1.5">{pending}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function IntlTeamPanel({ isAdmin, refreshKey, onInfo }) {
  const [info, setInfo] = useState(null);
  const [editing, setEditing] = useState(false);
  const [sel, setSel] = useState([]);
  const [saving, setSaving] = useState(false);
  const [showFeed, setShowFeed] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get("/international/team");
      setInfo(data);
      onInfo && onInfo(data);
    } catch { /* panel is informational */ }
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
    // eslint-disable-next-line
  }, [refreshKey]);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put("/international/team", { member_ids: sel });
      setInfo(data);
      onInfo && onInfo(data);
      setEditing(false);
      toast.success("International team updated");
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  const copy = (txt) => { navigator.clipboard?.writeText(txt); toast.success("Copied"); };

  if (!info) return null;
  const members = info.members || [];
  return (
    <div className="border border-gray-200 bg-white" data-testid="intl-team-panel">
      <div className="px-4 py-2.5 border-b border-gray-200 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
          <UsersThree size={14} /> International team · today
        </div>
        <div className="flex items-center gap-2">
          {info.pending > 0 && (
            <span className="text-[10px] uppercase tracking-widest font-bold text-[#B85F00] flex items-center gap-1" data-testid="intl-pending">
              <Clock size={12} weight="bold" /> {info.pending} waiting for the team to punch in
            </span>
          )}
          {isAdmin && !editing && (
            <button onClick={() => { setSel(members.map((m) => m.id)); setEditing(true); }} data-testid="intl-edit-team"
              className="border border-gray-300 hover:border-gray-900 px-2 py-1 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1">
              <PencilSimple size={11} /> Edit team
            </button>
          )}
          {isAdmin && info.feed && (
            <button onClick={() => setShowFeed((v) => !v)} data-testid="intl-feed-toggle"
              className="border border-gray-300 hover:border-gray-900 px-2 py-1 text-[10px] uppercase tracking-widest font-bold">
              Scraper feed
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="p-4 space-y-3" data-testid="intl-team-editor">
          <div className="text-xs text-gray-600">
            New international leads are shared equally among the ticked executives who are present.
          </div>
          <div className="flex flex-wrap gap-2">
            {(info.candidates || []).map((c) => (
              <label key={c.id} className={`flex items-center gap-2 border px-3 py-2 text-sm cursor-pointer ${sel.includes(c.id) ? "border-[#002FA7] bg-[#F0F4FF]" : "border-gray-300"}`}>
                <input type="checkbox" checked={sel.includes(c.id)} data-testid={`intl-member-${c.username}`}
                  onChange={() => setSel((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))} />
                {c.name}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving} data-testid="intl-save-team"
              className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50">
              {saving ? "Saving…" : "Save team"}
            </button>
            <button onClick={() => setEditing(false)} className="border border-gray-300 px-3 py-2 text-[10px] uppercase tracking-widest font-bold">Cancel</button>
          </div>
        </div>
      ) : members.length === 0 ? (
        <div className="p-4 text-sm text-gray-500" data-testid="intl-no-team">
          No one is on the International team yet{isAdmin ? " — click Edit team to choose who gets these leads." : "."}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
          {members.map((m) => (
            <div key={m.id} className="p-3" data-testid={`intl-member-card-${m.username}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-sm">{m.name}</span>
                <span className={`border px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold ${STATE_CLS[m.state?.code] || STATE_CLS.not_in}`}>
                  {m.state?.label}
                </span>
              </div>
              <div className={`text-[10px] uppercase tracking-widest font-bold mt-1 ${m.state?.receiving ? "text-[#008A00]" : "text-gray-400"}`}>
                {m.state?.receiving ? "● Getting new leads" : "○ Not getting leads now"}
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-chivo font-black text-2xl">{m.today_total}</span>
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">today</span>
                <span className="ml-auto text-xs text-gray-500">{m.open} open</span>
              </div>
              <div className="text-[11px] text-gray-600 mt-0.5">
                {Object.entries(CHANNEL_LABEL).map(([k, lbl]) => `${lbl} ${m.today?.[k] || 0}`).join(" · ")}
              </div>
            </div>
          ))}
        </div>
      )}

      {showFeed && info.feed && (
        <div className="border-t border-gray-200 p-4 space-y-2 text-xs" data-testid="intl-feed-info">
          <div className="text-gray-600">
            Google Maps scraper → paste these into the Colab notebook <b>GoogleMapsScraper_International_CRM.ipynb</b>
            (Desktop). Pick the country there so local numbers get the right country code.
          </div>
          {[["Feed URL", info.feed.url], ["Ingest key", info.feed.ingest_key]].map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-20 text-[10px] uppercase tracking-widest text-gray-500 font-bold">{k}</span>
              <code className="flex-1 bg-gray-50 border border-gray-200 px-2 py-1 font-mono break-all">{v}</code>
              <button onClick={() => copy(v)} className="p-1 border border-gray-300 hover:border-gray-900" title="Copy"><Copy size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CountryPicker({ country, code, onChange }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <select value={country} data-testid="intl-country-select"
        onChange={(e) => {
          const hit = COUNTRY_CODES.find(([n]) => n === e.target.value);
          onChange(e.target.value, hit ? hit[1] : code);
        }}
        className="col-span-2 border border-gray-300 px-2 py-2 text-sm">
        <option value="">Country…</option>
        {COUNTRY_CODES.map(([n]) => <option key={n} value={n}>{n}</option>)}
      </select>
      <div className="flex items-center border border-gray-300">
        <span className="pl-2 text-sm text-gray-500">+</span>
        <input value={code} onChange={(e) => onChange(country, e.target.value.replace(/\D/g, ""))}
          placeholder="code" className="w-full px-1 py-2 text-sm outline-none" data-testid="intl-country-code" />
      </div>
    </div>
  );
}

export function IntlAddLeadModal({ onClose, onCreated, members = [], isAdmin = false }) {
  const [f, setF] = useState({ customer_name: "", company_name: "", country: "", country_code: "", phone: "", email: "", city: "", requirement: "", note: "", assigned_to: "" });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = { ...f };
      if (!payload.assigned_to) delete payload.assigned_to;
      const { data } = await api.post("/international/leads", payload);
      toast.success(data?.assigned_to ? "International lead added and assigned" : "Lead added — waiting for a team member to punch in");
      onCreated(data?.id);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBusy(false); }
  };

  const input = "w-full border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#002FA7]";
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose} data-testid="intl-add-modal">
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-xl bg-white border border-gray-900 p-6 space-y-3 max-h-[92vh] overflow-y-auto">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1"><Globe size={12} /> International</div>
          <h2 className="font-chivo font-black text-2xl mt-1">Add international lead</h2>
          <p className="text-xs text-gray-500 mt-1">It goes to the International team member who is present and has the fewest leads today.</p>
        </div>
        <input required value={f.customer_name} onChange={(e) => set("customer_name", e.target.value)} placeholder="Contact name *" className={input} data-testid="intl-name" />
        <input value={f.company_name} onChange={(e) => set("company_name", e.target.value)} placeholder="Company / business name" className={input} data-testid="intl-company" />
        <CountryPicker country={f.country} code={f.country_code} onChange={(c, code) => setF((p) => ({ ...p, country: c, country_code: code }))} />
        <input value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="Phone (local format is fine once the country is picked)" className={input} data-testid="intl-phone" />
        <input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} placeholder="Email" className={input} data-testid="intl-email" />
        <input value={f.city} onChange={(e) => set("city", e.target.value)} placeholder="City" className={input} />
        <input value={f.requirement} onChange={(e) => set("requirement", e.target.value)} placeholder="Requirement / product" className={input} data-testid="intl-requirement" />
        <textarea value={f.note} onChange={(e) => set("note", e.target.value)} placeholder="Note (optional)" rows={2} className={input} />
        {isAdmin && members.length > 0 && (
          <select value={f.assigned_to} onChange={(e) => set("assigned_to", e.target.value)} className={input} data-testid="intl-assign">
            <option value="">Assign: automatic (equal share among present team members)</option>
            {members.map((m) => <option key={m.id} value={m.id}>Assign to {m.name}</option>)}
          </select>
        )}
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold">Cancel</button>
          <button type="submit" disabled={busy} data-testid="intl-submit"
            className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50">
            {busy ? "Adding…" : "Add lead"}
          </button>
        </div>
      </form>
    </div>
  );
}

function parseCsv(text) {
  const rows = [];
  let cur = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { cur.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cur.push(field); field = "";
      if (cur.some((x) => x !== "")) rows.push(cur);
      cur = [];
    } else field += c;
  }
  if (field !== "" || cur.length) { cur.push(field); if (cur.some((x) => x !== "")) rows.push(cur); }
  return rows;
}

export function IntlImportModal({ ingestKey, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [country, setCountry] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!file) return toast.error("Choose the scraper CSV first");
    if (!code) return toast.error("Pick the country these businesses are in");
    setBusy(true);
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) throw new Error("CSV appears empty");
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const records = rows.slice(1).map((r) => {
        const rec = {};
        header.forEach((h, i) => { if (r[i] !== undefined && r[i] !== "") rec[h] = r[i]; });
        return rec;
      }).filter((r) => r.name || r.phone);
      let t = { created: 0, duplicates: 0, skipped_no_phone: 0 };
      for (let i = 0; i < records.length; i += 100) {
        const { data } = await api.post("/ingest/gmaps/international",
          { records: records.slice(i, i + 100), country_code: code, country: country || undefined },
          { headers: { "X-Ingest-Key": ingestKey } });
        t = { created: t.created + (data.created || 0), duplicates: t.duplicates + (data.duplicates || 0),
              skipped_no_phone: t.skipped_no_phone + (data.skipped_no_phone || 0) };
      }
      toast.success(`Imported: ${t.created} new · ${t.duplicates} already in CRM · ${t.skipped_no_phone} without phone`);
      onImported();
    } catch (e) { toast.error(errMsg(e, "Import failed")); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose} data-testid="intl-import-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white border border-gray-200 w-full max-w-md p-5 space-y-4">
        <div className="font-chivo font-black text-lg">Import scraper CSV (international)</div>
        <p className="text-xs text-gray-500">
          Each row becomes an International lead (source Google Maps, channel Scraper), shared equally across the
          team members who are present. Rows without a phone are skipped; numbers already in the CRM are left untouched.
        </p>
        <CountryPicker country={country} code={code} onChange={(c, cc) => { setCountry(c); setCode(cc); }} />
        <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="w-full border border-gray-300 px-2 py-2 text-sm" data-testid="intl-csv-input" />
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="border border-gray-300 px-3 py-2 text-[10px] uppercase tracking-widest font-bold">Cancel</button>
          <button onClick={run} disabled={busy} data-testid="intl-import-run"
            className="bg-[#002FA7] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50">
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
