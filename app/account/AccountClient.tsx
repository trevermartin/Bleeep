'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import toast from 'react-hot-toast'
import Navbar from '@/components/Navbar'
import type { Profile } from '@/types'

interface Props {
  profile: Profile | null
  userEmail: string
}

export default function AccountClient(props: Props) {
  return (
    <Suspense fallback={null}>
      <AccountContent {...props} />
    </Suspense>
  )
}

function AccountContent({ profile, userEmail }: Props) {
  const searchParams = useSearchParams()
  const upgradeSuccess = searchParams.get('upgrade') === 'success'
  const [portalLoading, setPortalLoading] = useState(false)
  const [checkoutLoading, setCheckoutLoading] = useState(false)

  const isPro = profile?.plan === 'pro'
  const FREE_LIMIT = 3
  const usedThisMonth = profile?.songs_processed_this_month ?? 0

  async function openBillingPortal() {
    setPortalLoading(true)
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Could not open billing portal')
        return
      }
      window.location.href = data.url
    } catch {
      toast.error('Something went wrong. Please try again.')
    } finally {
      setPortalLoading(false)
    }
  }

  async function handleUpgrade() {
    setCheckoutLoading(true)
    try {
      const res = await fetch('/api/stripe/checkout', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Checkout failed')
        return
      }
      if (data.url) window.location.href = data.url
    } catch {
      toast.error('Something went wrong. Please try again.')
    } finally {
      setCheckoutLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0F1629]">
      <Navbar />

      <div className="max-w-2xl mx-auto px-4 pt-28 pb-16">
        <h1 className="text-3xl font-bold text-white mb-8">Account</h1>

        {upgradeSuccess && (
          <div className="mb-6 bg-green-500/10 border border-green-500/30 text-green-300 rounded-xl px-5 py-4 text-sm flex items-center gap-3">
            <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            You&apos;ve successfully upgraded to Pro! Enjoy unlimited songs.
          </div>
        )}

        <div className="space-y-6">
          {/* Profile */}
          <div className="glass rounded-2xl p-6">
            <h2 className="text-white font-semibold mb-4">Profile</h2>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-white/50 text-sm">Email</span>
                <span className="text-white text-sm">{userEmail}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-white/50 text-sm">Member since</span>
                <span className="text-white text-sm">
                  {profile?.created_at
                    ? new Date(profile.created_at).toLocaleDateString('en-US', {
                        month: 'long',
                        year: 'numeric',
                      })
                    : '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Plan */}
          <div className="glass rounded-2xl p-6">
            <h2 className="text-white font-semibold mb-4">Current plan</h2>

            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-white text-lg font-bold">
                    {isPro ? 'Pro' : 'Free'}
                  </span>
                  {isPro && (
                    <span className="bg-violet-600/30 text-violet-300 text-xs px-2 py-0.5 rounded-full border border-violet-500/30">
                      Active
                    </span>
                  )}
                </div>
                <p className="text-white/40 text-sm mt-0.5">
                  {isPro ? '$12/month · Unlimited songs' : '$0/month · 3 songs/month'}
                </p>
              </div>

              {isPro ? (
                <button
                  onClick={openBillingPortal}
                  disabled={portalLoading}
                  className="bg-white/10 hover:bg-white/15 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-60 flex items-center gap-2"
                >
                  {portalLoading && (
                    <div className="w-3.5 h-3.5 border-2 border-white/50 border-t-white rounded-full animate-spin" />
                  )}
                  Manage billing
                </button>
              ) : (
                <button
                  onClick={handleUpgrade}
                  disabled={checkoutLoading}
                  className="bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-60 flex items-center gap-2"
                >
                  {checkoutLoading && (
                    <div className="w-3.5 h-3.5 border-2 border-white/50 border-t-white rounded-full animate-spin" />
                  )}
                  Upgrade to Pro
                </button>
              )}
            </div>

            {!isPro && (
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-white/50">Songs this month</span>
                  <span className="text-white">
                    {usedThisMonth} / {FREE_LIMIT}
                  </span>
                </div>
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-violet-600 rounded-full transition-all"
                    style={{
                      width: `${Math.min((usedThisMonth / FREE_LIMIT) * 100, 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Billing portal (Pro only) */}
          {isPro && (
            <div className="glass rounded-2xl p-6">
              <h2 className="text-white font-semibold mb-2">Billing</h2>
              <p className="text-white/50 text-sm mb-4">
                View invoices, update payment method, or cancel your subscription.
              </p>
              <button
                onClick={openBillingPortal}
                disabled={portalLoading}
                className="bg-white/10 hover:bg-white/15 text-white font-medium px-5 py-2.5 rounded-xl text-sm transition-colors disabled:opacity-60 flex items-center gap-2"
              >
                {portalLoading && (
                  <div className="w-4 h-4 border-2 border-white/50 border-t-white rounded-full animate-spin" />
                )}
                Open billing portal
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 opacity-50">
                  <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          )}

          {/* Quick links */}
          <div className="glass rounded-2xl p-6">
            <h2 className="text-white font-semibold mb-4">Quick links</h2>
            <div className="space-y-2">
              <Link
                href="/dashboard"
                className="flex items-center justify-between p-3 hover:bg-white/5 rounded-xl transition-colors group"
              >
                <span className="text-white/70 text-sm group-hover:text-white transition-colors">
                  Go to Dashboard
                </span>
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-white/30">
                  <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </Link>
              {!isPro && (
                <Link
                  href="/pricing"
                  className="flex items-center justify-between p-3 hover:bg-white/5 rounded-xl transition-colors group"
                >
                  <span className="text-violet-400 text-sm group-hover:text-violet-300 transition-colors">
                    View pricing & upgrade
                  </span>
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-violet-400/50">
                    <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
