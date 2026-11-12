import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import { headers } from "next/headers";
import { Providers } from "@/components/Providers";
import { THEME_INIT_SCRIPT } from "@/components/ThemeProvider";
import "@/styles/globals.css";

const display = Newsreader({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-display", display: "swap" });
const ui = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-ui", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = { title: { default: "TWINS", template: "%s · TWINS" }, description: "TWINS Research Desk: private paper-trading research platform.", robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0e1013" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} ${mono.variable}`} suppressHydrationWarning>
      <head><script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /></head>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
