import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import type Stripe from 'stripe'

// Disable body parsing — Stripe needs the raw body for signature verification
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const sig = request.headers.get('stripe-signature')!
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
  } catch (err) {
    console.error('[webhook] signature verification failed:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const adminSupabase = createAdminClient()

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const userId =
          session.metadata?.supabase_user_id

        if (userId && session.mode === 'subscription') {
          await adminSupabase
            .from('profiles')
            .update({ plan: 'pro' })
            .eq('id', userId)
        }
        break
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        const userId = sub.metadata?.supabase_user_id

        if (userId) {
          const isActive = sub.status === 'active' || sub.status === 'trialing'
          await adminSupabase
            .from('profiles')
            .update({ plan: isActive ? 'pro' : 'free' })
            .eq('id', userId)
        }
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        const userId = sub.metadata?.supabase_user_id

        if (userId) {
          await adminSupabase
            .from('profiles')
            .update({ plan: 'free' })
            .eq('id', userId)
        }
        break
      }

      case 'invoice.payment_failed': {
        // Could send a notification email here in the future
        console.warn('[webhook] payment failed for invoice:', event.data.object)
        break
      }

      default:
        // Unhandled event — ignore
        break
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error('[webhook] handler error:', err)
    return NextResponse.json({ error: 'Handler error' }, { status: 500 })
  }
}
