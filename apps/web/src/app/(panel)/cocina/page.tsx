"use client";

import { KitchenBoard } from "@/components/kitchen/board";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { useRequiredMe } from "@/lib/auth";

export default function CocinaPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Cocina" wide>
      <KitchenBoard key={me.current_location_id} />
    </PanelShell>
  );
}
