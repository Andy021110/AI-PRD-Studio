import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI PRD Generator",
  description: "Enterprise AI-native product requirement generation workspace.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-white text-zinc-900 flex flex-col">
        {children}
      </body>
    </html>
  );
}
