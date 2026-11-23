"use client";

import { KitchenBoard } from "@/components/kitchen/board";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { useRequiredMe } from "@/lib/auth";

export default function CocinaPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Cocina" wide>
      {/* Cashiers and waiters watch the kitchen; only the kitchen, owners and supervisors move tickets. */}
      <KitchenBoard key={me.current_location_id} readOnly={me.user.role === "CASHIER" || me.user.role === "WAITER"} />
    </PanelShell>
  );
}
