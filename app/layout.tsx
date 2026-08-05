import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "LZR HUB — Central Inteligente",
  description: "Plataforma inteligente de atendimento para provedores de internet.",
  other: { "codex-preview": "development" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

/**
 * Aplica o tema escolhido **antes** da primeira pintura.
 *
 * Sem isto, quem forçou um tema diferente do sistema vê a página piscar na cor
 * errada até o React hidratar. É o único script inline do projeto, e por isso
 * ele é minúsculo e não depende de nada.
 */
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("lzr-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} /></head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
