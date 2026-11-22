"use client";

import { Inventory } from "@/components/admin/inventory";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { useRequiredMe } from "@/lib/auth";

export default function InventarioPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Inventario">
      <Inventory key={me.current_location_id} me={me} />
    </PanelShell>
  );
}
