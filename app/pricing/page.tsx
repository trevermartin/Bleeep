'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import toast from 'react-hot-toast'
import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'

const FREE_FEATURES = [
  '3 songs per month',
  'MP3 and WAV support',
  'Mute or warp options',
  'Download clean version',
]

const PRO_FEATURES = [
  'Unlimited songs per month',
  'MP3 and WAV support',
  'Mute or warp options',
  'Download clean version',
  'Priority processing',
  'Full song history',
]

const COMPARISON = [
  { feature: 'Songs per month', free: '3', pro: 'Unlimited' },
  { feature: 'File formats', free: 'MP3, WAV', pro: 'MP3, WAV' },
  { feature: 'Mute option', free: true, pro: true },
  { feature: 'Warp option', free: true, pro: true },
  { feature: 'Download clean file', free: true, pro: true },
  { feature: 'Song history', free: false, pro: true },
  { feature: 'Priority processing', free: false, pro: true },
]

export default function PricingPage() {
  return (
    <Suspense fallback={null}>
      <PricingContent />
    </Suspense>
  )
}

function PricingContent() {
  const searchParams = useSearchParams()
  const canceled = searchParams.get('canceled')
  const [loading, setLoading] = useState(false)

  async function handleUpgrade() {
    setLoading(true)
    try {
      const res = await fetch('/api/stripe/checkout', { method: 'POST' })
      const data = await res.json()

      if (!res.ok) {
        if (res.status === 401) {
          toast.error('Please log in to upgrade.')
          window.location.href = '/login?redirectTo=/pricing'
          return
        }
        toast.error(data.error || 'Something went wrong')
        return
      }

      if (data.url) {
        window.location.href = data.url
      }
    } catch {
      toast.error('Failed to start checkout. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0F1629]">
      <Navbar />

      <div className="max-w-5xl mx-auto px-4 pt-32 pb-20">
        {canceled && (
          <div className="mb-8 bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 rounded-xl px-5 py-4 text-sm text-center">
            Checkout was canceled. You can try again anytime.
          </div>
        )}

        <div className="text-center mb-16">
          <h1 className="text-5xl font-extrabold text-white mb-4">
            Simple, honest pricing
          </h1>
          <p className="text-white/50 text-xl">
            Start free. Upgrade when you need more.
          </p>
        </div>

        {/* Plan cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
          {/* Free */}
          <div className="glass rounded-2xl p-8">
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-white mb-2">Free</h2>
              <div className="flex items-baseline gap-1 mb-4">
                <span className="text-5xl font-extrabold text-white">$0</span>
                <span className="text-white/40 text-lg">/month</span>
              </div>
              <p className="text-white/50 text-sm">
                Perfect for occasional use. No credit card required.
              </p>
            </div>

            <ul className="space-y-4 mb-8">
              {FREE_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-3 text-white/70">
                  <svg className="w-5 h-5 text-violet-400 flex-shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>

            <Link
              href="/signup"
              className="block w-full text-center bg-white/10 hover:bg-white/15 text-white font-semibold py-3.5 rounded-xl transition-colors"
            >
              Get started free
            </Link>
          </div>

          {/* Pro */}
          <div className="relative rounded-2xl p-8 bg-gradient-to-br from-violet-600/30 to-violet-800/20 border border-violet-500/50">
            <div className="absolute -top-4 left-1/2 -translate-x-1/2">
              <span className="bg-violet-600 text-white text-sm font-bold px-5 py-1.5 rounded-full shadow-lg">
                MOST POPULAR
              </span>
            </div>

            <div className="mb-8">
              <h2 className="text-2xl font-bold text-white mb-2">Pro</h2>
              <div className="flex items-baseline gap-1 mb-4">
                <span className="text-5xl font-extrabold text-white">$12</span>
                <span className="text-white/40 text-lg">/month</span>
              </div>
              <p className="text-white/50 text-sm">
                For power users who clean music regularly.
              </p>
            </div>

            <ul className="space-y-4 mb-8">
              {PRO_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-3 text-white/70">
                  <svg className="w-5 h-5 text-violet-400 flex-shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>

            <button
              onClick={handleUpgrade}
              disabled={loading}
              className="w-full bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white font-semibold py-3.5 rounded-xl transition-colors shadow-lg shadow-violet-600/30 flex items-center justify-center gap-2"
            >
              {loading && (
                <div className="w-4 h-4 border-2 border-white/50 border-t-white rounded-full animate-spin" />
              )}
              Get Pro — $12/month
            </button>
            <p className="text-white/30 text-xs text-center mt-3">
              Cancel anytime. No contracts.
            </p>
          </div>
        </div>

        {/* Comparison table */}
        <div className="glass rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-white/10">
            <h2 className="text-xl font-bold text-white">Full comparison</h2>
          </div>
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left py-4 px-6 text-white/50 font-medium text-sm">Feature</th>
                <th className="py-4 px-6 text-white/50 font-medium text-sm text-center">Free</th>
                <th className="py-4 px-6 text-violet-400 font-semibold text-sm text-center">Pro</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row, i) => (
                <tr key={i} className={`border-b border-white/5 ${i % 2 === 0 ? 'bg-white/2' : ''}`}>
                  <td className="py-4 px-6 text-white/70 text-sm">{row.feature}</td>
                  <td className="py-4 px-6 text-center">
                    {typeof row.free === 'boolean' ? (
                      row.free ? (
                        <svg className="w-5 h-5 text-green-400 mx-auto" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5 text-white/20 mx-auto" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                        </svg>
                      )
                    ) : (
                      <span className="text-white/60 text-sm">{row.free}</span>
                    )}
                  </td>
                  <td className="py-4 px-6 text-center">
                    {typeof row.pro === 'boolean' ? (
                      row.pro ? (
                        <svg className="w-5 h-5 text-violet-400 mx-auto" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5 text-white/20 mx-auto" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                        </svg>
                      )
                    ) : (
                      <span className="text-white font-medium text-sm">{row.pro}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Footer />
    </div>
  )
}

