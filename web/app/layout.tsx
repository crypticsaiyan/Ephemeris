import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

/* Two faces, each with one job. Mono carries every machine-produced value: ids, scores,
 * timecodes, years. The serif carries prose a person reads: the answer, the chronology, the
 * caveats. Keeping those apart is what stops a research tool from reading as a dashboard.
 *
 * Both are IBM Plex Mono and Newsreader, SIL Open Font License, and both ship in the repo.
 * They used to be fetched from Google Fonts at build time, and that download failed at random
 * on Vercel and in CI ("An error occurred in `next/font`"), turning a docs-only pull request
 * red. These are the very files the site was already serving, the Latin subset only, so the
 * page looks the same and no build depends on the network. */

const mono = localFont({
  src: [
    { path: "./fonts/IBMPlexMono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IBMPlexMono-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
});

/* Newsreader is a variable font: one file per style covers every weight the page asks for. */
const serif = localFont({
  src: [
    { path: "./fonts/Newsreader-var.woff2", weight: "300 600", style: "normal" },
    { path: "./fonts/Newsreader-italic-var.woff2", weight: "300 600", style: "italic" },
  ],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ephemeris: NASA archive research agent",
  description:
    "Ask a question, get a cited answer and an auto-edited evidence reel stitched from real NASA archival footage.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
