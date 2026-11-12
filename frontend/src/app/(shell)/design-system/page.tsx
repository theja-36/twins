import { notFound } from "next/navigation";
import { loadConfig } from "@/bff/config";
import { DesignGallery } from "@/components/DesignGallery";

export const metadata = { title: "Design system" };
export default function Page() {
  let on = false; try { on = loadConfig().gallery; } catch { on = false; }
  if (!on) notFound();
  return <DesignGallery />;
}
