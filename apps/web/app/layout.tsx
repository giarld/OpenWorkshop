import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { COLOR_THEME_INIT_SCRIPT } from "./theme-settings";

export const metadata: Metadata = {
  title: "OpenWorkshop",
  description: "自主软件项目工作流"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: COLOR_THEME_INIT_SCRIPT }} /></head>
      <body>{children}</body>
    </html>
  );
}
