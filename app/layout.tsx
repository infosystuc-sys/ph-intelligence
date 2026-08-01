import type { Metadata } from "next";
import { Inter, Manrope } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });
// Solo para nombres/headers de la propuesta de rediseño de Conversaciones —
// expuesta como variable CSS, no reemplaza a Inter como fuente por defecto.
const manrope = Manrope({ subsets: ["latin"], variable: "--font-display" });

export const metadata: Metadata = {
  title: "PH-Intelligence — Punto Hogar",
  description: "Plataforma de Inteligencia Conversacional para Punto Hogar",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className="h-full">
      <body className={`${inter.className} ${manrope.variable} h-full bg-bg text-body`}>
        {children}
      </body>
    </html>
  );
}
