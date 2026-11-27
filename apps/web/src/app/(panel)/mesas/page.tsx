"use client";

import { useState } from "react";
import { PanelLoading, PanelShell } from "@/components/panel-shell";
import { Service } from "@/components/pos/service";
import { useRequiredMe } from "@/lib/auth";

export default function MesasPage() {
  const me = useRequiredMe();
  // Tables and counter orders with food ready: a yellow count on "Mesas" in the menu.
  const [ready, setReady] = useState(0);
  if (!me) return <PanelLoading />;
  return (
    <PanelShell me={me} title="Mesas" wide badges={{ "/mesas": ready }}>
      <Service key={me.current_location_id} me={me} onReady={setReady} />
    </PanelShell>
  );
}
