import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

export const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    songsPerMonth: 3,
    features: [
      '3 songs per month',
      'MP3 and WAV support',
      'Mute or bleep options',
      'Download clean version',
    ],
  },
  pro: {
    name: 'Pro',
    price: 12,
    songsPerMonth: Infinity,
    priceId: process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID,
    features: [
      'Unlimited songs per month',
      'MP3 and WAV support',
      'Mute or bleep options',
      'Download clean version',
      'Priority processing',
      'Song history',
    ],
  },
}
