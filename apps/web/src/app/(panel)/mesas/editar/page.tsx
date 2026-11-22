"use client";

import { TablesEditor } from "@/components/admin/tables-editor";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { useRequiredMe } from "@/lib/auth";

export default function EditarMesasPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Mesas y zonas">
      <TablesEditor key={me.current_location_id} me={me} />
    </PanelShell>
  );
}
