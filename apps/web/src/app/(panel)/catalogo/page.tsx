"use client";

import { Catalog } from "@/components/admin/catalog";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { useRequiredMe } from "@/lib/auth";

export default function CatalogoPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Catálogo">
      <Catalog key={me.current_location_id} me={me} />
    </PanelShell>
  );
}
