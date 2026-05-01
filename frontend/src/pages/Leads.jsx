import React, { useEffect, useMemo, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { Link, useSearchParams } from "react-router-dom";
import { StatusBadge, SourceBadge, QueryTypeBadge } from "@/components/Badges";
import { toast } from "sonner";
import { Kanban, Table, Plus, MagnifyingGlass, FileX } from "@phosphor-icons/react";
import LeadDrawer from "@/components/LeadDrawer";
import { fmtIST } from "@/lib/format";

const STATUSES = ["new", "contacted", "qualified", "converted", "lost"];
const SOURCES = ["IndiaMART", "Justdial", "Manual", "WhatsApp"];

export default function Leads() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [leads, setLeads] = useState([]);
  const [execs, setExecs] = useState([]);
  const [view, setView] = useState(params.get("view") || "table");
  const [q, setQ] = useState(params.get("q") || "");
  const [statusFilter, setStatusFilter] = useState(params.get("status") || "");
  const [sourceFilter, setSourceFilter] = useState(params.get("source") || "");
  const [assignedFilter, setAssignedFilter] = useState(params.get("assigned") || "");
  const [outcomeFilter, setOutcomeFilter] = useState(params.get("outcome") || "");
  const [openId, setOpenId] = useState(params.get("lead") || null);
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(parseInt(params.get("page") || "1", 10) || 1);
  const [pageSize, setPageSize] = useState(parseInt(params.get("size") || "25", 10) || 25);
  const [total, setTotal] = useState(0);

  const load = async () => {
    try {
      const { data } = await api.get("/leads", {
        params: {
          q: q || undefined,
          status: statusFilter || undefined,
          source: sourceFilter || undefined,
          assigned_to: assignedFilter || undefined,
          last_call_outcome: outcomeFilter || undefined,
          paginate: true,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        },
      });
      // /api/leads returns {items,total,...} when paginate=true is sent.
      setLeads(data?.items || []);
      setTotal(typeof data?.total === "number" ? data.total : (data?.items || []).length);
    } catch (e) { toast.error(errMsg(e)); }
  };

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/users");
        // Include both admins and executives so admin can self-assign or reassign-to-self.
        // Round-robin (auto-assign) backend-side still excludes admins.
        setExecs(data.filter((u) => u.role === "executive" || u.role === "admin"));
      } catch { /* empty */ }
    })();
  }, []);

  // Reset to first page whenever a filter changes (so we never end up on an
  // empty page after narrowing the result set).
  useEffect(() => { setPage(1); }, [statusFilter, sourceFilter, assignedFilter, outcomeFilter, q, pageSize]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter, sourceFilter, assignedFilter, outcomeFilter, page, pageSize]);
  useEffect(() => {
    const t = setTimeout(() => load(), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [q]);

  useEffect(() => {
    const p = {};
    if (view !== "table") p.view = view;
    if (q) p.q = q;
    if (statusFilter) p.status = statusFilter;
    if (sourceFilter) p.source = sourceFilter;
    if (assignedFilter) p.assigned = assignedFilter;
    if (outcomeFilter) p.outcome = outcomeFilter;
    if (openId) p.lead = openId;
    if (page > 1) p.page = String(page);
    if (pageSize !== 25) p.size = String(pageSize);
    setParams(p, { replace: true });
  }, [view, q, statusFilter, sourceFilter, assignedFilter, outcomeFilter, openId, page, pageSize, setParams]);

  const execMap = useMemo(() => Object.fromEntries(execs.map((e) => [e.id, e])), [execs]);
  const isAdmin = user.role === "admin";
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="p-4 md:p-8 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Pipeline</div>
          <h1 className="font-chivo font-black text-2xl md:text-4xl">All Leads <span className="text-gray-400">[{total}]</span></h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            className={`border px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 ${view === "table" ? "bg-gray-900 text-white border-gray-900" : "border-gray-300 hover:bg-gray-100"}`}
            onClick={() => setView("table")} data-testid="view-table-btn"
          ><Table size={12} weight="bold" /> Table</button>
          <button
            className={`border px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 ${view === "kanban" ? "bg-gray-900 text-white border-gray-900" : "border-gray-300 hover:bg-gray-100"}`}
            onClick={() => setView("kanban")} data-testid="view-kanban-btn"
          ><Kanban size={12} weight="bold" /> Kanban</button>
          <button
            className="bg-[#002FA7] hover:bg-[#002288] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1"
            onClick={() => setCreating(true)} data-testid="new-lead-btn"
          ><Plus size={12} weight="bold" /> New Lead</button>
        </div>
      </div>

      {/* Filters */}
      <div className="border border-gray-200 bg-white p-3 md:p-4 grid grid-cols-1 md:grid-cols-5 gap-2 md:gap-3">
        <div className="relative md:col-span-2">
          <MagnifyingGlass className="absolute left-2 top-2.5 text-gray-400" size={14} />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, phone, requirement, city"
            className="w-full border border-gray-300 pl-7 pr-3 py-2 text-sm outline-none focus:border-[#002FA7] focus:ring-2 focus:ring-[#002FA7]"
            data-testid="leads-search-input"
          />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-gray-300 px-2 py-2 text-sm" data-testid="leads-status-filter">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="border border-gray-300 px-2 py-2 text-sm" data-testid="leads-source-filter">
          <option value="">All sources</option>
          {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {isAdmin && (
          <select value={assignedFilter} onChange={(e) => setAssignedFilter(e.target.value)} className="border border-gray-300 px-2 py-2 text-sm" data-testid="leads-assignee-filter">
            <option value="">All executives</option>
            {execs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        )}
        <select value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value)} className="border border-gray-300 px-2 py-2 text-sm md:col-span-1 col-span-1" data-testid="leads-outcome-filter">
          <option value="">All call outcomes</option>
          <option value="connected">Connected</option>
          <option value="no_response">No Response (PNR)</option>
          <option value="not_reachable">Not Reachable</option>
          <option value="rejected">Rejected</option>
          <option value="busy">Busy / Engaged</option>
          <option value="invalid">Invalid</option>
        </select>
      </div>

      {view === "table" ? (
        <>
          {/* MOBILE: card list */}
          <div className="md:hidden space-y-2" data-testid="leads-mobile-list">
            {leads.length === 0 ? (
              <div className="border border-gray-200 bg-white p-8 text-center">
                <FileX size={48} weight="light" className="mx-auto text-gray-300" />
                <div className="mt-2 text-[10px] uppercase tracking-widest text-gray-500 font-bold">No leads yet</div>
              </div>
            ) : leads.map((l) => {
              const unread = !l.opened_at;
              const ageMin = Math.floor((Date.now() - new Date(l.created_at).getTime()) / 60000);
              const overdue = unread && ageMin > 15;
              return (
                <button key={l.id} onClick={() => setOpenId(l.id)}
                  className={`w-full text-left border border-gray-200 bg-white p-3 hover:border-gray-900 transition-colors ${overdue ? "border-l-2 border-l-[#E60000]" : ""}`}
                  data-testid={`lead-card-${l.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className={`truncate ${unread ? "font-bold" : "font-semibold"}`}>{l.customer_name}</div>
                      {l.phone && (
                        <div className="text-xs text-gray-500 font-mono mt-0.5">
                          {l.phone}
                          {l.phones?.length > 0 && (
                            <span className="ml-1 text-[10px] uppercase tracking-widest text-[#002FA7] font-bold">+{l.phones.length}</span>
                          )}
                        </div>
                      )}
                    </div>
                    <StatusBadge status={l.status} />
                  </div>
                  {l.requirement && (
                    <div className="text-xs text-gray-700 mt-2 line-clamp-2">{l.requirement}</div>
                  )}
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <SourceBadge source={l.source} />
                    <QueryTypeBadge code={l.source_data?.QUERY_TYPE} compact />
                    <span className="text-[10px] uppercase tracking-widest text-gray-400 font-bold ml-auto">
                      {execMap[l.assigned_to]?.name || "Unassigned"}
                    </span>
                  </div>
                  <div className="text-[10px] text-gray-400 font-mono mt-1">{fmtIST(l.created_at)}</div>
                </button>
              );
            })}
          </div>

          {/* DESKTOP: table */}
          <div className="hidden md:block border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
              <tr>
                <th className="text-left px-4 py-3">Customer</th>
                <th className="text-left px-4 py-3">Requirement</th>
                <th className="text-left px-4 py-3">Location</th>
                <th className="text-left px-4 py-3">Source</th>
                <th className="text-left px-4 py-3">Type</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Assigned</th>
                <th className="text-left px-4 py-3">Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => {
                const unread = !l.opened_at;
                const ageMin = Math.floor((Date.now() - new Date(l.created_at).getTime()) / 60000);
                const overdue = unread && ageMin > 15;
                return (
                  <tr key={l.id} onClick={() => setOpenId(l.id)}
                    className={`border-t border-gray-200 cursor-pointer hover:bg-gray-50 ${overdue ? "border-l-2 border-l-[#E60000]" : ""}`}
                    data-testid={`lead-row-${l.id}`}
                  >
                    <td className="px-4 py-3">
                      <div className={`${unread ? "font-bold" : ""}`}>{l.customer_name}</div>
                      {l.phone && (
                        <div className="text-xs text-gray-500 font-mono flex items-center gap-1">
                          <span>{l.phone}</span>
                          {l.phones?.length > 0 && (
                            <span className="text-[10px] uppercase tracking-widest text-[#002FA7] font-bold">
                              +{l.phones.length}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 max-w-[260px] truncate">{l.requirement || "—"}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">{[l.area, l.city, l.state].filter(Boolean).join(", ") || "—"}</td>
                    <td className="px-4 py-3"><SourceBadge source={l.source} /></td>
                    <td className="px-4 py-3">
                      <QueryTypeBadge code={l.source_data?.QUERY_TYPE} compact />
                      {l.source_data?.QUERY_TYPE === "P" && l.source_data?.RECEIVER_MOBILE && (
                        <div className="text-[10px] font-mono text-gray-500 mt-1" title="PNS Receiver Number">
                          Rcv: {l.source_data.RECEIVER_MOBILE}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={l.status} /></td>
                    <td className="px-4 py-3 text-xs">{execMap[l.assigned_to]?.name || "—"}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">{fmtIST(l.created_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/leads/${l.id}`} onClick={(e) => e.stopPropagation()} className="text-[10px] uppercase tracking-widest font-bold text-[#002FA7]" data-testid={`open-lead-${l.id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {leads.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-16 text-center">
                  <FileX size={56} weight="light" className="mx-auto text-gray-300" />
                  <div className="mt-3 text-[10px] uppercase tracking-widest text-gray-500 font-bold">No leads yet</div>
                  <div className="text-xs text-gray-400 mt-1">Create a lead or trigger the IndiaMART webhook to populate the pipeline.</div>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={total}
          totalPages={totalPages}
          onPage={setPage}
          onPageSize={setPageSize}
        />
        </>
      ) : (
        <Kanban_ leads={leads} onOpen={setOpenId} execMap={execMap} />
      )}

      {openId && <LeadDrawer leadId={openId} onClose={() => { setOpenId(null); load(); }} />}
      {creating && <NewLeadModal execs={execs} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); load(); if (id) setOpenId(id); }} isAdmin={isAdmin} />}
    </div>
  );
}

function Kanban_({ leads, onOpen, execMap }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-0 border border-gray-200 bg-white">
      {STATUSES.map((s, i) => {
        const items = leads.filter((l) => l.status === s);
        return (
          <div key={s} className={`border-gray-200 ${i < 4 ? "md:border-r" : ""} min-h-[400px]`} data-testid={`kanban-col-${s}`}>
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{s}</div>
              <div className="font-mono text-xs">{items.length}</div>
            </div>
            <div className="p-2 space-y-2">
              {items.map((l) => (
                <button key={l.id} onClick={() => onOpen(l.id)}
                  className="w-full text-left border border-gray-200 bg-white p-3 hover:border-gray-900 transition-colors"
                  data-testid={`kanban-card-${l.id}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-sm truncate">{l.customer_name}</div>
                    <SourceBadge source={l.source} />
                  </div>
                  <div className="text-xs text-gray-500 mt-1 truncate">{l.requirement || "—"}</div>
                  <div className="mt-2 flex items-center gap-2">
                    <QueryTypeBadge code={l.source_data?.QUERY_TYPE} compact />
                    <div className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">
                      {execMap[l.assigned_to]?.name || "Unassigned"}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NewLeadModal({ onClose, onCreated, execs, isAdmin }) {
  const [f, setF] = useState({ customer_name: "", phone: "", requirement: "", city: "", state: "", area: "", source: "Manual", assigned_to: "" });
  const [loading, setLoading] = useState(false);
  const [conflict, setConflict] = useState(null); // { existing_lead_id, owned_by_name, message }
  const [requesting, setRequesting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setConflict(null);
    try {
      const payload = { ...f };
      if (!payload.assigned_to) delete payload.assigned_to;
      const { data } = await api.post("/leads", payload);
      if (data?.duplicate || data?.existed) {
        toast.success(`Existing lead opened: ${data.customer_name}`);
        onCreated(data.id);  // signal which lead to open
        return;
      }
      toast.success("Lead created");
      onCreated(data?.id);
    } catch (err) {
      // Structured 409 from backend → show inline reassignment CTA instead of red toast
      const detail = err?.response?.data?.detail;
      if (err?.response?.status === 409 && detail && typeof detail === "object" && detail.code === "duplicate_phone") {
        setConflict(detail);
      } else {
        toast.error(errMsg(err));
      }
    } finally { setLoading(false); }
  };

  const requestReassignment = async () => {
    if (!conflict?.existing_lead_id) return;
    setRequesting(true);
    try {
      await api.post("/inbox/transfer-request", {
        lead_id: conflict.existing_lead_id,
        reason: `Duplicate add attempt for phone ${f.phone || ""}. Customer name: ${f.customer_name || ""}.`,
      });
      toast.success("Reassignment request sent to admin");
      onClose();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setRequesting(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose} data-testid="new-lead-modal">
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="w-full max-w-xl bg-white border border-gray-900 p-6"
      >
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Create</div>
        <h2 className="font-chivo font-black text-2xl mt-1 mb-4">New Lead</h2>
        {conflict && (
          <div className="border-l-4 border-[#E60000] bg-[#FFE9E9] px-4 py-3 mb-4" data-testid="duplicate-conflict-panel">
            <div className="text-[10px] uppercase tracking-widest font-bold text-[#E60000]">Duplicate phone</div>
            <div className="text-sm mt-1">{conflict.message}</div>
            <div className="text-xs text-gray-700 mt-1">
              Currently with: <b>{conflict.owned_by_name || "another executive"}</b>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                onClick={requestReassignment}
                disabled={requesting}
                className="bg-[#E60000] hover:bg-[#cc0000] text-white px-3 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50"
                data-testid="request-reassignment-btn"
              >
                {requesting ? "Sending…" : "Request Reassignment"}
              </button>
              <button
                type="button"
                onClick={() => setConflict(null)}
                className="border border-gray-300 px-3 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100"
              >
                Edit phone
              </button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Customer name *"><input required value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-lead-name-input" /></Field>
          <Field label="Phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="8790934618 or +255123456789" data-testid="new-lead-phone-input" /></Field>
          <Field label="Requirement" full><input value={f.requirement} onChange={(e) => setF({ ...f, requirement: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-lead-requirement-input" /></Field>
          <Field label="Area"><input value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-lead-area-input" /></Field>
          <Field label="City"><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-lead-city-input" /></Field>
          <Field label="State"><input value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} className="w-full border border-gray-300 px-3 py-2 text-sm" data-testid="new-lead-state-input" /></Field>
          <Field label="Source">
            <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} className="w-full border border-gray-300 px-2 py-2 text-sm" data-testid="new-lead-source-select">
              {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          {isAdmin && (
            <Field label="Assign to" full>
              <select value={f.assigned_to} onChange={(e) => setF({ ...f, assigned_to: e.target.value })} className="w-full border border-gray-300 px-2 py-2 text-sm" data-testid="new-lead-assign-select">
                <option value="">Auto (round-robin)</option>
                {execs.map((x) => <option key={x.id} value={x.id}>{x.role === "admin" ? `${x.name} (admin)` : x.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100" data-testid="new-lead-cancel-btn">Cancel</button>
          <button disabled={loading} className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50" data-testid="new-lead-submit-btn">
            {loading ? "Creating…" : "Create Lead"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children, full }) {
  return (
    <label className={`${full ? "md:col-span-2" : ""} block`}>
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">{label}</div>
      {children}
    </label>
  );
}

function PaginationBar({ page, pageSize, total, totalPages, onPage, onPageSize }) {
  if (total === 0) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const goPrev = () => onPage(Math.max(1, page - 1));
  const goNext = () => onPage(Math.min(totalPages, page + 1));
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border border-gray-200 bg-white px-3 py-2"
      data-testid="leads-pagination-bar"
    >
      <div className="text-xs text-gray-500" data-testid="leads-pagination-summary">
        Showing <span className="font-mono font-bold text-gray-900">{start}–{end}</span> of <span className="font-mono font-bold text-gray-900">{total}</span>
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-gray-500 font-bold">
          Per page
          <select
            value={pageSize}
            onChange={(e) => onPageSize(parseInt(e.target.value, 10))}
            className="border border-gray-300 px-1.5 py-1 text-xs"
            data-testid="leads-pagination-size"
          >
            {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button
          onClick={goPrev}
          disabled={page <= 1}
          className="border border-gray-300 px-3 py-1 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="leads-pagination-prev"
        >
          Prev
        </button>
        <span className="text-[10px] uppercase tracking-widest text-gray-500 font-mono" data-testid="leads-pagination-page">
          {page} / {totalPages}
        </span>
        <button
          onClick={goNext}
          disabled={page >= totalPages}
          className="border border-gray-300 px-3 py-1 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="leads-pagination-next"
        >
          Next
        </button>
      </div>
    </div>
  );
}

