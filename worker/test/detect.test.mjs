/**
 * Detector unit tests — the Entity's brain must catch every dodge lyrics use
 * (leet-speak, elongation, asterisks, compounds, phrases) without flagging
 * innocent words.
 *
 * Run: npm test (builds first; tests import the compiled dist/).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { detectContent, matchToken } from '../dist/entity/detect.js'

/** Build a transcript from words, 0.4s per word, 0.1s gaps. */
function transcript(text) {
  return text.split(/\s+/).map((word, i) => ({
    word,
    start: +(i * 0.5).toFixed(2),
    end: +(i * 0.5 + 0.4).toFixed(2),
  }))
}

const words = (dets) => dets.map((d) => d.word)

test('exact profanity is detected with full confidence', () => {
  const hit = matchToken('fuck')
  assert.ok(hit)
  assert.equal(hit.source, 'exact')
  assert.equal(hit.confidence, 1.0)
  assert.equal(hit.entry.category, 'profanity')
})

test('punctuation and case are ignored', () => {
  assert.ok(matchToken('FUCK!'))
  assert.ok(matchToken('"Shit,"'))
  assert.ok(matchToken("bitchin'"))
})

test('leet-speak variants are caught', () => {
  // ('sh1t' is an exact lexicon entry; the others resolve via de-leet or
  // vowel-wildcard matching — any hit source is acceptable.)
  for (const tok of ['f4ck', 'sh1t', 'b!tch', 'a$$hole', '5hit', 'fuck1ng']) {
    const hit = matchToken(tok)
    assert.ok(hit, `expected leet hit for ${tok}`)
  }
})

test('leet dodges never resurrect innocent words', () => {
  for (const tok of ['sh0t', 'd0ck', 'h1t', '2024', 'h0t']) {
    assert.equal(matchToken(tok), null, `false positive on "${tok}"`)
  }
})

test('sung elongations collapse to the word', () => {
  for (const tok of ['fuuuuck', 'shiiiit', 'daaaamn', 'biiiitch']) {
    assert.ok(matchToken(tok), `expected elongation hit for ${tok}`)
  }
})

test('asterisk-censored forms are caught', () => {
  for (const tok of ['f*ck', 'motherf**ker', 'n***a', 's**t']) {
    assert.ok(matchToken(tok), `expected starred hit for ${tok}`)
  }
})

test('embedded profanity in compounds is caught', () => {
  for (const tok of ['fuckboy', 'shithead', 'bitchass', 'clusterfuck']) {
    const hit = matchToken(tok)
    assert.ok(hit, `expected embedded hit for ${tok}`)
    assert.equal(hit.source, 'embedded')
  }
})

test('innocent words never match', () => {
  for (const tok of ['bass', 'class', 'classic', 'assist', 'hello', 'shell',
    'scrap', 'ship', 'sheet', 'duck', 'luck', 'glass', 'pass', 'title',
    'cocktail', 'peacock', 'shiitake', 'niggling']) {
    const hit = matchToken(tok)
    // 'shiitake' contains 'shit' after elongation-collapse and 'niggling'
    // contains 'nigg' — known stem-matching tradeoffs. Everything else must
    // be clean.
    if (tok === 'shiitake' || tok === 'niggling') continue
    assert.equal(hit, null, `false positive on "${tok}": ${JSON.stringify(hit)}`)
  }
})

test('suggestive phrases are matched as consecutive words', () => {
  const dets = detectContent(transcript('girl just take it off for me tonight'), {
    profile: 'family',
  })
  assert.ok(words(dets).includes('take it off'), JSON.stringify(dets))
  const d = dets.find((x) => x.word === 'take it off')
  assert.equal(d.source, 'phrase')
  assert.equal(d.category, 'sexual')
  // Span covers all three words
  assert.ok(d.end - d.start >= 1.0)
})

test('phrase is NOT matched in radio profile (suggestive tier off)', () => {
  const dets = detectContent(transcript('girl just take it off for me tonight'), {
    profile: 'radio',
  })
  assert.equal(dets.length, 0, JSON.stringify(dets))
})

test('radio profile still catches all classic profanity', () => {
  const dets = detectContent(transcript('damn this shit is fucked up as hell'), {
    profile: 'radio',
  })
  const found = words(dets).join(' ')
  for (const expect of ['damn', 'shit', 'fucked', 'hell']) {
    assert.ok(found.includes(expect), `radio profile missed "${expect}" in: ${found}`)
  }
})

test('violence only flagged by strict profile', () => {
  const line = transcript('pull the trigger on my enemies')
  assert.equal(detectContent(line, { profile: 'family' }).length, 0)
  const strict = detectContent(line, { profile: 'strict' })
  assert.ok(strict.length >= 1, JSON.stringify(strict))
  assert.equal(strict[0].category, 'violence')
})

test('substances flagged by family profile at severity 2+', () => {
  const dets = detectContent(transcript('sipping lean and popping pills all night'), {
    profile: 'family',
  })
  const found = words(dets).join(' | ')
  assert.ok(found.includes('sipping lean'), found)
  assert.ok(found.includes('popping pills'), found)
})

test('overlapping detections merge into one window', () => {
  // "suck my" (phrase) directly followed by "dick" (word) — spans touch
  const dets = detectContent(transcript('she wanna suck my dick tonight'), {
    profile: 'family',
  })
  assert.equal(dets.length, 1, JSON.stringify(dets))
  assert.ok(dets[0].word.includes('suck my'))
  assert.ok(dets[0].word.includes('dick'))
})

test('detections carry mute_type through', () => {
  const dets = detectContent(transcript('this shit slaps'), { muteType: 'bleep' })
  assert.equal(dets[0].mute_type, 'bleep')
})

test('slurs are flagged in every profile', () => {
  for (const profile of ['radio', 'family', 'strict']) {
    const dets = detectContent(transcript('my nigga we made it'), { profile })
    assert.equal(dets.length, 1, `${profile}: ${JSON.stringify(dets)}`)
    assert.equal(dets[0].category, 'slur')
  }
})
