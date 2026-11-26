import { api } from "@/lib/api";

// Open (or download) a library document. Files are private: ask the server for a
// short-lived signed link first. Uses a short-lived signed link (not a blob) so it also works inside the
// LeadOrbit phone app's WebView, which can't open blob: URLs.
export async function openDoc(id, { download = false } = {}) {
  const w = window.open("", "_blank");   // open now, inside the click, so popup blockers allow it
  try {
    const { data } = await api.post(`/docs/documents/${id}/link`, null, { params: { download } });
    const url = `${window.location.origin}${data.url}`;
    if (w) w.location.href = url; else window.location.href = url;
  } catch (e) {
    if (w) w.close();
    throw e;
  }
}

export function openBlob(blob, downloadName) {
  const url = URL.createObjectURL(blob);
  if (downloadName) {
    const a = document.createElement("a");
    a.href = url; a.download = downloadName;
    document.body.appendChild(a); a.click(); a.remove();
  } else {
    window.open(url, "_blank", "noopener");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const KIND_ORDER = ["coa", "gcms", "tds", "msds", "ifra", "spec", "other"];
export const KIND_COLORS = {
  coa: "bg-[#002FA7] text-white", gcms: "bg-[#7C3AED] text-white", tds: "bg-[#0F766E] text-white",
  msds: "bg-[#B45309] text-white", ifra: "bg-[#BE185D] text-white", spec: "bg-gray-700 text-white", other: "bg-gray-200 text-gray-800",
};
