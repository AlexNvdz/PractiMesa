"use client";

import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { Service } from "@/components/pos/service";
import { useRequiredMe } from "@/lib/auth";

export default function MesasPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Mesas" wide>
      <Service key={me.current_location_id} me={me} />
    </PanelShell>
  );
}
