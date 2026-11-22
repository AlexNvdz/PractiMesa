"use client";

import { Devices } from "@/components/admin/devices";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { useRequiredMe } from "@/lib/auth";

export default function DispositivosPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Dispositivos">
      <Devices me={me} />
    </PanelShell>
  );
}
