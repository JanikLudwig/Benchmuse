import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Benchmuse", template: "%s · Benchmuse" },
  description: "R&D data platform: notebook, registry, inventory, results.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
