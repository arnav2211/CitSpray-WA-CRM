import React, { useState } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { FileArrowUp, Plus, Trash, DownloadSimple, CheckCircle, Warning, XCircle } from "@phosphor-icons/react";

const SOURCES = ["IndiaMART", "Justdial", "ExportersIndia", "Excel Upload", "Manual", "Web", "Others"];

export default function DataEntry() {
  const [activeTab, setActiveTab] = useState("manual"); // "manual" or "bulk"

  // Manual Form State
  const [manualForm, setManualForm] = useState({
    customer_name: "",
    phone: "",
    requirement: "",
    gst_no: "",
    enquiry_type: "",
    source: "Manual",
    city: "",
    state: "",
    area: "",
  });
  const [savingManual, setSavingManual] = useState(false);

  // Bulk Upload State
  const [bulkFile, setBulkFile] = useState(null);
  const [bulkSource, setBulkSource] = useState("Excel Upload");
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(null);

  // Custom Month and Year State
  const currentMonth = new Date().getMonth() + 1; // 1-12
  const currentYear = new Date().getFullYear();
  const [backdateEnabled, setBackdateEnabled] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth.toString());
  const [selectedYear, setSelectedYear] = useState(currentYear.toString());

  // Handle Manual Form Change
  const handleManualChange = (e) => {
    const { name, value } = e.target;
    setManualForm((prev) => ({ ...prev, [name]: value }));
  };

  // Submit Manual Form
  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (!manualForm.customer_name.trim()) {
      toast.error("Customer Name is required");
      return;
    }
    setSavingManual(true);
    try {
      const { data } = await api.post("/leads", manualForm);
      if (data.duplicate) {
        toast.warning(`Duplicate lead. Updated existing lead. Assigned to: ${data.assigned_to_name || "Unassigned"}`);
      } else {
        toast.success(`Lead created successfully! Assigned to: ${data.assigned_to_name || "Executive"}`);
      }
      // Reset form
      setManualForm({
        customer_name: "",
        phone: "",
        requirement: "",
        gst_no: "",
        enquiry_type: "",
        source: "Manual",
        city: "",
        state: "",
        area: "",
      });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSavingManual(false);
    }
  };

  // Handle File Input
  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setBulkFile(file);
      setUploadResult(null);
    }
  };

  // Download Template
  const handleDownloadTemplate = async () => {
    try {
      const response = await api.get("/leads/upload-template", { responseType: "blob" });
      const blob = new Blob([response.data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", "leads_upload_template.xlsx");
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success("Template downloaded");
    } catch (err) {
      toast.error("Failed to download template: " + errMsg(err));
    }
  };

  // Submit Bulk Upload
  const handleBulkSubmit = async (e) => {
    e.preventDefault();
    if (!bulkFile) {
      toast.error("Please select a file to upload");
      return;
    }
    setUploading(true);
    setUploadResult(null);
    setProgress(null);
    try {
      const formData = new FormData();
      formData.append("file", bulkFile);
      formData.append("source", bulkSource);
      if (backdateEnabled) {
        formData.append("month", selectedMonth);
        formData.append("year", selectedYear);
      }

      const { data } = await api.post("/leads/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      if (data.success && data.upload_id) {
        setUploading(false);
        setProcessing(true);
        const uploadId = data.upload_id;
        
        // Start polling status
        const interval = setInterval(async () => {
          try {
            const res = await api.get(`/leads/upload/status/${uploadId}`);
            const statusData = res.data;
            setProgress(statusData);
            if (statusData.status === "completed") {
              clearInterval(interval);
              setProcessing(false);
              setUploadResult(statusData);
              toast.success(`Successfully uploaded ${statusData.summary?.imported} leads!`);
            } else if (statusData.status === "failed") {
              clearInterval(interval);
              setProcessing(false);
              toast.error("Bulk upload processing failed on server");
            }
          } catch (pollErr) {
            clearInterval(interval);
            setProcessing(false);
            toast.error("Error polling upload status: " + errMsg(pollErr));
          }
        }, 800);
      } else {
        setUploading(false);
        toast.error("Upload failed to start");
      }
    } catch (err) {
      setUploading(false);
      toast.error(errMsg(err));
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Workspace</div>
        <h1 className="font-chivo font-black text-2xl md:text-4xl text-gray-900">Lead Entry</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manually enter leads or upload an Excel sheet. leads are automatically distributed via round-robin.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        <button
          onClick={() => setActiveTab("manual")}
          className={`px-5 py-3 text-xs uppercase tracking-wider font-bold border-b-2 transition-all ${
            activeTab === "manual"
              ? "border-[#002FA7] text-[#002FA7]"
              : "border-transparent text-gray-500 hover:text-gray-900"
          }`}
        >
          Manual Lead Entry
        </button>
        <button
          onClick={() => setActiveTab("bulk")}
          className={`px-5 py-3 text-xs uppercase tracking-wider font-bold border-b-2 transition-all ${
            activeTab === "bulk"
              ? "border-[#002FA7] text-[#002FA7]"
              : "border-transparent text-gray-500 hover:text-gray-900"
          }`}
        >
          Bulk Excel Upload
        </button>
      </div>

      {/* Manual Lead Entry Card */}
      {activeTab === "manual" && (
        <div className="border border-gray-200 bg-white p-6 md:p-8 space-y-6 shadow-sm">
          <form onSubmit={handleManualSubmit} className="space-y-6">
            <h2 className="font-chivo font-bold text-lg text-gray-900 pb-2 border-b border-gray-100">
              Customer Information
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                  Customer Name *
                </span>
                <input
                  required
                  type="text"
                  name="customer_name"
                  value={manualForm.customer_name}
                  onChange={handleManualChange}
                  placeholder="e.g. John Doe"
                  className="w-full border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-[#002FA7]"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                  Phone / Mobile Number
                </span>
                <input
                  type="text"
                  name="phone"
                  value={manualForm.phone}
                  onChange={handleManualChange}
                  placeholder="e.g. 9876543210"
                  className="w-full border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-[#002FA7]"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                  GST Number
                </span>
                <input
                  type="text"
                  name="gst_no"
                  value={manualForm.gst_no}
                  onChange={handleManualChange}
                  placeholder="e.g. 27AAAAA1111A1Z1"
                  className="w-full border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-[#002FA7] uppercase"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                  Enquiry Source
                </span>
                <select
                  name="source"
                  value={manualForm.source}
                  onChange={handleManualChange}
                  className="w-full border border-gray-300 px-2 py-2 text-sm focus:outline-none focus:border-[#002FA7]"
                >
                  {SOURCES.map((src) => (
                    <option key={src} value={src}>
                      {src}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                  Enquiry Type
                </span>
                <input
                  type="text"
                  name="enquiry_type"
                  value={manualForm.enquiry_type}
                  onChange={handleManualChange}
                  placeholder="e.g. Dealership / Retail / Bulk"
                  className="w-full border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-[#002FA7]"
                />
              </label>
            </div>

            <h2 className="font-chivo font-bold text-lg text-gray-900 pt-4 pb-2 border-b border-gray-100">
              Requirement & Location
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                  Area / Locality
                </span>
                <input
                  type="text"
                  name="area"
                  value={manualForm.area}
                  onChange={handleManualChange}
                  placeholder="e.g. MIDC Phase 2"
                  className="w-full border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-[#002FA7]"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                  City
                </span>
                <input
                  type="text"
                  name="city"
                  value={manualForm.city}
                  onChange={handleManualChange}
                  placeholder="e.g. Pune"
                  className="w-full border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-[#002FA7]"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                  State
                </span>
                <input
                  type="text"
                  name="state"
                  value={manualForm.state}
                  onChange={handleManualChange}
                  placeholder="e.g. Maharashtra"
                  className="w-full border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-[#002FA7]"
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                Detailed Requirement
              </span>
              <textarea
                name="requirement"
                rows={4}
                value={manualForm.requirement}
                onChange={handleManualChange}
                placeholder="Describe user requirement, citrus spray type, capacity, etc."
                className="w-full border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-[#002FA7] resize-y"
              />
            </label>

            <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
              <button
                type="button"
                onClick={() =>
                  setManualForm({
                    customer_name: "",
                    phone: "",
                    requirement: "",
                    gst_no: "",
                    enquiry_type: "",
                    source: "Manual",
                    city: "",
                    state: "",
                    area: "",
                  })
                }
                className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-50"
              >
                Clear
              </button>
              <button
                type="submit"
                disabled={savingManual}
                className="bg-[#002FA7] hover:bg-[#002288] text-white px-5 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50 flex items-center gap-1.5"
              >
                <Plus size={12} weight="bold" /> {savingManual ? "Saving..." : "Create Lead"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Bulk Excel Upload Card */}
      {activeTab === "bulk" && (
        <div className="space-y-6">
          <div className="border border-gray-200 bg-white p-6 md:p-8 space-y-6 shadow-sm">
            <form onSubmit={handleBulkSubmit}>
              <fieldset disabled={uploading || processing} className="space-y-6">
                <div className="flex items-center justify-between border-b border-gray-100 pb-3 flex-wrap gap-2">
                  <h2 className="font-chivo font-bold text-lg text-gray-900">Upload Leads Spreadsheet</h2>
                  <button
                    type="button"
                    onClick={handleDownloadTemplate}
                    className="text-[#002FA7] hover:underline text-[10px] uppercase tracking-widest font-bold flex items-center gap-1"
                  >
                    <DownloadSimple size={14} /> Download Sample Template
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <label className="block space-y-1">
                    <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                      Fallback Enquiry Source
                    </span>
                    <select
                      value={bulkSource}
                      onChange={(e) => setBulkSource(e.target.value)}
                      className="w-full border border-gray-300 px-2 py-2 text-sm focus:outline-none focus:border-[#002FA7]"
                    >
                      {SOURCES.map((src) => (
                        <option key={src} value={src}>
                          {src}
                        </option>
                      ))}
                    </select>
                    <span className="text-xs text-gray-400 mt-1 block">
                      Used if a lead's row in the Excel does not contain a "Source" column value.
                    </span>
                  </label>

                  <div className="space-y-1">
                    <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">
                      Select File (.xlsx, .xls, .csv) *
                    </span>
                    <label className="flex flex-col items-center justify-center border-2 border-dashed border-gray-300 hover:border-[#002FA7] cursor-pointer p-6 bg-gray-50 transition-colors">
                      <FileArrowUp size={32} className="text-gray-400 mb-2" />
                      <span className="text-sm font-semibold text-gray-700">
                        {bulkFile ? bulkFile.name : "Click to select file"}
                      </span>
                      <span className="text-xs text-gray-400 mt-1">Excel or CSV files up to 10MB</span>
                      <input
                        type="file"
                        accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
                        onChange={handleFileChange}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>

                {/* Backdating Inputs */}
                <div className="border border-gray-100 bg-gray-50/50 p-4 space-y-4">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={backdateEnabled}
                      onChange={(e) => setBackdateEnabled(e.target.checked)}
                      className="rounded text-[#002FA7] focus:ring-[#002FA7]"
                    />
                    <span className="text-xs font-bold uppercase tracking-wider text-gray-700">
                      Backdate leads (Specify Month & Year)
                    </span>
                  </label>

                  {backdateEnabled && (
                    <div className="grid grid-cols-2 gap-4 pt-1 animate-fadeIn">
                      <label className="block space-y-1">
                        <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Month</span>
                        <select
                          value={selectedMonth}
                          onChange={(e) => setSelectedMonth(e.target.value)}
                          className="w-full border border-gray-300 px-2 py-2 text-sm focus:outline-none focus:border-[#002FA7] bg-white"
                        >
                          <option value="1">January</option>
                          <option value="2">February</option>
                          <option value="3">March</option>
                          <option value="4">April</option>
                          <option value="5">May</option>
                          <option value="6">June</option>
                          <option value="7">July</option>
                          <option value="8">August</option>
                          <option value="9">September</option>
                          <option value="10">October</option>
                          <option value="11">November</option>
                          <option value="12">December</option>
                        </select>
                      </label>

                      <label className="block space-y-1">
                        <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Year</span>
                        <select
                          value={selectedYear}
                          onChange={(e) => setSelectedYear(e.target.value)}
                          className="w-full border border-gray-300 px-2 py-2 text-sm focus:outline-none focus:border-[#002FA7] bg-white"
                        >
                          {[2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027].map((yr) => (
                            <option key={yr} value={yr}>
                              {yr}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
                  {bulkFile && (
                    <button
                      type="button"
                      onClick={() => setBulkFile(null)}
                      className="border border-gray-300 px-4 py-2 text-[10px] uppercase tracking-widest font-bold hover:bg-gray-50"
                    >
                      Remove
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={uploading || processing || !bulkFile}
                    className="bg-[#002FA7] hover:bg-[#002288] text-white px-5 py-2 text-[10px] uppercase tracking-widest font-bold disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {uploading ? "Uploading..." : processing ? "Processing..." : "Import Leads"}
                  </button>
                </div>
              </fieldset>
            </form>
          </div>

          {/* Progress Indicator */}
          {(processing || (progress && progress.status === "processing")) && progress && (
            <div className="border border-gray-200 bg-white p-6 space-y-4 shadow-sm animate-fadeIn">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-chivo font-bold text-sm text-gray-900">
                    Importing leads from Excel...
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Processing row {progress.processed} of {progress.total}
                  </p>
                </div>
                <span className="font-chivo font-black text-lg text-[#002FA7]">
                  {progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0}%
                </span>
              </div>
              
              <div className="w-full bg-gray-100 h-2 rounded-full overflow-hidden border border-gray-200">
                <div
                  className="bg-[#002FA7] h-full transition-all duration-300 ease-out"
                  style={{ width: `${progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0}%` }}
                />
              </div>
              
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="p-2 bg-green-50 border border-green-100 rounded text-green-700">
                  <span className="font-bold block">{progress.imported}</span>
                  <span className="text-[9px] uppercase tracking-wider">Imported</span>
                </div>
                <div className="p-2 bg-amber-50 border border-amber-100 rounded text-amber-700">
                  <span className="font-bold block">{progress.duplicates}</span>
                  <span className="text-[9px] uppercase tracking-wider">Duplicates</span>
                </div>
                <div className="p-2 bg-red-50 border border-red-100 rounded text-red-700">
                  <span className="font-bold block">{progress.errors_count}</span>
                  <span className="text-[9px] uppercase tracking-wider">Errors</span>
                </div>
              </div>
            </div>
          )}

          {/* Bulk Upload Result Summary */}
          {uploadResult && (
            <div className="border border-gray-200 bg-white p-6 space-y-6 shadow-sm">
              <h3 className="font-chivo font-bold text-lg text-gray-900 border-b border-gray-100 pb-2">
                Import Result Summary
              </h3>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-gray-50 border border-gray-100 text-center">
                  <div className="text-xs text-gray-500 uppercase font-semibold">Total Rows</div>
                  <div className="text-2xl font-black font-chivo text-gray-900 mt-1">
                    {uploadResult.summary?.total || 0}
                  </div>
                </div>
                <div className="p-4 bg-green-50 border border-green-100 text-center">
                  <div className="text-xs text-green-700 uppercase font-semibold flex items-center justify-center gap-1">
                    <CheckCircle size={14} /> Imported
                  </div>
                  <div className="text-2xl font-black font-chivo text-green-700 mt-1">
                    {uploadResult.summary?.imported || 0}
                  </div>
                </div>
                <div className="p-4 bg-amber-50 border border-amber-100 text-center">
                  <div className="text-xs text-amber-700 uppercase font-semibold flex items-center justify-center gap-1">
                    <Warning size={14} /> Duplicates
                  </div>
                  <div className="text-2xl font-black font-chivo text-amber-700 mt-1">
                    {uploadResult.summary?.duplicates || 0}
                  </div>
                </div>
                <div className="p-4 bg-red-50 border border-red-100 text-center">
                  <div className="text-xs text-red-700 uppercase font-semibold flex items-center justify-center gap-1">
                    <XCircle size={14} /> Failed
                  </div>
                  <div className="text-2xl font-black font-chivo text-red-700 mt-1">
                    {uploadResult.summary?.errors || 0}
                  </div>
                </div>
              </div>

              {/* Log List */}
              {uploadResult.errors && uploadResult.errors.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-widest text-red-500 font-bold">
                    Row-by-Row Error Log
                  </div>
                  <div className="border border-red-100 bg-red-50/50 p-4 max-h-60 overflow-y-auto font-mono text-xs text-red-800 space-y-1.5">
                    {uploadResult.errors.map((err, i) => (
                      <div key={i} className="flex items-start gap-1">
                        <span className="shrink-0">•</span>
                        <span>{err}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
