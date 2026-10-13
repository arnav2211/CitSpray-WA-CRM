import React, { useEffect, useRef, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { MagnifyingGlass, Sparkle, UsersThree, PhoneIncoming, PhoneOutgoing } from "@phosphor-icons/react";
import { fmtSmartLong } from "@/lib/format";
import { WaCallRequestsPanel } from "@/components/WaCallButton";

/* Team Calls: AI notes of calls between colleagues (rates agreed, instructions,
   to-dos), so nobody has to remember them. Everyone sees the calls they were part
   of; admins see all. The recordings themselves are deleted after summarising. */

function dur(s) {
  const n = Math.round(Number(s || 0));
  const m = Math.floor(n / 60);
  return m ? `${m}m ${n % 60}s` : `${n}s`;
}

function TeamCallCard({ c, meId }) {
  const ai = c.ai || {};
  const [showTx, setShowTx] = useState(false);
  const outgoing = c.direction !== "incoming";
  // Show it from the reader's side: "You -> Anmol" / "Ankita -> You"
  const left = c.uploader_id === meId ? "You" : c.uploader_name;
  const right = c.other_user_id === meId ? "You" : (c.other_name || c.phone);
  const Icon = outgoing ? PhoneOutgoing : PhoneIncoming;
  return (
    <div className="border border-gray-200 bg-white p-4 space-y-2" data-testid={`team-call-${c.id}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <Icon size={14} className="text-gray-500" />
          {outgoing ? `${left} → ${right}` : `${right} → ${left}`}
        </div>
        <div className="text-[11px] text-gray-500 font-mono">{fmtSmartLong(c.call_start_at)} · {dur(c.duration_seconds)}</div>
      </div>
      <div className="text-sm text-gray-800 leading-relaxed">{ai.summary}</div>
      {ai.rates?.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-widest font-bold text-[#6D28D9]">Rates mentioned</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {ai.rates.map((r, i) => (
              <span key={i} className="border border-[#DDD6FE] bg-[#F5F3FF] px-2 py-1 text-xs">
                <b>{r.item}</b>{r.rate ? `: ${r.rate}` : ""}{r.for ? <span className="text-gray-500"> ({r.for})</span> : null}
              </span>
            ))}
          </div>
        </div>
      )}
      {ai.decisions?.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-widest font-bold text-gray-500">Decided</div>
          <ul className="list-disc pl-5 text-sm text-gray-800">{ai.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
      )}
      {ai.action_items?.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-widest font-bold text-gray-500">To do</div>
          <ul className="list-disc pl-5 text-sm text-gray-800">
            {ai.action_items.map((a, i) => (
              <li key={i}>{a.who ? <b>{a.who}: </b> : null}{a.task}{a.when ? <span className="text-gray-500"> — {a.when}</span> : null}</li>
            ))}
          </ul>
        </div>
      )}
      {ai.key_points?.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-widest font-bold text-gray-500">Everything said</div>
          <ul className="list-disc pl-5 text-sm text-gray-800">{ai.key_points.map((k, i) => <li key={i}>{k}</li>)}</ul>
        </div>
      )}
      {ai.transcript && (
        <div>
          <button onClick={() => setShowTx((v) => !v)} className="text-[10px] uppercase tracking-widest font-bold text-[#6D28D9] hover:underline">
            {showTx ? "Hide full conversation" : "Full conversation"}
          </button>
          {showTx && <div className="mt-1 bg-gray-50 border border-gray-200 p-2 text-xs whitespace-pre-wrap max-h-96 overflow-y-auto">{ai.transcript}</div>}
        </div>
      )}
      {ai.customers?.length > 0 && (
        <div className="text-xs text-gray-500">Customers mentioned: {ai.customers.join(", ")}</div>
      )}
    </div>
  );
}

export default function TeamCalls() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [person, setPerson] = useState("");
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = async () => {
    const s = ++seq.current;
    try {
      const { data } = await api.get("/team-calls", { params: { q: q || undefined, person: person || undefined, limit: 100 } });
      if (s !== seq.current) return;
      setItems(data.items || []); setTotal(data.total || 0);
    } catch (e) { toast.error(errMsg(e)); }
    finally { if (s === seq.current) setLoading(false); }
  };
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [q, person]);
  useEffect(() => {
    if (!isAdmin) return;
    api.get("/users").then(({ data }) => setPeople(data.filter((u) => u.role === "executive" || u.role === "admin"))).catch(() => {});
  }, [isAdmin]);

  return (
    <div className="p-4 md:p-8 space-y-4" data-testid="team-calls-page">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1"><UsersThree size={12} /> Internal</div>
        <h1 className="font-chivo font-black text-2xl md:text-4xl">Team Calls <span className="text-gray-400">[{total}]</span></h1>
        <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
          <Sparkle size={12} weight="fill" className="text-[#6D28D9]" />
          AI notes of calls between colleagues — rates, decisions and to-dos — so nothing said on a call is forgotten.
          {isAdmin ? " You see everyone's." : " You see the calls you were part of."}
        </p>
      </div>
      {isAdmin && <WaCallRequestsPanel />}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <MagnifyingGlass className="absolute left-2 top-2.5 text-gray-400" size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a product, rate, customer, person…"
            className="w-full border border-gray-300 pl-7 pr-3 py-2 text-sm outline-none focus:border-[#002FA7]" data-testid="team-calls-search" />
        </div>
        {isAdmin && (
          <select value={person} onChange={(e) => setPerson(e.target.value)} className="border border-gray-300 px-2 py-2 text-sm" data-testid="team-calls-person">
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>
      {loading ? (
        <div className="text-xs text-gray-400 uppercase tracking-widest">Loading…</div>
      ) : items.length === 0 ? (
        <div className="border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          No team calls yet. Calls between colleagues (10 s or longer) appear here a minute or two after they end.
        </div>
      ) : (
        <div className="space-y-3">{items.map((c) => <TeamCallCard key={c.id} c={c} meId={user?.id} />)}</div>
      )}
    </div>
  );
}
