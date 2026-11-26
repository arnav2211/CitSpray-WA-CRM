import React, { useEffect, useRef, useState } from "react";
import { X, Plus, Trash, ArrowUp, ArrowDown, Eye, DownloadSimple, FloppyDisk } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { openBlob } from "@/lib/docs";

/* COA maker: any parameters, any number of tables, optional info rows (batch no,
   CAS, quantity ... - leave a value empty and the row is left out), dates that
   follow the current month ("auto") or stay fixed ("locked"), optional plain page
   without the company letterhead. Preview, download only, or save to the library
   (for the whole team, or only for the system admin). */

export const BLANK_COA = () => ({
  title: "CERTIFICATE OF ANALYSIS",
  letterhead: true,
  info: [
    { label: "COMMON NAME", value: "" },
    { label: "BATCH NO", value: "" },
    { label: "CAS No.", value: "" },
    { label: "BATCH QTY", value: "" },
  ],
  show_mfg: true, mfg_label: "MFG.DATE",
  show_exp: true, exp_label: "EXP.DATE",
  date_mode: "auto", mfg_month: "", exp_month: "", shelf_life_months: 24,
  sections: [{
    title: "PHYSICO-CHEMICAL PROPERTIES",
    columns: ["Parameters", "Specification", "Results"],
    rows: [
      ["COLOUR AND APPEARANCE", "", "Complies"],
      ["ODOUR", "", "Complies"],
      ["SOLUBILITY", "", ""],
      ["REFRACTIVE INDEX @ 20 °C", "", "Complies"],
      ["SPECIFIC GRAVITY @ 20 °C", "", "Complies"],
      ["OPTICAL ROTATION @ 20 °C", "", "Complies"],
    ],
  }],
  note_mode: "standard",           // the same note on every COA (editable once for all)
  note: "",
});

