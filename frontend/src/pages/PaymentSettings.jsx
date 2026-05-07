import React, { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { Plus, Trash, FloppyDisk, QrCode, Bank } from "@phosphor-icons/react";

const BLANK_ACCOUNT = {
  id: "",
  label: "",
  name: "",
  bank: "",
  branch: "",
  ifsc: "",
  account_number: "",
  upi_phone: "",
  upi_id: "",
};

export default function PaymentSettings() {
  const [data, setData] = useState({ gst: [], no_gst: [] });
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("gst");

  const load = async () => {
    try {
      const { data: res } = await api.get("/settings/payment-qr");
      setData({ gst: res.gst || [], no_gst: res.no_gst || [] });
    } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const updateAccount = (bucket, idx, patch) => {
    setData((d) => ({
      ...d,
      [bucket]: d[bucket].map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    }));
  };
  const removeAccount = (bucket, idx) => {
    if (!window.confirm("Remove this account?")) return;
    setData((d) => ({ ...d, [bucket]: d[bucket].filter((_, i) => i !== idx) }));
  };
  const addAccount = (bucket) => {
    setData((d) => ({ ...d, [bucket]: [...d[bucket], { ...BLANK_ACCOUNT }] }));
  };

  const save = async () => {
    // Light validation — every account must have label, name, ifsc, account_number, upi_id.
    for (const bucket of ["gst", "no_gst"]) {
      for (const [i, a] of data[bucket].entries()) {
        for (const f of ["label", "name", "bank", "ifsc", "account_number", "upi_id"]) {
          if (!(a[f] || "").trim()) {
            toast.error(`${bucket === "gst" ? "GST" : "Without GST"} #${i + 1}: ${f.replace("_", " ")} is required`);
            return;
          }
        }
      }
    }
    setSaving(true);
    try {
      await api.put("/settings/payment-qr", data);
      toast.success("Payment QR settings saved");
      await load();
    } catch (e) { toast.error(errMsg(e, "Save failed")); }
    finally { setSaving(false); }
  };

  const renderBucket = (bucket) => {
    const list = data[bucket] || [];
    const title = bucket === "gst" ? "GST" : "Without GST";
    return (
      <div className="space-y-4" data-testid={`bucket-${bucket}`}>
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">{title} accounts ({list.length})</div>
          <button onClick={() => addAccount(bucket)} className="text-[#002FA7] hover:underline text-[10px] uppercase tracking-widest font-bold flex items-center gap-1" data-testid={`add-${bucket}-btn`}>
            <Plus size={12} weight="bold" /> Add account
          </button>
        </div>
        {list.length === 0 ? (
          <div className="border border-dashed border-gray-300 px-4 py-8 text-center text-xs uppercase tracking-widest text-gray-400">
            No accounts yet — click "Add account"
          </div>
        ) : list.map((a, i) => (
          <div key={i} className="border border-gray-200 bg-white p-4 space-y-3" data-testid={`acct-${bucket}-${i}`}>
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center gap-2">
                <Bank size={14} className="text-[#002FA7]" />
                Account #{i + 1}
              </div>
              <button onClick={() => removeAccount(bucket, i)} className="text-[#E60000] hover:text-[#A00000] p-1" title="Remove" data-testid={`remove-${bucket}-${i}`}>
                <Trash size={14} />
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Label (shown in /chat picker)">
                <input value={a.label} onChange={(e) => updateAccount(bucket, i, { label: e.target.value })}
                  placeholder="e.g. Mangalam Agro · PNB"
                  className="w-full border border-gray-300 px-2 py-1.5 text-sm" data-testid={`fld-label-${bucket}-${i}`} />
              </Field>
              <Field label="Name (account holder)">
                <input value={a.name} onChange={(e) => updateAccount(bucket, i, { name: e.target.value })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-sm" data-testid={`fld-name-${bucket}-${i}`} />
              </Field>
              <Field label="Bank">
                <input value={a.bank} onChange={(e) => updateAccount(bucket, i, { bank: e.target.value })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-sm" data-testid={`fld-bank-${bucket}-${i}`} />
              </Field>
              <Field label="Branch">
                <input value={a.branch || ""} onChange={(e) => updateAccount(bucket, i, { branch: e.target.value })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-sm" data-testid={`fld-branch-${bucket}-${i}`} />
              </Field>
              <Field label="IFSC">
                <input value={a.ifsc} onChange={(e) => updateAccount(bucket, i, { ifsc: e.target.value.toUpperCase() })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-sm font-mono" data-testid={`fld-ifsc-${bucket}-${i}`} />
              </Field>
              <Field label="Account Number">
                <input value={a.account_number} onChange={(e) => updateAccount(bucket, i, { account_number: e.target.value.replace(/\D/g, "") })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-sm font-mono" data-testid={`fld-acno-${bucket}-${i}`} />
              </Field>
              <Field label="UPI No. (linked phone) — optional">
                <input value={a.upi_phone || ""} onChange={(e) => updateAccount(bucket, i, { upi_phone: e.target.value.replace(/\D/g, "") })}
                  className="w-full border border-gray-300 px-2 py-1.5 text-sm font-mono" data-testid={`fld-upiphone-${bucket}-${i}`} />
              </Field>
              <Field label="UPI ID (the QR will encode this)">
                <input value={a.upi_id} onChange={(e) => updateAccount(bucket, i, { upi_id: e.target.value.trim() })}
                  placeholder="someone@okicici"
                  className="w-full border border-gray-300 px-2 py-1.5 text-sm font-mono" data-testid={`fld-upiid-${bucket}-${i}`} />
              </Field>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="p-4 md:p-8 space-y-4 max-w-4xl">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Settings</div>
        <h1 className="font-chivo font-black text-2xl md:text-4xl flex items-center gap-2">
          <QrCode size={28} weight="bold" className="text-[#002FA7]" /> Payment QR — Bank Accounts
        </h1>
        <p className="text-sm text-gray-600 mt-1 max-w-2xl">
          Manage the UPI accounts used for the in-chat Payment QR attachment. Edits here are reflected
          immediately — agents will see the new label / UPI ID the next time they open the picker.
          Whole-rupee amounts only; the QR is regenerated for every send.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex border border-gray-300">
        {[
          { k: "gst", label: `GST (${data.gst.length})` },
          { k: "no_gst", label: `Without GST (${data.no_gst.length})` },
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`flex-1 px-3 py-2 text-[11px] uppercase tracking-widest font-bold ${tab === t.k ? "bg-gray-900 text-white" : "bg-white hover:bg-gray-50"}`}
            data-testid={`tab-${t.k}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "gst" ? renderBucket("gst") : renderBucket("no_gst")}

      <div className="sticky bottom-0 -mx-4 md:-mx-8 px-4 md:px-8 py-3 bg-white border-t border-gray-200 flex justify-end">
        <button onClick={save} disabled={saving}
          className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-[10px] uppercase tracking-widest font-bold flex items-center gap-1 disabled:opacity-50"
          data-testid="pqr-settings-save-btn">
          <FloppyDisk size={12} weight="bold" /> {saving ? "Saving…" : "Save all changes"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">{label}</div>
      {children}
    </label>
  );
}
