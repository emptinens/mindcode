// Bundled "deep-research" workflow. Plain JS, runs inside the workflow VM.
// Scope -> pipeline(Search -> URL-dedup -> Fetch+Extract) -> 3-vote Verify -> Synthesize.
// Reconstructed from the 2.1.178 bundle's deep-research harness.

export const DEEP_RESEARCH_SCRIPT = String.raw`
export const meta = {
  name: 'deep-research',
  description: 'Deep research harness \u2014 fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
  whenToUse: 'When the user wants a deep, multi-source, fact-checked research report on any topic. If underspecified, ask 2-3 clarifying questions first, then pass the refined question as args.',
  phases: [
    { title: 'Scope', detail: 'Decompose question (from args) into 5 search angles' },
    { title: 'Search', detail: '5 parallel WebSearch agents, one per angle' },
    { title: 'Fetch', detail: 'URL-dedup, fetch top 15 sources, extract falsifiable claims' },
    { title: 'Verify', detail: '3-vote adversarial verification per claim (need 2/3 refutes to kill)' },
    { title: 'Synthesize', detail: 'Merge semantic dupes, rank by confidence, cite sources' },
  ],
}

const VOTES_PER_CLAIM = 3
const REFUTATIONS_REQUIRED = 2
const MAX_FETCH = 15
const MAX_VERIFY_CLAIMS = 25

const SCOPE_SCHEMA = {
  type: 'object', required: ['question', 'angles', 'summary'],
  properties: {
    question: { type: 'string' },
    summary: { type: 'string' },
    angles: { type: 'array', minItems: 3, maxItems: 6, items: {
      type: 'object', required: ['label', 'query'],
      properties: { label: { type: 'string' }, query: { type: 'string' }, rationale: { type: 'string' } },
    } },
  },
}
const SEARCH_SCHEMA = {
  type: 'object', required: ['results'],
  properties: { results: { type: 'array', maxItems: 6, items: {
    type: 'object', required: ['url', 'title', 'relevance'],
    properties: { url: { type: 'string' }, title: { type: 'string' }, snippet: { type: 'string' }, relevance: { enum: ['high', 'medium', 'low'] } },
  } } },
}
const EXTRACT_SCHEMA = {
  type: 'object', required: ['claims', 'sourceQuality'],
  properties: {
    sourceQuality: { enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'] },
    publishDate: { type: 'string' },
    claims: { type: 'array', maxItems: 5, items: {
      type: 'object', required: ['claim', 'quote', 'importance'],
      properties: { claim: { type: 'string' }, quote: { type: 'string' }, importance: { enum: ['central', 'supporting', 'tangential'] } },
    } },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['refuted', 'evidence', 'confidence'],
  properties: { refuted: { type: 'boolean' }, evidence: { type: 'string' }, confidence: { enum: ['high', 'medium', 'low'] }, counterSource: { type: 'string' } },
}
const REPORT_SCHEMA = {
  type: 'object', required: ['summary', 'findings', 'caveats'],
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: {
      type: 'object', required: ['claim', 'confidence', 'sources', 'evidence'],
      properties: { claim: { type: 'string' }, confidence: { enum: ['high', 'medium', 'low'] }, sources: { type: 'array', items: { type: 'string' } }, evidence: { type: 'string' } },
    } },
    caveats: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

phase('Scope')
const QUESTION = (typeof args === 'string' && args.trim()) || ''
if (!QUESTION) {
  return { error: "No research question provided. Pass it as args: Workflow({name: 'deep-research', args: '<question>'})." }
}
const scope = await agent(
  'Decompose this research question into complementary search angles.\n\n## Question\n' + QUESTION + '\n\n' +
  '## Task\nGenerate 5 distinct web search queries that together cover the question from different angles. Make queries specific enough to surface high-signal results. Avoid redundancy.\nReturn the question, a 1-2 sentence decomposition strategy, and the angles.\n\nStructured output only.',
  { label: 'scope', schema: SCOPE_SCHEMA }
)
if (!scope) return { error: 'Scope agent returned no result.' }
log('Q: ' + QUESTION.slice(0, 80))
log('Decomposed into ' + scope.angles.length + ' angles: ' + scope.angles.map(a => a.label).join(', '))

const normURL = u => { try { const p = new URL(u); return (p.hostname.replace(/^www\./, '') + p.pathname.replace(/\/$/, '')).toLowerCase() } catch { return u.toLowerCase() } }
const seen = new Map()
let fetchSlots = MAX_FETCH

const SEARCH_PROMPT = (angle) =>
  '## Web Searcher: ' + angle.label + '\n\nResearch question: "' + QUESTION + '"\nYour angle: ' + angle.label + ' \u2014 ' + (angle.rationale || '') + '\nSearch query: ' + angle.query + '\n\nUse WebSearch with the query above. Return the top 4-6 most relevant results, ranked by relevance to the ORIGINAL question. Include a short snippet.\n\nStructured output only.'

const FETCH_PROMPT = (source, angle) =>
  '## Source Extractor\n\nResearch question: "' + QUESTION + '"\nFetch and extract key claims from this source:\nURL: ' + source.url + '\nTitle: ' + source.title + '\nFound via: ' + angle + '\n\n1. Use WebFetch to retrieve the page.\n2. Assess source quality.\n3. Extract 2-5 FALSIFIABLE claims that bear on the question, each with a direct quote and importance rating.\nIf the fetch fails or is irrelevant, return claims: [] and sourceQuality: "unreliable".\n\nStructured output only.'

const VERIFY_PROMPT = (claim, v) =>
  '## Adversarial Claim Verifier (voter ' + (v + 1) + '/' + VOTES_PER_CLAIM + ')\n\nBe SKEPTICAL. Try to REFUTE this claim. >=' + REFUTATIONS_REQUIRED + '/' + VOTES_PER_CLAIM + ' refutations kill it.\n\nResearch question: ' + QUESTION + '\nClaim under review: "' + claim.claim + '"\nSource: ' + claim.sourceUrl + ' (' + claim.sourceQuality + ')\nSupporting quote: "' + claim.quote + '"\n\nWebSearch for contradicting evidence. Decide refuted true/false with evidence and confidence.\n\nStructured output only.'

phase('Search')
const searchResults = await parallel(scope.angles.map(angle => () => agent(SEARCH_PROMPT(angle), { label: 'search:' + angle.label, phase: 'Search', schema: SEARCH_SCHEMA })))

phase('Fetch')
const toFetch = []
for (let i = 0; i < scope.angles.length; i++) {
  const res = searchResults[i]
  if (!res || !res.results) continue
  for (const r of res.results) {
    const key = normURL(r.url)
    if (seen.has(key)) continue
    if (fetchSlots <= 0) break
    seen.set(key, true)
    fetchSlots--
    toFetch.push({ source: r, angle: scope.angles[i].label })
  }
}
const extracted = await parallel(toFetch.map(f => () => agent(FETCH_PROMPT(f.source, f.angle), { label: 'fetch:' + (f.source.title || f.source.url).slice(0, 30), phase: 'Fetch', schema: EXTRACT_SCHEMA })))

const claims = []
for (let i = 0; i < toFetch.length; i++) {
  const ex = extracted[i]
  if (!ex || !ex.claims) continue
  for (const c of ex.claims) {
    if (claims.length >= MAX_VERIFY_CLAIMS) break
    claims.push({ ...c, sourceUrl: toFetch[i].source.url, sourceQuality: ex.sourceQuality })
  }
}
log('Extracted ' + claims.length + ' claims to verify')

phase('Verify')
const verified = []
for (const claim of claims) {
  const votes = await parallel(Array.from({ length: VOTES_PER_CLAIM }, (_, v) => () => agent(VERIFY_PROMPT(claim, v), { label: 'verify', phase: 'Verify', schema: VERDICT_SCHEMA })))
  const refutes = votes.filter(Boolean).filter(x => x.refuted).length
  if (refutes < REFUTATIONS_REQUIRED) {
    verified.push({ ...claim, votes })
  }
}
log(verified.length + ' of ' + claims.length + ' claims survived adversarial verification')

phase('Synthesize')
const report = await agent(
  '## Synthesizer\n\nResearch question: ' + QUESTION + '\n\nYou are given verified claims (each survived adversarial review) with their sources. Merge semantic duplicates, rank findings by confidence, and write a cited report.\n\nVerified claims (JSON):\n' + JSON.stringify(verified.map(c => ({ claim: c.claim, source: c.sourceUrl, quality: c.sourceQuality }))) + '\n\nReturn a summary, findings (each with claim, confidence, sources, evidence), caveats, and open questions.\n\nStructured output only.',
  { label: 'synthesize', phase: 'Synthesize', schema: REPORT_SCHEMA }
)
return report || { error: 'Synthesis failed.', verifiedClaims: verified.length }
`
