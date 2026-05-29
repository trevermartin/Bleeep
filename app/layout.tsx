import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { Toaster } from 'react-hot-toast'
import './globals.css'

// Use the Geist font already bundled in the project — no network required
const geistSans = localFont({
  src: './fonts/GeistVF.woff',
  variable: '--font-sans',
  display: 'swap',
  weight: '100 900',
})

export const metadata: Metadata = {
  title: 'Bleeep — Clean music in seconds',
  description:
    'Upload any song — Bleeep automatically removes every curse word and gives you a clean version to download.',
  keywords: ['clean music', 'remove profanity', 'censor song', 'clean version'],
  openGraph: {
    title: 'Bleeep — Clean music in seconds',
    description:
      'Upload any song — Bleeep automatically removes every curse word and gives you a clean version to download.',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={geistSans.variable}>
      <body className="antialiased min-h-screen bg-[#0F1629] text-white font-sans">
        {children}
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: '#1a2340',
              color: '#fff',
              border: '1px solid rgba(124,58,237,0.3)',
            },
            success: {
              iconTheme: { primary: '#7C3AED', secondary: '#fff' },
            },
            error: {
              iconTheme: { primary: '#ef4444', secondary: '#fff' },
            },
          }}
        />
      </body>
    </html>
  )
}
