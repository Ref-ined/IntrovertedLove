import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Toaster } from "sonner";
import { clerkEnabled } from "@/lib/flags";
import "./globals.css";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces" });
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });

export const metadata: Metadata = { title: "Introverted Love", description: "Say what you mean, gently." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const page = (
    <html lang="en" className={`${fraunces.variable} ${manrope.variable}`}>
      <body className="min-h-screen antialiased">
        {children}
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );
  // Without keys (dev login) Clerk is never mounted, so it can't throw or go keyless.
  return clerkEnabled() ? <ClerkProvider>{page}</ClerkProvider> : page;
}
