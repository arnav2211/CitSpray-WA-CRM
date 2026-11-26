import { api } from "@/lib/api";

// Open (or download) a library document. Files are private, so fetch with the
// login token and hand the browser a blob.
export async function openDoc(id, { download = false, name = "document.pdf" } = {}) {
  const res = await api.get(`/docs/documents/${id}/file`, { params: { download }, responseType: "blob" });
  openBlob(res.data, download ? name : null);
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