const SR_COL = /^(s\.?\s*no\.?|sr\.?\s*no\.?|sl\.?\s*no\.?|no\.?|#)$/i;
// the column that holds parameter names (skips a "Sr. No." column)
const paramCol = (s) => (s.columns.length > 2 && SR_COL.test(String(s.columns[0] || "").trim()) ? 1 : 0);

const inp = "w-full border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-[#002FA7]";
const lbl = "text-[10px] uppercase tracking-widest text-gray-500 font-bold";

// spelling: replace whole words only (keeps codes like MG/CTS10SEMA intact)
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function fixText(text, word, sugg) {
  return String(text ?? "").replace(new RegExp(`(?<![A-Za-z0-9])${escRe(word)}(?![A-Za-z0-9])`, "g"), sugg);
}
function applyIssue(coa, it) {
  const c = JSON.parse(JSON.stringify(coa));
  const path = it.path;
  let obj = c;
  for (let i = 0; i < path.length - 1; i += 1) obj = obj?.[path[i]];
  const last = path[path.length - 1];
  if (obj && obj[last] != null) obj[last] = fixText(obj[last], it.word, it.suggestion);
  return c;
}
const pathKey = (p) => p.join(".");

function move(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const a = [...arr]; [a[i], a[j]] = [a[j], a[i]]; return a;
}

export default function CoaMaker({ products, productId, existing, duplicateOf, isAdmin, onClose, onSaved }) {
  const src = existing || duplicateOf;
  const [coa, setCoa] = useState(() => (src?.coa ? JSON.parse(JSON.stringify(src.coa)) : BLANK_COA()));
  const [oilName, setOilName] = useState(() => products.find((p) => p.id === (src?.product_id || productId))?.name || "");
  const [sugg, setSugg] = useState({ parameters: [], results: ["Complies"], standard_note: "" });
  const [stdEdit, setStdEdit] = useState(null);   // text while editing the standard note
  const [spell, setSpell] = useState([]);          // [{path, word, suggestion}]
  const [title, setTitle] = useState(existing ? existing.title : duplicateOf ? `${duplicateOf.title} (copy)` : "");
  const [visibility, setVisibility] = useState(existing?.visibility || "team");
  const [previewUrl, setPreviewUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const urlRef = useRef(null);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  useEffect(() => { api.get("/docs/coa/suggestions").then(({ data }) => setSugg(data)).catch(() => {}); }, []);
  // spelling check a moment after typing stops
  useEffect(() => {
    const t = setTimeout(() => {
      api.post("/docs/coa/spellcheck", { coa }).then(({ data }) => setSpell(data.issues || [])).catch(() => {});
    }, 700);
    return () => clearTimeout(t);
  }, [coa]);
  const badPaths = new Set(spell.map((i) => pathKey(i.path)));
  const warn = (path) => (badPaths.has(pathKey(path)) ? " !border-amber-500 bg-amber-50" : "");
  const fixOne = (it) => setCoa((c) => applyIssue(c, it));
  const fixAllIn = (c) => spell.reduce((acc, it) => applyIssue(acc, it), c);
  // before preview / download / save: offer to fix spelling first
  const checked = async (fn) => {
    let c = coa;
    if (spell.length) {
      const list = [...new Map(spell.map((i) => [i.word, i])).values()].map((i) => `${i.word} -> ${i.suggestion}`).join(", ");
      if (window.confirm(`Spelling looks wrong: ${list}\n\nOK = fix them now, Cancel = keep as typed`)) {
        c = fixAllIn(coa);
        setCoa(c);
      }
    }
    return fn(c);
  };

  const set = (patch) => setCoa((c) => ({ ...c, ...patch }));
  const setInfo = (i, patch) => set({ info: coa.info.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const setSec = (si, patch) => set({ sections: coa.sections.map((s, k) => (k === si ? { ...s, ...patch } : s)) });
  const setCell = (si, ri, ci, v) => setSec(si, {
    rows: coa.sections[si].rows.map((r, k) => (k === ri ? r.map((x, c) => (c === ci ? v : x)) : r)),
  });
  const setCol = (si, ci, v) => setSec(si, { columns: coa.sections[si].columns.map((x, c) => (c === ci ? v : x)) });
  const addCol = (si) => {
    const s = coa.sections[si];
    if (s.columns.length >= 5) return;
    setSec(si, { columns: [...s.columns, "New column"], rows: s.rows.map((r) => [...r, ""]) });
  };
  // new parameter row: numbered if the table has a Sr. No. column, result "Complies"
  const addRow = (si, name = "") => {
    const s = coa.sections[si];
    const n = s.columns.length, pc = paramCol(s);
    const row = s.columns.map(() => "");
    if (pc === 1) row[0] = String(s.rows.length + 1);
    row[pc] = name;
    if (n - 1 !== pc) row[n - 1] = "Complies";
    setSec(si, { rows: [...s.rows, row] });
  };
  const delCol = (si, ci) => {
    const s = coa.sections[si];
    if (s.columns.length <= 2) return;
    setSec(si, { columns: s.columns.filter((_, c) => c !== ci), rows: s.rows.map((r) => r.filter((_, c) => c !== ci)) });
  };

  const matched = products.find((p) => p.name.trim().toLowerCase() === oilName.trim().toLowerCase());
  const pid = matched?.id || "";
  const productName = matched?.name || oilName.trim();
  const payload = (useId = pid, c = coa) => ({ coa: c, product_id: useId || null, title: title || undefined, visibility, kind: "coa" });
  const saveStdNote = async () => {
    try {
      const { data } = await api.put("/docs/coa/standard-note", { text: stdEdit });
      setSugg((x) => ({ ...x, standard_note: data.text })); setStdEdit(null);
      toast.success("Standard note updated - every COA using it now shows the new note");
    } catch (e) { toast.error(errMsg(e, "Could not save the note")); }
  };

  const render = async (c = coa) => {
    const res = await api.post("/docs/coa/render", payload(pid, c), { responseType: "blob" });
    return res.data;
  };

  const preview = () => checked(async (c) => {
    setBusy(true);
    try {
      const blob = await render(c);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(blob);
      setPreviewUrl(urlRef.current);
    } catch (e) { toast.error(errMsg(e, "Preview failed")); }
    finally { setBusy(false); }
  });

  const downloadOnly = () => checked(async (c) => {
    setBusy(true);
    try {
      const blob = await render(c);
      const name = (title || `${productName || coa.info?.[0]?.value || "COA"} - ${coa.title || "COA"}`).replace(/[\\/:*?"<>|]+/g, " ");
      openBlob(blob, `${name}.pdf`);
      toast.success("Downloaded - not saved in the CRM");
    } catch (e) { toast.error(errMsg(e, "Download failed")); }
    finally { setBusy(false); }
  });

  const save = () => checked(async (c) => {
    if (!oilName.trim()) { toast.error("Type the oil this COA belongs to"); return; }
    setBusy(true);
    try {
      let useId = pid;
      if (existing) {
        await api.put(`/docs/documents/${existing.id}`, { title: title || existing.title, visibility, coa: c });
        useId = existing.product_id;
      } else {
        if (!useId) {   // a new oil: add it on the fly
          const { data: p } = await api.post("/docs/products", { name: oilName.trim(), aliases: [] });
          useId = p.id;
        }
        await api.post("/docs/coa", payload(useId, c));
      }
      toast.success(visibility === "admin" ? "Saved - only the system admin can see it" : "Saved to the library");
      onSaved?.(useId);
    } catch (e) { toast.error(errMsg(e, "Save failed")); }
    finally { setBusy(false); }
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch md:items-center justify-center p-0 md:p-4" data-testid="coa-maker">
      <datalist id="coa-params">{sugg.parameters.map((p) => <option key={p.name} value={p.name} />)}</datalist>
      <datalist id="coa-results">{sugg.results.map((r) => <option key={r} value={r} />)}</datalist>
      <datalist id="coa-oils">{products.map((p) => <option key={p.id} value={p.name} />)}</datalist>
      <div className="bg-white w-full max-w-6xl h-full md:h-[92vh] flex flex-col shadow-2xl">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="font-chivo font-black text-lg">{existing ? "Edit COA" : "COA maker"}</div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-900"><X size={18} /></button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          <div className="flex-1 min-w-0 overflow-y-auto p-4 space-y-5">
            {/* Heading */}
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <div className={lbl}>Heading on the document</div>
                <input className={inp + warn(["title"])} value={coa.title} onChange={(e) => set({ title: e.target.value })} placeholder="CERTIFICATE OF ANALYSIS" />
              </div>
              <label className="flex items-center gap-2 text-sm mt-4 md:mt-5">
                <input type="checkbox" checked={coa.letterhead !== false} onChange={(e) => set({ letterhead: e.target.checked })} />
                Company letterhead <span className="text-gray-400 text-xs">(untick for a plain page)</span>
              </label>
            </div>

            {/* Info rows */}
            <div>
              <div className="flex items-center justify-between">
                <div className={lbl}>Details (rows with an empty value are left out)</div>
                <button onClick={() => set({ info: [...coa.info, { label: "", value: "" }] })} className="text-xs text-[#002FA7] font-bold flex items-center gap-1"><Plus size={12} /> Row</button>
              </div>
              <div className="space-y-1 mt-1">
                {coa.info.map((r, i) => (
                  <div key={i} className="flex gap-1 items-center">
                    <input className={`${inp.replace("w-full ", "")} w-28 md:w-40 shrink-0${warn(["info", i, "label"])}`} value={r.label} onChange={(e) => setInfo(i, { label: e.target.value })} placeholder="Label" />
                    <input className={`${inp} min-w-0 flex-1${warn(["info", i, "value"])}`} value={r.value} onChange={(e) => setInfo(i, { value: e.target.value })} placeholder="Value (empty = not shown)" />
                    <button onClick={() => set({ info: move(coa.info, i, -1) })} className="p-1 text-gray-400 hover:text-gray-800"><ArrowUp size={14} /></button>
                    <button onClick={() => set({ info: move(coa.info, i, 1) })} className="p-1 text-gray-400 hover:text-gray-800"><ArrowDown size={14} /></button>
                    <button onClick={() => set({ info: coa.info.filter((_, k) => k !== i) })} className="p-1 text-gray-400 hover:text-[#E60000]"><Trash size={14} /></button>
                  </div>
                ))}
              </div>
            </div>

            {/* Dates */}
            <div className="border border-gray-200 p-3 space-y-2">
              <div className={lbl}>Dates</div>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-1"><input type="radio" checked={coa.date_mode !== "locked"} onChange={() => set({ date_mode: "auto" })} /> Change every month (auto)</label>
                <label className="flex items-center gap-1"><input type="radio" checked={coa.date_mode === "locked"} onChange={() => set({ date_mode: "locked" })} /> Locked (never changes)</label>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
                <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={coa.show_mfg !== false} onChange={(e) => set({ show_mfg: e.target.checked })} /> Show mfg. date</label>
                <input className={inp} value={coa.mfg_label} onChange={(e) => set({ mfg_label: e.target.value })} placeholder="MFG.DATE" />
                <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={coa.show_exp !== false} onChange={(e) => set({ show_exp: e.target.checked })} /> Show exp. date</label>
                <input className={inp} value={coa.exp_label} onChange={(e) => set({ exp_label: e.target.value })} placeholder="EXP.DATE" />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {coa.date_mode === "locked" ? (
                  <>
                    <div><div className={lbl}>Mfg. month</div><input type="month" className={inp} value={coa.mfg_month || ""} onChange={(e) => set({ mfg_month: e.target.value })} /></div>
                    <div><div className={lbl}>Exp. month (or use shelf life)</div><input type="month" className={inp} value={coa.exp_month || ""} onChange={(e) => set({ exp_month: e.target.value })} /></div>
                    <div><div className={lbl}>Mfg. date as printed (optional)</div><input className={inp} value={coa.mfg_text || ""} onChange={(e) => set({ mfg_text: e.target.value })} placeholder="e.g. 02-08-2025" /></div>
                    <div><div className={lbl}>Exp. date as printed (optional)</div><input className={inp} value={coa.exp_text || ""} onChange={(e) => set({ exp_text: e.target.value })} placeholder="e.g. 01-08-2028" /></div>
                  </>
                ) : (
                  <div className="text-xs text-gray-500 col-span-2 self-end">Mfg. date = the current month from the 10th (before the 10th: last month). Exp. = mfg. + shelf life.</div>
                )}
                <div><div className={lbl}>Shelf life (months)</div><input type="number" min="0" className={inp} value={coa.shelf_life_months ?? ""} onChange={(e) => set({ shelf_life_months: e.target.value === "" ? "" : Number(e.target.value) })} /></div>
              </div>
            </div>

            {/* Tables */}
            {coa.sections.map((s, si) => (
              <div key={si} className="border border-gray-200 p-3 space-y-2">
                <div className="flex gap-2 items-center">
                  <input className={`${inp} font-bold${warn(["sections", si, "title"])}`} value={s.title} onChange={(e) => setSec(si, { title: e.target.value })} placeholder="Table heading (optional)" />
                  <button onClick={() => addCol(si)} className="text-xs text-[#002FA7] font-bold whitespace-nowrap flex items-center gap-1"><Plus size={12} /> Column</button>
                  <button onClick={() => set({ sections: coa.sections.filter((_, k) => k !== si) })} className="p-1 text-gray-400 hover:text-[#E60000]" title="Remove table"><Trash size={14} /></button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        {s.columns.map((c, ci) => (
                          <th key={ci} className="p-0.5">
                            <div className="flex">
                              <input className={`${inp} font-bold bg-gray-50${warn(["sections", si, "columns", ci])}`} value={c} onChange={(e) => setCol(si, ci, e.target.value)} />
                              {s.columns.length > 2 && <button onClick={() => delCol(si, ci)} className="px-1 text-gray-400 hover:text-[#E60000]"><X size={12} /></button>}
                            </div>
                          </th>
                        ))}
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {s.rows.map((r, ri) => (
                        <tr key={ri}>
                          {s.columns.map((_, ci) => (
                            <td key={ci} className="p-0.5">
                              <input className={inp + warn(["sections", si, "rows", ri, ci])} value={r[ci] ?? ""} onChange={(e) => setCell(si, ri, ci, e.target.value)}
                                list={ci === paramCol(s) ? "coa-params" : ci === s.columns.length - 1 ? "coa-results" : undefined} />
                            </td>
                          ))}
                          <td className="whitespace-nowrap">
                            <button onClick={() => setSec(si, { rows: move(s.rows, ri, -1) })} className="p-1 text-gray-400 hover:text-gray-800"><ArrowUp size={12} /></button>
                            <button onClick={() => setSec(si, { rows: move(s.rows, ri, 1) })} className="p-1 text-gray-400 hover:text-gray-800"><ArrowDown size={12} /></button>
                            <button onClick={() => setSec(si, { rows: s.rows.filter((_, k) => k !== ri) })} className="p-1 text-gray-400 hover:text-[#E60000]"><Trash size={12} /></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button onClick={() => addRow(si)} className="text-xs text-[#002FA7] font-bold flex items-center gap-1"><Plus size={12} /> Parameter</button>
                {sugg.parameters.length > 0 && (
                  <div className="flex flex-wrap gap-1 items-center">
                    <span className="text-[10px] uppercase tracking-widest text-gray-400 font-bold mr-1">Quick add:</span>
                    {sugg.parameters
                      .filter((p) => !s.rows.some((r) => String(r[paramCol(s)] || "").trim().toUpperCase() === p.name.toUpperCase()))
                      .slice(0, 16)
                      .map((p) => (
                        <button key={p.name} type="button" onClick={() => addRow(si, p.name)}
                          className="text-[11px] border border-gray-300 px-1.5 py-0.5 hover:bg-[#EEF3FF] hover:border-[#002FA7]">+ {p.name}</button>
                      ))}
                  </div>
                )}
              </div>
            ))}
            <button onClick={() => set({ sections: [...coa.sections, { title: "", columns: ["Parameters", "Specification", "Results"], rows: [["", "", ""]] }] })}
              className="text-xs border border-dashed border-gray-400 px-3 py-2 w-full font-bold text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-1">
              <Plus size={12} /> Add another table (e.g. GC composition)
            </button>

            <div className="space-y-1.5">
              <div className={lbl}>Note at the bottom</div>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-1"><input type="radio" checked={coa.note_mode === "standard"} onChange={() => set({ note_mode: "standard" })} /> Standard note (same on every COA)</label>
                <label className="flex items-center gap-1"><input type="radio" checked={coa.note_mode !== "standard"}
                  onChange={() => set({ note_mode: "custom", note: coa.note || sugg.standard_note })} /> Own note for this COA</label>
              </div>
              {coa.note_mode === "standard" ? (
                stdEdit === null ? (
                  <div className="flex items-start gap-2">
                    <div className="flex-1 bg-gray-50 border border-gray-200 px-2 py-1.5 text-sm text-gray-700">{sugg.standard_note || "..."}</div>
                    <button type="button" onClick={() => setStdEdit(sugg.standard_note)} className="text-xs text-[#002FA7] font-bold whitespace-nowrap pt-1.5">Edit standard note</button>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <textarea rows={2} className={inp} value={stdEdit} onChange={(e) => setStdEdit(e.target.value)} />
                    <div className="flex items-center gap-2 flex-wrap">
                      <button type="button" onClick={saveStdNote} className="bg-[#002FA7] text-white text-[11px] font-bold px-2 py-1">Save for all COAs</button>
                      <button type="button" onClick={() => setStdEdit(null)} className="text-[11px] text-gray-500">Cancel</button>
                      <span className="text-[11px] text-gray-500">Changes the note on every COA that uses the standard note.</span>
                    </div>
                  </div>
                )
              ) : (
                <textarea rows={2} className={inp} value={coa.note} onChange={(e) => set({ note: e.target.value })} />
              )}
            </div>

            {/* Save options */}
            <div className="border-t border-gray-200 pt-3 grid md:grid-cols-3 gap-2">
              <div>
                <div className={lbl}>Oil (type to search)</div>
                <input className={inp} list="coa-oils" value={oilName} onChange={(e) => setOilName(e.target.value)}
                  disabled={!!existing} placeholder="e.g. Lavender Oil" data-testid="coa-oil-input" />
                {!existing && oilName.trim() && !matched && <div className="text-[11px] text-[#B36200] mt-0.5">New oil - it will be added when you save</div>}
              </div>
              <div>
                <div className={lbl}>Name in the library</div>
                <input className={inp} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={productName ? `${productName} - COA` : "e.g. Lemongrass Oil - COA (70% citral)"} />
              </div>
              <div>
                <div className={lbl}>Who can see it</div>
                <select className={inp} value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                  <option value="team">Everyone (executives can send it)</option>
                  {isAdmin && <option value="admin">Only system admin</option>}
                  {!isAdmin && <option value="admin">Only system admin (you won't see it after saving)</option>}
                </select>
              </div>
            </div>
          </div>

          <div className="md:w-[44%] border-t md:border-t-0 md:border-l border-gray-200 bg-gray-100 flex flex-col min-h-[300px]">
            {previewUrl ? (
              <iframe title="COA preview" src={previewUrl} className="flex-1 w-full bg-white" />
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-gray-500 p-6 text-center">
                Press <b className="mx-1">Preview</b> to see the PDF exactly as the customer gets it.
              </div>
            )}
          </div>
        </div>
        {spell.length > 0 && (
          <div className="px-4 py-2 border-t border-amber-300 bg-amber-50 text-xs text-amber-900 flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="coa-spelling">
            <b>Spelling:</b>
            {[...new Map(spell.map((i) => [i.word + ">" + i.suggestion, i])).values()].map((it) => (
              <button key={it.word + it.suggestion} type="button" onClick={() => spell.filter((x) => x.word === it.word && x.suggestion === it.suggestion).forEach(fixOne)}
                className="border border-amber-400 bg-white px-1.5 py-0.5 hover:bg-amber-100" title="Fix">
                <s className="opacity-60">{it.word}</s> &rarr; <b>{it.suggestion}</b>
              </button>
            ))}
            <button type="button" onClick={() => setCoa((c) => fixAllIn(c))} className="ml-auto bg-amber-600 text-white font-bold px-2 py-1">Fix all</button>
          </div>
        )}
        <div className="px-4 py-3 border-t border-gray-200 flex flex-wrap items-center justify-end gap-2">
          <button onClick={preview} disabled={busy} className="border border-gray-300 px-3 py-2 text-xs font-bold uppercase tracking-widest flex items-center gap-1 hover:bg-gray-50 disabled:opacity-50"><Eye size={14} /> Preview</button>
          <button onClick={downloadOnly} disabled={busy} className="border border-gray-300 px-3 py-2 text-xs font-bold uppercase tracking-widest flex items-center gap-1 hover:bg-gray-50 disabled:opacity-50" data-testid="coa-download-only"><DownloadSimple size={14} /> Download only (don't save)</button>
          <button onClick={save} disabled={busy} className="bg-[#002FA7] hover:bg-[#002288] text-white px-4 py-2 text-xs font-bold uppercase tracking-widest flex items-center gap-1 disabled:opacity-50" data-testid="coa-save"><FloppyDisk size={14} /> {existing ? "Save changes" : "Save to library"}</button>
        </div>
      </div>
    </div>
  );
}
