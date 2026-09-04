# Journey Atlas

An interactive map of how the site works, written for anyone at Valuatum — not
only developers. It shows three journeys stacked as horizontal bands:

- **Analyst publishing their own work** — writes with the engine, steers it with revisions or hand edits, publishes, earns half, and reads rivals in exchange for scoring them.
- **Anyone buying a report** — no account: finds a company page, pays, gets a PDF; can buy revisions on a free report and edit the text by hand.
- **Member on a monthly plan** — picks from the catalog, own generations, other analysts' work.

Pick a situation from the dropdowns, or click any step, and the path that
actually runs lights up. Each step shows a real screenshot, what the person
sees, what happens behind the scenes, and — folded away — where it lives in the
code.

**Where to read it:** <https://www.aiequityreports.com/admin/atlas.html>, also
linked as "Interactive docs" from the admin page's tabs. It is a static page with no sign-in of
its own, exactly like `admin/index.html`, and it is excluded from search
engines through `robots.txt` and a `noindex` tag. It contains no live customer
data — every screenshot is either a public page or a mocked account.

## Changing it

Everything on the page is generated from `data.json`. To fix a description, add
a step, or change a branch, edit that file and rebuild:

```sh
node docs/atlas/build.mjs      # writes admin/atlas.html
```

The build refuses to write if a journey is broken: every combination of the
dropdowns must end at a step marked `"terminal": true`, every step must be
reachable, every arrow must be used by at least one combination, and no two
steps in a column may overlap on the canvas (cards are taller than one row —
leave two rows between two screens). That check is what keeps the map honest as
the site changes.

Arrows are tried in the order they appear, so a conditional arrow must come
*before* the unconditional one out of the same step, or it can never be taken.
The build catches that as an unused arrow.

### The shape of `data.json`

```jsonc
{
  "journeys": [{
    "id": "customer",
    "label": "Anyone buying a report",     // band heading
    "sub":   "No account. Finds a page…",  // one line under it
    "start": "c_start",                    // the first step
    "columns": ["Starts on", "Chooses"],   // headings across the top
    "controls": [{                         // the dropdowns
      "id": "product", "label": "They…",
      "options": [{ "value": "free", "label": "Open a free report" }]
    }],
    "nodes": [{
      "id": "c_start",
      "kind": "screen",        // screen | email | system | decision | outcome
      "col": 0, "row": 2,      // position in the band
      "label": "Company report page",
      "img": "report-page-top",            // shots/report-page-top.jpg
      "imgs": ["report-page-top", "home"], // more screens, shown in the panel
      "imgBy": { "fresh": "success-fresh" },// swap the screenshot per dropdown value
      "sees":   "What the person sees.",
      "behind": "What happens behind the scenes.",
      "gap":    "Something worth knowing — shown as a highlighted note.",
      "dev":    ["api/webhook.js — receives the payment"],
      "outcome": "ok",         // ok | warn | bad — colours an ending
      "terminal": true         // this step ends the journey
    }],
    "edges": [{
      "id": "c2", "from": "c_choose", "to": "c_free",
      "label": "free PDF",
      "when": { "product": ["free"] }   // only when the dropdown says so
    }]
  }]
}
```

An arrow with no `when` is always available. Walking a journey means starting at
`start` and repeatedly taking the *first* arrow out of the current step whose
`when` matches — so order the arrows with the more specific ones first.

## Re-taking the screenshots

```sh
docs/atlas/capture/capture.sh          # everything (a few minutes)
docs/atlas/capture/capture.sh live     # only the public pages
docs/atlas/capture/capture.sh mock     # the pages that need a paid session
docs/atlas/capture/capture.sh member   # the member area and analyst workspace
docs/atlas/capture/capture.sh email    # the emails
node docs/atlas/build.mjs
```

Needs Chrome, `python3` with Pillow, node and `pdftoppm`. Screenshots land in
`shots/` as 1000px-wide JPEGs and are inlined into the built page. The mocked
pages carry invented but self-consistent data — Nordic companies, plausible
figures — so nothing real about a customer or an analyst is in them.

Three kinds of screen cannot simply be visited:

- **The thank-you page and the order page** need a paid Stripe session, so
  `capture/mock-api.py` serves this repo's own HTML with mocked API answers.
  That is how the order page is captured while writing, delivered, revised,
  revised with the forecasts kept, out of rounds, failed, after a failed
  revision, and after a hand edit. The text
  editor itself is driven over the DevTools protocol (`capture/shoot-editor.py`):
  it presses the edit button, clicks a paragraph in the sandboxed preview and
  types, since no static screenshot can show a change in progress. The mock
  answers the preview request with a short stand-in for the engine's document.
- **The member area and the analyst workspace** need a signed-in account.
  `capture/member-mock.html` is `members.html` with the sign-in and the members
  API stubbed out; `capture/shoot-member.py` renders it once per role and cuts
  out each section.
- **The Stripe payment page** only exists inside a live checkout session, so
  `capture/stripe-illustration.html` is a drawing of it. The step says so.

The emails are rendered from `server/email.js` itself
(`capture/render-emails.mjs`), so they cannot drift from what customers get.

## Checking it still works

```sh
python3 -m http.server 8767                  # from the repo root
python3 docs/atlas/test-interactions.py
```

This drives the built page with **real mouse events** over the DevTools
protocol and checks that clicking a step selects it and lights its path, that
the dropdowns follow the click, that dragging pans without selecting, that the
wheel zooms, that clicking an arrow opens that transition, that a screenshot
opens and closes the lightbox, and that the band buttons switch journeys.

Real events matter: the canvas captures the pointer while dragging, so a click
arrives on the canvas rather than on the step under the cursor. Events
dispatched straight at an element hide that — which is exactly how a broken
build once passed.

## What this does not cover yet

- The admin site and how pages get built. Both were on the map once and were
  taken off to keep it about the people who use the site.
- Coaching analysts — a role that exists in the backend with no button anywhere.
- The institutions enquiry as its own journey; it appears as a second form on
  the buyer's coverage request.
- Anything below the surface of the report engine itself.
