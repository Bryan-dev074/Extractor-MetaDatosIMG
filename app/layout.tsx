import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Extractor MetaData · Limpiador quirúrgico de metadatos de IA",
  description:
    "Limpia metadatos seleccionados de JPEG y PNG sin recomprimir; procesa carpetas y crea copias PNG sRGB adaptativas para TikTok.",
  keywords: [
    "metadatos",
    "C2PA",
    "Content Credentials",
    "IA",
    "Midjourney",
    "DALL-E",
    "Firefly",
    "limpiar metadatos",
    "EXIF",
    "XMP",
  ],
  authors: [{ name: "Extractor MetaData" }],
  openGraph: {
    title: "Extractor MetaData · Limpiador quirúrgico de metadatos de IA",
    description:
      "El modo limpio conserva los píxeles; el modo TikTok genera una copia PNG sRGB con ajustes adaptativos acotados.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#04050a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className="dark">
      <body
        className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
