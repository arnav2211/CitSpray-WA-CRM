import React, { useEffect, useState, useCallback } from "react";
import { api, errMsg } from "@/lib/api";
import { toast } from "sonner";
import { 
  Package, Receipt, WhatsappLogo, ShareNetwork, DownloadSimple, 
  CaretDown, CaretUp, Link as LinkIcon, Info, Image as ImageIcon, Truck
} from "@phosphor-icons/react";

export default function OMSDataSection({ leadId }) {
  const [loading, setLoading] = useState(false);
  const [omsData, setOmsData] = useState(null);
  const [ordersOpen, setOrdersOpen] = useState(true);
  const [pisOpen, setPisOpen] = useState(false);
  const [sharingId, setSharingId] = useState(null); // Tracks active sharing process

  const fetchOmsData = useCallback(async () => {
    if (!leadId) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/leads/${leadId}/oms-data`);
      setOmsData(data);
    } catch (e) {
      console.error("Error fetching OMS data", e);
      // Fail silently to avoid breaking CRM lead views when OMS is down
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    fetchOmsData();
  }, [fetchOmsData]);

  if (loading) {
    return (
      <div className="pt-3 border-t border-gray-200 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-1/3 mb-3"></div>
        <div className="space-y-2">
          <div className="h-10 bg-gray-100 rounded"></div>
          <div className="h-10 bg-gray-100 rounded"></div>
        </div>
      </div>
    );
  }

  if (!omsData || (!omsData.orders?.length && !omsData.pis?.length)) {
    return null; // Don't show anything if no matched customer or orders exist in OMS
  }

  const { orders = [], pis = [], oms_base_url = "https://oms.mangalamagro.in" } = omsData;

  const handleShareOrderDetails = async (order) => {
    setSharingId(`order-details-${order.id}`);
    try {
      const itemsText = order.items
        .map(it => `• ${it.product_name} (${it.qty} ${it.unit || "pcs"})`)
        .join("\n");
      
      const shippingMethodFormatted = order.shipping_method
        ? order.shipping_method.replace("_", " ").toUpperCase()
        : "N/A";

      const text = `📦 *Order Update - CitSpray Aroma Sciences* 📦\n\n` +
        `Dear Customer,\n\n` +
        `Your order *${order.order_number}* is currently in *${order.status.toUpperCase()}* status.\n\n` +
        `*Order Details:*\n` +
        `${itemsText}\n\n` +
        `• *Grand Total:* ₹${order.grand_total}\n` +
        `• *Amount Paid:* ₹${order.amount_paid || 0}\n` +
        `• *Balance Amount:* ₹${order.balance_amount || 0}\n\n` +
        `*Shipping Details:*\n` +
        `• *Method:* ${shippingMethodFormatted}\n` +
        `• *Courier/Transporter:* ${order.dispatch?.courier_name || order.dispatch?.transporter_name || "N/A"}\n` +
        `• *Tracking/LR No:* ${order.dispatch?.lr_no || "N/A"}\n\n` +
        `Thank you for business with us!\n` +
        `*Mangalam Agro*`;

      await api.post("/whatsapp/send", { lead_id: leadId, body: text });
      toast.success(`Shared order details for ${order.order_number} via WhatsApp!`);
    } catch (e) {
      toast.error(errMsg(e, "Failed to share order details"));
    } finally {
      setSharingId(null);
    }
  };

  const handleSharePackedImages = async (order) => {
    // Collect packed box images or fallback to order images
    const images = order.packaging?.packed_box_images?.length 
      ? order.packaging.packed_box_images 
      : (order.packaging?.order_images || []);

    if (!images.length) {
      toast.error("No packed box images available for this order!");
      return;
    }

    setSharingId(`packed-images-${order.id}`);
    try {
      for (let i = 0; i < images.length; i++) {
        const relativeUrl = images[i];
        // Ensure url has leading slash if missing
        const separator = relativeUrl.startsWith("/") ? "" : "/";
        const publicUrl = `${oms_base_url}${separator}${relativeUrl}`;

        const caption = i === 0 
          ? `📸 *Packed Box Image - CitSpray Aroma Sciences*\n\n` +
            `Dear Customer, here is the packed box image for your order *${order.order_number}*. It has been safely packed and is ready for dispatch!`
          : ""; // Only send caption on the first image

        await api.post("/whatsapp/send-media", {
          lead_id: leadId,
          media_type: "image",
          media_url: publicUrl,
          caption: caption || undefined
        });
      }
      toast.success(`Shared packed box image(s) for ${order.order_number}!`);
    } catch (e) {
      toast.error(errMsg(e, "Failed to share packed box images"));
    } finally {
      setSharingId(null);
    }
  };

  const handleShareDispatchSlip = async (order) => {
    const slipImages = order.dispatch?.dispatch_slip_images || [];
    if (!slipImages.length) {
      toast.error("No dispatch slip images available for this order!");
      return;
    }

    setSharingId(`dispatch-slip-${order.id}`);
    try {
      const courierName = order.dispatch?.courier_name || order.dispatch?.transporter_name || "courier";
      const lrNo = order.dispatch?.lr_no || "N/A";

      for (let i = 0; i < slipImages.length; i++) {
        const relativeUrl = slipImages[i];
        const separator = relativeUrl.startsWith("/") ? "" : "/";
        const publicUrl = `${oms_base_url}${separator}${relativeUrl}`;

        const caption = i === 0 
          ? `🚚 *Dispatch Slip - CitSpray Aroma Sciences*\n\n` +
            `Dear Customer, your order *${order.order_number}* has been dispatched via *${courierName}* under tracking/LR number *${lrNo}*.\n\n` +
            `Attached is your copy of the dispatch slip. You can track your shipment using this details.`
          : "";

        await api.post("/whatsapp/send-media", {
          lead_id: leadId,
          media_type: "image",
          media_url: publicUrl,
          caption: caption || undefined
        });
      }
      toast.success(`Shared dispatch slip copy for ${order.order_number}!`);
    } catch (e) {
      toast.error(errMsg(e, "Failed to share dispatch slip"));
    } finally {
      setSharingId(null);
    }
  };

  const handleShareTaxInvoice = async (order) => {
    const relativeUrl = order.tax_invoice_url;
    if (!relativeUrl) {
      toast.error("No tax invoice available for this order!");
      return;
    }

    setSharingId(`tax-invoice-${order.id}`);
    try {
      const separator = relativeUrl.startsWith("/") ? "" : "/";
      const publicUrl = `${oms_base_url}${separator}${relativeUrl}`;
      const filename = `${order.order_number}_Tax_Invoice.pdf`;

      const caption = `📄 *Tax Invoice - CitSpray Aroma Sciences*\n\n` +
        `Dear Customer, please find attached the Tax Invoice for your order *${order.order_number}*.`;

      await api.post("/whatsapp/send-media", {
        lead_id: leadId,
        media_type: "document",
        media_url: publicUrl,
        caption: caption,
        filename: filename
      });
      
      toast.success(`Shared tax invoice for ${order.order_number}!`);
    } catch (e) {
      toast.error(errMsg(e, "Failed to share tax invoice"));
    } finally {
      setSharingId(null);
    }
  };

  const handleSharePiDetails = async (pi) => {
    setSharingId(`pi-details-${pi.id}`);
    try {
      const itemsText = pi.items
        .map(it => `• ${it.product_name} (${it.qty} ${it.unit || "pcs"})`)
        .join("\n");

      const text = `📄 *Proforma Invoice - CitSpray Aroma Sciences* 📄\n\n` +
        `Dear Customer,\n\n` +
        `Please find the details for Proforma Invoice *${pi.pi_number}*:\n\n` +
        `*Items:*\n` +
        `${itemsText}\n\n` +
        `• *Grand Total:* ₹${pi.grand_total}\n` +
        `• *Status:* ${pi.status.toUpperCase()}\n\n` +
        `*Bank Details for Payment:*\n` +
        `🏛️ *Punjab National Bank*\n` +
        `• *Account Name:* Mangalam Agro\n` +
        `• *A/c No:* 1472002100029992\n` +
        `• *IFSC Code:* PUNB0147200\n` +
        `• *UPI VPA:* archanaagrawal80-1@okicici\n\n` +
        `Kindly share the payment screenshot once done so we can initiate packing.\n\n` +
        `Thank you!\n` +
        `*Mangalam Agro*`;

      await api.post("/whatsapp/send", { lead_id: leadId, body: text });
      toast.success(`Shared PI ${pi.pi_number} details via WhatsApp!`);
    } catch (e) {
      toast.error(errMsg(e, "Failed to share PI details"));
    } finally {
      setSharingId(null);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case "new":
        return "bg-blue-100 text-blue-800 border-blue-200";
      case "packaging":
        return "bg-orange-100 text-orange-800 border-orange-200";
      case "packed":
        return "bg-amber-100 text-amber-800 border-amber-200";
      case "dispatched":
        return "bg-emerald-100 text-emerald-800 border-emerald-200";
      case "cancelled":
        return "bg-red-100 text-red-800 border-red-200";
      default:
        return "bg-gray-100 text-gray-800 border-gray-200";
    }
  };

  const getPaymentStatusColor = (status) => {
    switch (status) {
      case "full":
        return "text-emerald-700 bg-emerald-50 border-emerald-200";
      case "partial":
        return "text-orange-700 bg-orange-50 border-orange-200";
      case "unpaid":
        return "text-red-700 bg-red-50 border-red-200";
      default:
        return "text-gray-700 bg-gray-50 border-gray-200";
    }
  };

  return (
    <div className="pt-3 border-t border-gray-200 space-y-3" data-testid="oms-data-section">
      {/* Header showing matched customer info */}
      <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-gray-500 font-bold">
        <span className="flex items-center gap-1">
          <LinkIcon size={12} className="text-[#002FA7]" /> Connected OMS Records
        </span>
        {omsData.customer && (
          <span className="text-[9px] text-[#002FA7] bg-[#F0F4FF] px-1.5 py-0.5 rounded font-mono truncate max-w-[150px]">
            {omsData.customer.name}
          </span>
        )}
      </div>

      {/* Orders Collapsible Container */}
      {orders.length > 0 && (
        <div className="border border-gray-200 rounded-md overflow-hidden bg-white">
          <button
            onClick={() => setOrdersOpen(!ordersOpen)}
            className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors text-xs font-bold text-gray-700"
          >
            <span className="flex items-center gap-1.5">
              <Package size={14} className="text-gray-500" /> Matches Orders ({orders.length})
            </span>
            {ordersOpen ? <CaretUp size={12} /> : <CaretDown size={12} />}
          </button>

          {ordersOpen && (
            <div className="p-2 space-y-2 max-h-64 overflow-y-auto divide-y divide-gray-100">
              {orders.map((o) => {
                const hasPackedImages = o.packaging?.packed_box_images?.length > 0 || o.packaging?.order_images?.length > 0;
                const hasDispatchSlip = o.dispatch?.dispatch_slip_images?.length > 0;

                return (
                  <div key={o.id} className="pt-2 first:pt-0 space-y-1.5" data-testid={`oms-order-${o.order_number}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-bold text-gray-800">{o.order_number}</span>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${getStatusColor(o.status)}`}>
                        {o.status}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-xs text-gray-600">
                      <span>Total: <strong className="text-gray-900 font-bold">₹{o.grand_total}</strong></span>
                      <span className={`px-1 py-0.2 rounded border text-[9px] font-medium ${getPaymentStatusColor(o.payment_status)}`}>
                        {o.payment_status} payment
                      </span>
                    </div>

                    {o.dispatch?.lr_no && (
                      <div className="text-[10px] text-gray-500 font-mono flex items-center gap-1">
                        <Truck size={10} /> LR: {o.dispatch.lr_no} ({o.dispatch.courier_name || o.dispatch.transporter_name || "Shipped"})
                      </div>
                    )}

                    {/* Sharing Actions Row */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      {/* Share details */}
                      <button
                        onClick={() => handleShareOrderDetails(o)}
                        disabled={sharingId !== null}
                        className="flex-1 min-w-[70px] bg-[#25D366] hover:bg-[#1fa851] disabled:opacity-50 text-white text-[9px] uppercase tracking-widest font-bold py-1 px-1.5 flex items-center justify-center gap-1 rounded transition-transform active:scale-95"
                        title="Share details via WhatsApp"
                      >
                        <WhatsappLogo size={10} weight="fill" /> Details
                      </button>

                      {/* Share packed box images */}
                      {hasPackedImages && (
                        <button
                          onClick={() => handleSharePackedImages(o)}
                          disabled={sharingId !== null}
                          className="flex-1 min-w-[70px] bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-[9px] uppercase tracking-widest font-bold py-1 px-1.5 flex items-center justify-center gap-1 rounded transition-transform active:scale-95"
                          title="Share Packed Images via WhatsApp"
                        >
                          <ImageIcon size={10} weight="fill" /> Packed
                        </button>
                      )}

                      {/* Share dispatch slip */}
                      {hasDispatchSlip && (
                        <button
                          onClick={() => handleShareDispatchSlip(o)}
                          disabled={sharingId !== null}
                          className="flex-1 min-w-[70px] bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-[9px] uppercase tracking-widest font-bold py-1 px-1.5 flex items-center justify-center gap-1 rounded transition-transform active:scale-95"
                          title="Share Dispatch Slip via WhatsApp"
                        >
                          <Truck size={10} weight="fill" /> Slip
                        </button>
                      )}

                      {/* Tax Invoice Option */}
                      {o.tax_invoice_url ? (
                        <button
                          onClick={() => handleShareTaxInvoice(o)}
                          disabled={sharingId !== null}
                          className="flex-1 min-w-[70px] bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-[9px] uppercase tracking-widest font-bold py-1 px-1.5 flex items-center justify-center gap-1 rounded transition-transform active:scale-95"
                          title="Share Tax Invoice via WhatsApp"
                        >
                          <Receipt size={10} weight="fill" /> Invoice
                        </button>
                      ) : (
                        <span 
                          className="flex-1 min-w-[100px] text-center text-gray-400 bg-gray-50 border border-gray-200 py-1 px-1.5 text-[8px] uppercase tracking-wider font-bold rounded"
                          title="Tax Invoice is not required for this order"
                        >
                          Invoice: Not required
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* PIs Collapsible Container */}
      {pis.length > 0 && (
        <div className="border border-gray-200 rounded-md overflow-hidden bg-white">
          <button
            onClick={() => setPisOpen(!pisOpen)}
            className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors text-xs font-bold text-gray-700"
          >
            <span className="flex items-center gap-1.5">
              <Receipt size={14} className="text-gray-500" /> Matches PIs ({pis.length})
            </span>
            {pisOpen ? <CaretUp size={12} /> : <CaretDown size={12} />}
          </button>

          {pisOpen && (
            <div className="p-2 space-y-2 max-h-64 overflow-y-auto divide-y divide-gray-100">
              {pis.map((p) => (
                <div key={p.id} className="pt-2 first:pt-0 space-y-1.5" data-testid={`oms-pi-${p.pi_number}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-gray-800">{p.pi_number}</span>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${p.status === "converted" ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-gray-100 text-gray-700 border-gray-200"}`}>
                      {p.status}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-xs text-gray-600">
                    <span>Total: <strong className="text-gray-900 font-bold">₹{p.grand_total}</strong></span>
                    <span className="text-[10px] text-gray-400">
                      {p.items?.length || 0} item(s)
                    </span>
                  </div>

                  {/* Sharing Actions Row */}
                  <div className="flex items-center gap-1.5 pt-1">
                    <button
                      onClick={() => handleSharePiDetails(p)}
                      disabled={sharingId !== null}
                      className="flex-1 bg-[#25D366] hover:bg-[#1fa851] disabled:opacity-50 text-white text-[9px] uppercase tracking-widest font-bold py-1 px-1.5 flex items-center justify-center gap-1 rounded transition-transform active:scale-95"
                      title="Share PI Details via WhatsApp"
                    >
                      <WhatsappLogo size={10} weight="fill" /> Share details &amp; Bank Info
                    </button>
                    
                    <a
                      href={`${oms_base_url}/api/proforma-invoices/${p.id}/pdf`}
                      target="_blank"
                      rel="noreferrer"
                      className="border border-gray-300 hover:border-gray-900 text-gray-700 text-[9px] uppercase tracking-widest font-bold py-1 px-2 flex items-center justify-center gap-1 rounded"
                    >
                      <DownloadSimple size={10} /> PDF
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
