"use client";

import { Account } from "@/components/account";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { useRequiredMe } from "@/lib/auth";

export default function MiCuentaPage() {
  const me = useRequiredMe();
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Mi cuenta">
      <Account me={me} />
    </PanelShell>
  );
}
