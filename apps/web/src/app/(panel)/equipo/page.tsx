"use client";

import { Team } from "@/components/admin/team";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { useRequiredMe } from "@/lib/auth";

export default function EquipoPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Equipo">
      <Team me={me} />
    </PanelShell>
  );
}
