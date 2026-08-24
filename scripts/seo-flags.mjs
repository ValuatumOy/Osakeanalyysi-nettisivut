// One switch for whether a rating and price target may appear in the metadata that travels
// away from the page: the <title>, the Open Graph share card, and anything else built from
// them.
//
// Why it is off by default. A title and a share card are the surfaces that travel WITHOUT
// the page: a search result reads "SELL, €17.10 Target" with no "AI-generated research,
// not investment advice" anywhere near it, and an AI answer will repeat the verdict stripped
// of every qualifier the page carries. Whether Valuatum publishes investment recommendations
// in that form is a compliance question, not an SEO one, and it is open.
//
// What this switch does NOT cover: the rating is also in each page's meta description, its
// og:description, the visible page body above the paywall, and llms.txt. Those predate this
// flag and are a wider decision. Turning this on does not make the site compliant; leaving
// it off does not make it silent.
//
// The SEO win was title LENGTH, not the rating: the old titles were a median 108 characters
// against Google's ~60, so the company name itself was being cut off. That win is unaffected
// by this flag, and only 17 of 1,174 pages ever carried a rating in the first place.
//
// To turn it back on once that question is answered:
//   SEO_SHOW_RATINGS=1 npm run seo:build && SEO_SHOW_RATINGS=1 npm run seo:og
export const SHOW_RATINGS_IN_METADATA = process.env.SEO_SHOW_RATINGS === '1';
