import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "اتوماسیون هوشمند - سیستم تحلیل تکنیکال",
  description: "سیستم تحلیل تکنیکال هوشمند برای بازار ارزهای دیجیتال با قابلیت اتوماسیون معاملات",
  keywords: ["trading", "crypto", "automation", "technical analysis", "futures"],
  authors: [{ name: "اتوماسیون هوشمند" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "اتوماسیون هوشمند",
    description: "سیستم تحلیل تکنیکال پیشرفته",
    url: "https://chat.z.ai",
    siteName: "اتوماسیون هوشمند",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
