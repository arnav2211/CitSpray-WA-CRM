import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { fmtSmartLong } from "@/lib/format";
import { ArrowsClockwise, Check, X, ArrowRight, ArrowsLeftRight } from "@phosphor-icons/react";

const POLL_MS = 8000;

const TABS = [
  { k: "pending",  label: "Pending" },
  { k: "approved", label: "Approved" },
  { k: "rejected", label: "Rejected" },
];

export default function TransferRequests() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState("pending");
  const [rows, setRows] = useState([]);
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState({});

  const userMap = React.useMemo(() => {
    const m = {};
    users.forEach((u) => { m[u.id] = u; });
    return m;
  }, [users]);

  const load = useCallback(async () => {
    try {
      const [{ data: rqs }, { data: us }] = await Promise.all([
        api.get(`/inbox/transfer-requests?status=${tab}`),
        api.get("/users").catch(() => ({ data: [] })),
      ]);
      setRows(rqs || []);
      setUsers(us || []);
    } catch (e) { toast.error(errMsg(e)); }
  }, [tab]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const decide = async (id, action) => {
    setBusy((b) => ({ ...b, [id]: action }));
    try {
      await api.post(`/inbox/transfer-requests/${id}/${action}`);
      toast.success(action === "approve" ? "Reassigned" : "Rejected");
      await load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const isAdmin = user?.role === "admin";

  return (
    <div className="p-4 md:p-8 space-y-5 max-w-6xl" data-testid="transfer-requests-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-1">
            <ArrowsLeftRight size={12} weight="bold" /> Approvals
          </div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">Reassignment Requests</h1>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            {isAdmin
              ? "Executives request reassignment of leads currently owned by another agent. Approve to transfer ownership; reject to keep current."
              : "Track the status of reassignment requests you've raised. Admin will approve or reject."}
          </p>
        </div>
        <button onClick={load} className="border border-gray-900 hover:bg-gray-900 hover:text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid="tr-refresh">
          <ArrowsClockwise size={12} weight="bold" /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`px-3 py-1.5 text-[11px] uppercase tracking-widest font-bold border ${tab === t.k ? "bg-[#002FA7] text-white border-[#002FA7]" : "border-gray-300 hover:bg-gray-100"}`}
            data-testid={`tr-tab-${t.k}`}
          >{t.label}</button>
        ))}
      </div>

      <div className="border border-gray-200 bg-white" data-testid="tr-list">
        {rows.length === 0 ? (
          <div className="p-12 text-center text-xs uppercase tracking-widest text-gray-400 font-bold">
            No {tab} requests
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {rows.map((r) => {
              const requester = userMap[r.from_user_id];
              const currentOwner = r.current_assignee_id ? userMap[r.current_assignee_id] : null;
              return (
                <div key={r.id} className="px-5 py-4 flex flex-wrap items-center gap-4" data-testid={`tr-row-${r.id}`}>
                  <div className="flex-1 min-w-[240px]">
                    <div className="font-semibold text-sm flex items-center gap-2 flex-wrap">
                      <span className="text-[#002FA7]">{requester?.name || r.from_user_name || r.from_user_id}</span>
                      <ArrowRight size={11} weight="bold" className="text-gray-400" />
                      <span className="text-gray-500">
                        currently <b>{currentOwner?.name || (r.current_assignee_id ? r.current_assignee_id.slice(0, 6) : "Unassigned")}</b>
                      </span>
                    </div>
                    {r.reason && (
                      <div className="text-xs text-gray-700 italic mt-1 max-w-xl">"{r.reason}"</div>
                    )}
                    <div className="text-[10px] text-gray-400 font-mono mt-1">
                      Asked {fmtSmartLong(r.created_at)}
                      {r.decided_at && (<> · <span className={r.status === "approved" ? "text-[#008A00]" : "text-[#E60000]"}>{r.status} {fmtSmartLong(r.decided_at)}</span></>)}
                    </div>
                  </div>
                  <button
                    onClick={() => nav(`/leads/${r.lead_id}`)}
                    className="border border-gray-900 hover:bg-gray-900 hover:text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1"
                    data-testid={`tr-open-lead-${r.id}`}
                  >Open lead <ArrowRight size={10} weight="bold" /></button>
                  {isAdmin && r.status === "pending" && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => decide(r.id, "approve")}
                        disabled={!!busy[r.id]}
                        className="bg-[#008A00] hover:bg-[#005F00] text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50"
                        data-testid={`tr-approve-${r.id}`}
                      ><Check size={11} weight="bold" /> Approve</button>
                      <button
                        onClick={() => decide(r.id, "reject")}
                        disabled={!!busy[r.id]}
                        className="border border-[#E60000] text-[#E60000] hover:bg-[#E60000] hover:text-white px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50"
                        data-testid={`tr-reject-${r.id}`}
                      ><X size={11} weight="bold" /> Reject</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
