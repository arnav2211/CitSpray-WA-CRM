// WhatsApp message extras (template / chatbot header, footer and buttons), drawn the
// way WhatsApp shows them, so the team can see exactly what went to the customer.
// `parts` = { header_format, header_text, footer, buttons: [{type, text, url, phone_number}], list_button }
import { ArrowSquareOut, Phone, ArrowBendUpLeft, Copy, ListBullets, Image as ImageIcon, VideoCamera, FileText, MapPin } from "@phosphor-icons/react";

const MEDIA_HEADER = {
  IMAGE: { icon: ImageIcon, label: "Image header" },
  VIDEO: { icon: VideoCamera, label: "Video header" },
  DOCUMENT: { icon: FileText, label: "Document header" },
  LOCATION: { icon: MapPin, label: "Location header" },
};

export function WaHeader({ parts, hasMedia = false, className = "" }) {
  if (!parts) return null;
  const fmt = (parts.header_format || "").toUpperCase();
  if (fmt === "TEXT" && parts.header_text) {
    return <div className={`font-bold whitespace-pre-wrap break-words ${className}`} data-testid="wa-header">{parts.header_text}</div>;
  }
  const m = MEDIA_HEADER[fmt];
  if (m && !hasMedia) {
    const Icon = m.icon;
    return (
      <div className={`flex items-center gap-1 text-[10px] uppercase tracking-widest font-bold text-gray-500 ${className}`} data-testid="wa-header">
        <Icon size={12} weight="bold" /> {m.label}
      </div>
    );
  }
  return null;
}

export function WaFooter({ parts, className = "" }) {
  if (!parts?.footer) return null;
  return <div className={`text-[11px] text-gray-500 whitespace-pre-wrap break-words ${className}`} data-testid="wa-footer">{parts.footer}</div>;
}

function buttonIcon(type) {
  switch ((type || "").toUpperCase()) {
    case "URL": return ArrowSquareOut;
    case "PHONE_NUMBER": case "VOICE_CALL": return Phone;
    case "COPY_CODE": return Copy;
    case "LIST_ROW": return ListBullets;
    default: return ArrowBendUpLeft;      // QUICK_REPLY and others
  }
}

export function WaButtons({ parts, className = "" }) {
  const buttons = (parts?.buttons || []).filter((b) => b && (b.text || b.url || b.phone_number));
  if (!buttons.length && !parts?.list_button) return null;
  return (
    <div className={`border-t border-black/10 ${className}`} data-testid="wa-buttons">
      {parts?.list_button && (
        <div className="flex items-center justify-center gap-1.5 py-1.5 text-[13px] font-medium text-[#0B8DE6] border-b border-black/10">
          <ListBullets size={14} weight="bold" /> {parts.list_button}
        </div>
      )}
      {buttons.map((b, i) => {
        const Icon = buttonIcon(b.type);
        const isList = (b.type || "").toUpperCase() === "LIST_ROW";
        const detail = b.url || b.phone_number;
        return (
          <div key={i} className={`flex items-center justify-center gap-1.5 py-1.5 text-[13px] ${isList ? "text-gray-700" : "font-medium text-[#0B8DE6]"} ${i ? "border-t border-black/10" : ""}`}
            title={detail || ""} data-testid="wa-button">
            <Icon size={14} weight="bold" />
            <span className="truncate">{b.text || detail}</span>
            {detail && <span className="text-[10px] text-gray-400 font-normal truncate max-w-[45%]">{detail}</span>}
          </div>
        );
      })}
    </div>
  );
}
