"use client";

import { Locations } from "@/components/admin/locations";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { useRequiredMe } from "@/lib/auth";

export default function SedesPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Sedes">
      <Locations key={me.current_location_id} me={me} />
    </PanelShell>
  );
}
