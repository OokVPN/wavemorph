import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WaveMorph — перенос аудиоогибающей",
  description:
    "Перенесите динамическую форму одного аудио на другое. Обработка происходит прямо в браузере.",
  applicationName: "WaveMorph",
};

export const viewport: Viewport = {
  themeColor: "#080b12",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
