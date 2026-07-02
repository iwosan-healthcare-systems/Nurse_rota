import { createFileRoute } from "@tanstack/react-router";
import { AppShell, appBeforeLoad } from "@/components/AppShell";

export const Route = createFileRoute("/_app")({
  beforeLoad: appBeforeLoad,
  component: AppShell,
});
