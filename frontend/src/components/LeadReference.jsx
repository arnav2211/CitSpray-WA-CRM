import React from "react";
import { fmtSmartLong } from "@/lib/format";
import { SourceBadge, EnquiryTypeBadge } from "@/components/Badges";

/* Everything an executive needs for reference while chatting: what kind of
   lead this is, who owns it, when the customer enquired, when they were last
   called / messaged, and the portal's own enquiry details. Used in the /chat
   "Lead Details" panel. */

const OUTCOME_LABEL = {
  connected: "Connected",
  no_response: "Not answered",
  no_answer: "No answer",
  busy: "Busy",
  rejected: "Rejected",
  switched_off: "Switched off",
};
const OUTCOME_CLS = {
  connected: "text-[#008A00]",
  no_response: "text-[#B85F00]",
  no_answer: "text-[#B85F00]",
  busy: "text-[#E67E00]",
  rejected: "text-[#E60000]",
  switched_off: "text-gray-500",
};

function dur(sec) {
  const s = Math.round(Number(sec || 0));
  if (!s) return "";
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

function ago(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

function pick(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

function Row({ k, children, testId }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-2 py-1 text-xs" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold pt-0.5">{k}</div>
      <div className="text-gray-800 min-w-0 break-words">{children}</div>
    </div>
  );
}

function Section({ title, children, testId }) {
  return (
    <div className="border border-gray-200 bg-gray-50/60" data-testid={testId}>
      <div className="px-2.5 py-1.5 border-b border-gray-200 text-[10px] uppercase tracking-widest text-gray-500 font-bold">{title}</div>
      <div className="px-2.5 py-1 divide-y divide-gray-100">{children}</div>
    </div>
  );
}

/* Portal-specific enquiry fields -> [label, value, {block}] rows */
function sourceRows(lead) {
  const sd = lead.source_data || {};
  const src = (lead.source || "").toLowerCase().replace(/\s/g, "");
  const rows = [];
  const add = (label, value, opts = {}) => { if (value) rows.push([label, value, opts]); };

  if (src === "indiamart") {
    const qt = (sd.QUERY_TYPE || lead.enquiry_type || "").toUpperCase();
    add("Product", sd.QUERY_PRODUCT_NAME);
    if (sd.QUERY_MCAT_NAME && sd.QUERY_MCAT_NAME !== sd.QUERY_PRODUCT_NAME) add("Category", sd.QUERY_MCAT_NAME);
    add("Buyer's message", sd.QUERY_MESSAGE, { block: true });
    add("Company", sd.SENDER_COMPANY);
    add("Alt numbers", [sd.SENDER_MOBILE_ALT, sd.SENDER_PHONE, sd.SENDER_PHONE_ALT].filter(Boolean).join(" · "));
    add("Alt email", sd.SENDER_EMAIL_ALT);
    add("Pincode", sd.SENDER_PINCODE);
    if (qt === "P") {
      add("PNS call to", sd.RECEIVER_MOBILE);
      add("PNS call length", sd.CALL_DURATION ? `${sd.CALL_DURATION}s` : null);
    }
    add("Enquired on IM", sd.QUERY_TIME);
    add("IndiaMART ID", sd.UNIQUE_QUERY_ID);
  } else if (src === "justdial") {
    add("Searched for", pick(sd, ["category", "Category"]));
    add("Search area", [pick(sd, ["area"]), pick(sd, ["city"])].filter(Boolean).join(", "));
    add("JD listing", pick(sd, ["company"]));
    add("Searched on", [pick(sd, ["date"]), pick(sd, ["time"])].filter(Boolean).join(" "));
    add("Lead type", pick(sd, ["leadtype"]));
    add("JustDial ID", pick(sd, ["leadid"]));
  } else if (src === "exportersindia") {
    add("Product", pick(sd, ["product", "PRODUCT", "product_name"]));
    add("Subject", pick(sd, ["subject", "SUBJECT"]));
    add("Buyer's message", pick(sd, ["detail_req", "DETAIL_REQ", "message"]), { block: true });
    add("Company", pick(sd, ["company", "COMPANY"]));
    add("Enquired on EI", pick(sd, ["enq_date", "ENQ_DATE"]));
    add("EI ID", pick(sd, ["inq_id", "INQ_ID", "enquiry_id"]));
  } else if (src === "tradeindia") {
    add("Product", pick(sd, ["product_name", "product", "subject"]));
    add("Buyer's message", pick(sd, ["message", "inquiry_message", "msg"]), { block: true });
    add("Company", pick(sd, ["sender_co", "sender_company", "company"]));
    add("Qty / budget", [pick(sd, ["quantity"]), pick(sd, ["order_value"])].filter(Boolean).join(" · "));
    add("Enquired on TI", [pick(sd, ["generated_date"]), pick(sd, ["generated_time"])].filter(Boolean).join(" "));
    add("TradeIndia ID", pick(sd, ["rfi_id", "inquiry_id"]));
  }
  return rows;
}

const IM_TYPE = { B: "Buylead", W: "Direct", P: "PNS", BIZ: "Catalog" };

/* Enquiry history: the chat endpoints send a compact `enquiry_history`
   ({at, source, type, what}); full lead objects carry `enquiries`. */
function historyOf(lead) {
  if (Array.isArray(lead.enquiry_history)) return lead.enquiry_history;
  return (Array.isArray(lead.enquiries) ? lead.enquiries : []).map((e) => {
    const sd = e.source_data || {};
    return {
      at: e.created_at,
      source: e.source,
      type: sd.QUERY_TYPE,
      what: pick(sd, ["QUERY_PRODUCT_NAME", "product_name", "product", "category", "subject"]) || e.requirement || "",
    };
  }).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
}

export default function LeadReference({ lead, calls = [], followups = [], execs = [], lastInAt, lastOutAt }) {
  if (!lead) return null;
  const owner = (execs || []).find((u) => u.id === lead.assigned_to);
  const lastCall = calls[0];
  const connected = calls.filter((c) => c.outcome === "connected");
  const lastSpoke = connected[0];
  const pendingFus = (followups || [])
    .filter((f) => f.status === "pending")
    .sort((a, b) => (a.due_at || "").localeCompare(b.due_at || ""));
  const nextFu = pendingFus[0];
  const nextFuOverdue = nextFu && new Date(nextFu.due_at) < new Date();
  const enquiries = historyOf(lead);
  const rows = sourceRows(lead);

  return (
    <div className="space-y-3" data-testid="lead-reference">
      <Section title="At a glance" testId="lead-glance">
        <Row k="Lead type" testId="glance-type">
          <span className="inline-flex items-center gap-1.5 flex-wrap">
            <SourceBadge source={lead.source} />
            <EnquiryTypeBadge lead={lead} />
          </span>
        </Row>
        <Row k="Assigned to" testId="glance-owner">
          {owner ? owner.name : <span className="text-[#E60000] font-semibold">Unassigned</span>}
          {lead.assigned_to && !lead.opened_at && (
            <span className="ml-1.5 text-[10px] uppercase tracking-widest font-bold text-[#E60000]">not opened yet</span>
          )}
        </Row>
        <Row k="Enquired" testId="glance-enquired">
          {fmtSmartLong(lead.created_at) || "—"}
          {enquiries.length > 1 && (
            <div className="text-[11px] text-[#002FA7] font-semibold">
              Enquired {enquiries.length} times · latest {fmtSmartLong(enquiries[0].at)}
              {enquiries[0].source ? ` via ${enquiries[0].source}` : ""}
            </div>
          )}
        </Row>
        <Row k="Last call" testId="glance-last-call">
          {lastCall ? (
            <>
              <span className={`font-semibold ${OUTCOME_CLS[lastCall.outcome] || "text-gray-700"}`}>
                {OUTCOME_LABEL[lastCall.outcome] || lastCall.outcome}
              </span>
              {dur(lastCall.duration_seconds) && <span className="text-gray-600"> · {dur(lastCall.duration_seconds)}</span>}
              <div className="text-[11px] text-gray-600">
                {fmtSmartLong(lastCall.at)} ({ago(lastCall.at)}){lastCall.by_user_name ? ` · ${lastCall.by_user_name}` : ""}
                {lastCall.direction ? ` · ${lastCall.direction}` : ""}
              </div>
            </>
          ) : (
            <span className="text-[#E60000] font-semibold">Never called</span>
          )}
        </Row>
        {calls.length > 0 && (
          <Row k="Calls" testId="glance-calls">
            {calls.length} total · {connected.length} answered
            {lastSpoke && lastSpoke !== lastCall && (
              <div className="text-[11px] text-gray-600">Last spoke {fmtSmartLong(lastSpoke.at)} ({ago(lastSpoke.at)})</div>
            )}
          </Row>
        )}
        <Row k="Customer wrote" testId="glance-last-in">
          {lastInAt ? <>{fmtSmartLong(lastInAt)} <span className="text-gray-500">({ago(lastInAt)})</span></> : <span className="text-gray-400">Never on WhatsApp</span>}
        </Row>
        <Row k="We replied" testId="glance-last-out">
          {lastOutAt ? <>{fmtSmartLong(lastOutAt)} <span className="text-gray-500">({ago(lastOutAt)})</span></> : <span className="text-gray-400">No message sent</span>}
        </Row>
        <Row k="Next follow-up" testId="glance-next-fu">
          {nextFu ? (
            <span className={nextFuOverdue ? "text-[#E60000] font-semibold" : ""}>
              {fmtSmartLong(nextFu.due_at)}{nextFuOverdue ? " · overdue" : ""}
              {nextFu.note && <div className="text-[11px] text-gray-600 font-normal">{nextFu.note}</div>}
            </span>
          ) : (
            <span className="text-gray-400">None scheduled</span>
          )}
        </Row>
        {lead.gst_no && <Row k="GSTIN"><span className="font-mono">{lead.gst_no}</span></Row>}
      </Section>

      {rows.length > 0 && (
        <Section title={`${lead.source} enquiry`} testId="lead-source-details">
          {rows.map(([label, value, opts]) => (
            opts.block ? (
              <div key={label} className="py-1.5 text-xs">
                <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-0.5">{label}</div>
                <div className="text-gray-800 whitespace-pre-wrap leading-relaxed">{value}</div>
              </div>
            ) : (
              <Row key={label} k={label}>{value}</Row>
            )
          ))}
        </Section>
      )}

      {enquiries.length > 1 && (
        <Section title={`Enquiry history (${enquiries.length})`} testId="lead-enquiry-history">
          {enquiries.slice(0, 10).map((e, i) => (
            <div key={i} className="py-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-gray-800">
                  {e.source || "—"}
                  {IM_TYPE[e.type] && <span className="ml-1.5 text-[10px] uppercase tracking-widest text-[#002FA7]">{IM_TYPE[e.type]}</span>}
                </span>
                <span className="text-[10px] text-gray-500 font-mono">{fmtSmartLong(e.at)}</span>
              </div>
              <div className="text-gray-700 break-words">{e.what || "—"}</div>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
