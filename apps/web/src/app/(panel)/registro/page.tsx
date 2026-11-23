"use client";

import { Activity } from "@/components/admin/activity";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { useRequiredMe } from "@/lib/auth";

export default function RegistroPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Registro">
      <Activity key={me.current_location_id} me={me} />
    </PanelShell>
  );
}
