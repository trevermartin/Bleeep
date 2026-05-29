import Link from 'next/link'
import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'

export const dynamic = 'force-dynamic'

const steps = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-8 h-8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
      </svg>
    ),
    step: '01',
    title: 'Upload your song',
    desc: 'Drag and drop any MP3 or WAV file up to 50MB. Your audio is uploaded securely.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-8 h-8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
      </svg>
    ),
    step: '02',
    title: 'AI detects every curse word',
    desc: 'Our AI transcribes your song with word-level timestamps and pinpoints every profane word.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-8 h-8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
    ),
    step: '03',
    title: 'Download your clean version',
    desc: 'Choose to mute or bleep each word. Download your clean MP3 instantly.',
  },
]

const faqs = [
  {
    q: 'What file formats does Bleeep support?',
    a: 'Bleeep supports MP3 and WAV files up to 50MB. Most songs are well within this limit.',
  },
  {
    q: 'How accurate is the profanity detection?',
    a: 'We use AssemblyAI — one of the most accurate speech-to-text APIs available — with a comprehensive profanity word list and word boosting to maximize detection accuracy.',
  },
  {
    q: 'What is the difference between Mute and Bleep?',
    a: 'Mute replaces the profane word with silence. Bleep replaces it with a 1kHz beep tone, like you would hear on TV.',
  },
  {
    q: 'How long does processing take?',
    a: 'Most songs are processed in 1–3 minutes depending on length and our current load.',
  },
  {
    q: 'Can I upgrade or cancel my Pro plan anytime?',
    a: 'Yes. You can upgrade, downgrade, or cancel at any time from your Account page. No lock-in.',
  },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0F1629]">
      <Navbar />

      {/* Hero */}
      <section className="relative overflow-hidden pt-32 pb-24 px-4">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-40 -right-40 w-[600px] h-[600px] bg-violet-600/20 rounded-full blur-3xl" />
          <div className="absolute top-60 -left-40 w-[400px] h-[400px] bg-violet-800/15 rounded-full blur-3xl" />
        </div>

        <div className="relative max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-violet-600/20 border border-violet-500/30 text-violet-300 text-sm px-4 py-2 rounded-full mb-8">
            <span className="w-2 h-2 bg-violet-400 rounded-full animate-pulse" />
            AI-powered music censorship
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-extrabold text-white leading-tight mb-6">
            Clean music{' '}
            <span className="gradient-text">in seconds.</span>
          </h1>

          <p className="text-xl text-white/60 max-w-2xl mx-auto mb-10 leading-relaxed">
            Upload any song — Bleeep automatically removes every curse word
            and gives you a clean version to download.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/signup"
              className="w-full sm:w-auto bg-violet-600 hover:bg-violet-700 text-white font-semibold px-8 py-4 rounded-xl text-lg transition-all duration-200 shadow-lg shadow-violet-600/25 hover:shadow-violet-600/40 hover:-translate-y-0.5"
            >
              Clean a Song Free
            </Link>
            <Link
              href="#how-it-works"
              className="w-full sm:w-auto bg-white/10 hover:bg-white/15 text-white font-medium px-8 py-4 rounded-xl text-lg transition-all duration-200"
            >
              See how it works
            </Link>
          </div>

          <p className="text-white/30 text-sm mt-6">
            Free plan includes 3 songs/month. No credit card required.
          </p>
        </div>

        {/* Demo preview card */}
        <div className="relative max-w-2xl mx-auto mt-20">
          <div className="glass rounded-2xl p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-violet-600/30 rounded-lg flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-violet-400">
                  <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                </svg>
              </div>
              <div>
                <p className="text-white font-medium text-sm">song.mp3</p>
                <p className="text-white/40 text-xs">Processing complete</p>
              </div>
              <div className="ml-auto">
                <span className="bg-green-500/20 text-green-400 text-xs px-3 py-1 rounded-full border border-green-500/30">
                  ✓ Ready
                </span>
              </div>
            </div>

            <div className="space-y-2 mb-4">
              {[
                { word: 'f**k', time: '0:43', type: 'muted' },
                { word: 's**t', time: '1:12', type: 'bleeped' },
                { word: 'b***h', time: '2:07', type: 'muted' },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3 bg-white/5 rounded-lg px-4 py-2">
                  <span className="text-red-400 font-mono text-sm font-bold w-16">{item.word}</span>
                  <span className="text-white/40 text-xs">{item.time}</span>
                  <span className="ml-auto text-xs bg-violet-600/30 text-violet-300 px-2 py-0.5 rounded">
                    {item.type}
                  </span>
                </div>
              ))}
            </div>

            <button className="w-full bg-violet-600 hover:bg-violet-700 text-white py-3 rounded-xl font-medium transition-colors text-sm">
              Download Clean Version
            </button>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-24 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold text-white mb-4">How it works</h2>
            <p className="text-white/50 text-lg max-w-xl mx-auto">
              Three simple steps. Takes less than 3 minutes for most songs.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {steps.map((s) => (
              <div key={s.step} className="glass rounded-2xl p-8 hover:border-violet-500/30 transition-all duration-300">
                <div className="text-violet-400 mb-6">{s.icon}</div>
                <div className="text-violet-500 text-xs font-bold tracking-widest mb-2">STEP {s.step}</div>
                <h3 className="text-white text-xl font-semibold mb-3">{s.title}</h3>
                <p className="text-white/50 text-sm leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing preview */}
      <section id="pricing" className="py-24 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold text-white mb-4">Simple, honest pricing</h2>
            <p className="text-white/50 text-lg">Start free. Upgrade when you need more.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="glass rounded-2xl p-8">
              <div className="mb-6">
                <h3 className="text-white text-xl font-bold mb-1">Free</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold text-white">$0</span>
                  <span className="text-white/40">/month</span>
                </div>
              </div>
              <ul className="space-y-3 mb-8">
                {['3 songs per month', 'MP3 & WAV support', 'Mute or bleep options', 'Download clean version'].map((f) => (
                  <li key={f} className="flex items-center gap-3 text-white/70 text-sm">
                    <svg className="w-4 h-4 text-violet-400 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/signup" className="block w-full text-center bg-white/10 hover:bg-white/15 text-white font-medium py-3 rounded-xl transition-colors">
                Get started free
              </Link>
            </div>

            <div className="relative rounded-2xl p-8 bg-violet-600/20 border border-violet-500/50">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <span className="bg-violet-600 text-white text-xs font-bold px-4 py-1 rounded-full">MOST POPULAR</span>
              </div>
              <div className="mb-6">
                <h3 className="text-white text-xl font-bold mb-1">Pro</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold text-white">$12</span>
                  <span className="text-white/40">/month</span>
                </div>
              </div>
              <ul className="space-y-3 mb-8">
                {['Unlimited songs per month', 'MP3 & WAV support', 'Mute or bleep options', 'Download clean version', 'Priority processing', 'Full song history'].map((f) => (
                  <li key={f} className="flex items-center gap-3 text-white/70 text-sm">
                    <svg className="w-4 h-4 text-violet-400 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/pricing" className="block w-full text-center bg-violet-600 hover:bg-violet-700 text-white font-semibold py-3 rounded-xl transition-colors shadow-lg shadow-violet-600/30">
                Get Pro — $12/month
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-24 px-4">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold text-white mb-4">Frequently asked questions</h2>
          </div>
          <div className="space-y-4">
            {faqs.map((faq, i) => (
              <details key={i} className="glass rounded-xl group">
                <summary className="flex items-center justify-between p-6 cursor-pointer list-none">
                  <span className="text-white font-medium pr-4">{faq.q}</span>
                  <svg className="w-5 h-5 text-violet-400 flex-shrink-0 group-open:rotate-180 transition-transform duration-200" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </summary>
                <p className="px-6 pb-6 text-white/60 text-sm leading-relaxed">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-24 px-4">
        <div className="max-w-3xl mx-auto text-center">
          <div className="glass rounded-3xl p-12">
            <h2 className="text-4xl font-bold text-white mb-4">Ready to clean your music?</h2>
            <p className="text-white/50 text-lg mb-8">
              Join thousands of users who trust Bleeep to deliver clean versions in seconds.
            </p>
            <Link
              href="/signup"
              className="inline-block bg-violet-600 hover:bg-violet-700 text-white font-semibold px-10 py-4 rounded-xl text-lg transition-all duration-200 shadow-lg shadow-violet-600/25 hover:-translate-y-0.5"
            >
              Clean a Song Free
            </Link>
            <p className="text-white/30 text-sm mt-4">Free forever. No credit card required.</p>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}
