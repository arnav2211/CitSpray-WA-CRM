import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import LeadDrawer from "@/components/LeadDrawer";

export default function LeadDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [open, setOpen] = useState(true);
  useEffect(() => { setOpen(true); }, [id]);
  if (!open) return null;
  return <LeadDrawer leadId={id} onClose={() => nav("/leads")} />;
}
