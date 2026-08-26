import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "tldraw/tldraw.css";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://jazzboard-rho.vercel.app"),
  applicationName: "Jazzboard",
  title: {
    default: "Jazzboard — Think together, live",
    template: "%s · Jazzboard",
  },
  description:
    "A shared architecture canvas where people and their own AI collaborators diagram and edit together in real time through visual UI or browser-native WebMCP.",
  openGraph: {
    type: "website",
    siteName: "Jazzboard",
    title: "Jazzboard — Think together, live",
    description:
      "A private multiplayer architecture canvas where people and their own agents collaborate through browser-native WebMCP.",
    url: "/",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f7f8fc",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link href="/llms.txt" rel="describedby" type="text/plain" />
        <link href="/agent-guide.md" rel="help" type="text/markdown" />
      </head>
      <body>{children}</body>
    </html>
  );
}
