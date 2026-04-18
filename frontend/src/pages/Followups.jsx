import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { CheckCircle, Clock } from "@phosphor-icons/react";

export default function Followups() {
  const [list, setList] = useState([]);

  const load = async () => { try { const { data } = await api.get("/followups"); setList(data); } catch (e) { toast.error(errMsg(e)); } };
  useEffect(() => { load(); }, []);

  const markDone = async (id) => {
    try { await api.patch(`/followups/${id}`, { status: "done" }); load(); toast.success("Marked done"); } catch (e) { toast.error(errMsg(e)); }
  };

  const byStatus = {
    pending: list.filter((f) => f.status === "pending" && new Date(f.due_at) >= new Date()),
    overdue: list.filter((f) => f.status === "pending" && new Date(f.due_at) < new Date()),
    missed: list.filter((f) => f.status === "missed"),
    done: list.filter((f) => f.status === "done"),
  };

  return (
    <div className="p-6 md:p-8 space-y-6">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Schedule</div>
        <h1 className="font-chivo font-black text-3xl md:text-4xl">Follow-ups</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Overdue" items={byStatus.overdue} accent="text-[#E60000]" onDone={markDone} />
        <Section title="Upcoming" items={byStatus.pending} accent="text-[#002FA7]" onDone={markDone} />
        <Section title="Missed" items={byStatus.missed} accent="text-gray-500" onDone={markDone} />
        <Section title="Completed" items={byStatus.done} accent="text-[#008A00]" onDone={null} />
      </div>
    </div>
  );
}

function Section({ title, items, accent, onDone }) {
  return (
    <div className="border border-gray-200 bg-white">
      <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
        <div className={`text-[10px] uppercase tracking-widest font-bold ${accent}`}>{title}</div>
        <div className="font-mono text-xs">{items.length}</div>
      </div>
      <div className="divide-y divide-gray-200">
        {items.map((f) => (
          <div key={f.id} className="px-5 py-3 flex items-center gap-3" data-testid={`followup-${f.id}`}>
            <Clock size={14} className="text-gray-400" />
            <div className="flex-1 min-w-0">
              <Link to={`/leads/${f.lead_id}`} className="font-semibold text-sm hover:underline">Lead</Link>
              <div className="text-xs text-gray-500 truncate">{f.note || "—"}</div>
            </div>
            <span className="text-xs font-mono text-gray-500">{(f.due_at || "").slice(0, 16).replace("T", " ")}</span>
            {onDone && (
              <button onClick={() => onDone(f.id)} className="text-[10px] uppercase tracking-widest font-bold text-[#008A00] flex items-center gap-1" data-testid={`followup-done-${f.id}`}>
                <CheckCircle size={14} /> Done
              </button>
            )}
          </div>
        ))}
        {items.length === 0 && <div className="px-5 py-6 text-xs uppercase tracking-widest text-gray-400 text-center">Nothing here</div>}
      </div>
    </div>
  );
}
