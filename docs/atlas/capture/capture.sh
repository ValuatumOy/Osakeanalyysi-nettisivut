#!/usr/bin/env bash
# Re-takes every screenshot the Journey Atlas uses.
#
#   docs/atlas/capture/capture.sh          # everything
#   docs/atlas/capture/capture.sh live     # only the public pages
#   docs/atlas/capture/capture.sh mock     # only the pages that need a paid session
#   docs/atlas/capture/capture.sh member   # only the member area / analyst workspace
#   docs/atlas/capture/capture.sh email    # only the emails
#
# Needs: google-chrome (or chromium), python3 with Pillow, node, pdftoppm.
# Writes 1000px-wide JPEGs into docs/atlas/shots/, then run:
#   node docs/atlas/build.mjs
#
# Three of these pages cannot be reached without a real payment, so they are
# rendered from the repo's own HTML against a small mock API (mock-api.py):
# the thank-you page and the order page in each of its states. The Stripe
# payment page is an illustration (stripe-illustration.html) — a real one only
# exists inside a live checkout session.

set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
REPO="$(cd ../../.. && pwd)"
OUT="$REPO/docs/atlas/shots"
TMP="$(mktemp -d)"
LIVE="${ATLAS_SITE:-https://www.aiequityreports.com}"
WHAT="${1:-all}"
CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"
mkdir -p "$OUT"
trap 'rm -rf "$TMP"; [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true' EXIT

shot () { # shot <name> <url> [WxH]
  "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --window-size="${3:-1280,900}" --virtual-time-budget=8000 \
    --screenshot="$TMP/$1.png" "$2" >/dev/null 2>&1 || echo "  ! $1 failed"
}

if [ "$WHAT" = all ] || [ "$WHAT" = live ]; then
  echo "public pages…"
  shot report-page   "$LIVE/reports/stora-enso-equity-report.html" 1280,2200
  # a free report's page, where the only paid button is "Create a revision"
  shot free-report   "$LIVE/reports/stora-enso-equity-report.html" 1280,900
  shot catalog-tall  "$LIVE/reports.html"        1280,5200
  shot home          "$LIVE/"                    1280,900
  shot search        "$LIVE/search.html"         1280,900
  shot cancel        "$LIVE/checkout/cancel.html" 1280,900
  shot members-tall  "$LIVE/members.html"        1280,1800
  shot analysts      "$LIVE/analysts.html"       1280,3000
  shot analyst-story "$LIVE/analyst-story.html"  1280,1600
  shot pricing       "$LIVE/pricing.html"        1280,2400
  shot institutions  "$LIVE/institutions.html"   1280,2600
  echo "the free PDF's first page…"
  curl -sf "$LIVE/reports.html" | grep -o 'https://files[^"]*\.pdf' | head -1 > "$TMP/pdfurl" || true
  if [ -s "$TMP/pdfurl" ]; then
    curl -s -o "$TMP/free.pdf" "$(cat "$TMP/pdfurl")"
    pdftoppm -png -r 80 -f 1 -l 1 "$TMP/free.pdf" "$TMP/free-pdf-page" && mv "$TMP/free-pdf-page"*.png "$TMP/free-pdf.png"
  else
    echo "  ! no free PDF link found on reports.html — keeping the old free-pdf shot"
  fi
fi

if [ "$WHAT" = all ] || [ "$WHAT" = mock ]; then
  echo "pages that need a paid session (served from this repo against mock-api.py)…"
  python3 "$HERE/mock-api.py" & MOCK_PID=$!
  sleep 1
  M=http://127.0.0.1:8765
  shot success-ready     "$M/checkout/success.html?session_id=ready"
  shot success-readyrev  "$M/checkout/success.html?session_id=readyrev"
  shot success-fresh     "$M/checkout/success.html?session_id=fresh"
  shot order-prog        "$M/order/index.html?session_id=prog"
  shot order-deliv       "$M/order/index.html?session_id=deliv"      1280,1100
  shot order-revised     "$M/order/index.html?session_id=revised"    1280,1500
  shot order-exhausted   "$M/order/index.html?session_id=exhausted"  1280,1100
  shot order-failed      "$M/order/index.html?session_id=failed"
  shot order-revfail     "$M/order/index.html?session_id=revfail"    1280,1100
  shot success-freerev   "$M/checkout/success.html?session_id=freerev"
  # the text editor open with a paragraph changed, and a hand-edited version in the history
  python3 "$HERE/shoot-editor.py" editor  "$TMP/order-editor.png" "$M/order/index.html?session_id=deliv"
  python3 "$HERE/shoot-editor.py" history "$TMP/order-edited.png" "$M/order/index.html?session_id=edited"
  kill "$MOCK_PID" 2>/dev/null || true; MOCK_PID=
  shot stripe "file://$HERE/stripe-illustration.html" 1280,820
fi

if [ "$WHAT" = all ] || [ "$WHAT" = member ]; then
  echo "member area and analyst workspace (real members.html, mocked sign-in)…"
  cp "$HERE/member-mock.html" "$REPO/member-mock.html"
  (cd "$REPO" && python3 -m http.server 8766 >/dev/null 2>&1) & MOCK_PID=$!
  sleep 1
  # member-mock.html reports each section's position on the page; shoot-member.py
  # renders the whole page once per role and cuts the sections out of it.
  python3 "$HERE/shoot-member.py" sub     "$TMP"
  python3 "$HERE/shoot-member.py" analyst "$TMP"
  python3 "$HERE/shoot-member.py" noplan  "$TMP"
  rm -f "$REPO/member-mock.html"
  kill "$MOCK_PID" 2>/dev/null || true; MOCK_PID=
  # section  ->  the name the atlas refers to
  cp "$TMP/crop-sub-memberView.png"       "$TMP/member-dashboard.png"
  cp "$TMP/crop-sub-reportsTable.png"     "$TMP/member-library.png"
  cp "$TMP/crop-sub-genCard.png"          "$TMP/member-generate.png"
  cp "$TMP/crop-sub-buyGenCard.png"       "$TMP/member-extra.png"
  cp "$TMP/crop-noplan-plansCard.png"     "$TMP/member-plans.png"
  cp "$TMP/crop-analyst-memberView.png"   "$TMP/analyst-workspace.png"
  cp "$TMP/crop-analyst-genCard.png"      "$TMP/analyst-publish.png"
  cp "$TMP/crop-analyst-earningsCard.png" "$TMP/analyst-income.png"
  cp "$TMP/crop-analyst-analysesCard.png" "$TMP/analyst-reviews.png"
fi

if [ "$WHAT" = all ] || [ "$WHAT" = email ]; then
  echo "emails (rendered from server/email.js templates)…"
  node "$HERE/render-emails.mjs" "$TMP"
  for n in email-report email-confirm email-revised email-freerev; do
    [ -f "$TMP/$n.html" ] && shot "$n" "file://$TMP/$n.html" 760,640
  done
fi

echo "cropping and converting…"
python3 - "$TMP" "$OUT" <<'PY'
import sys, os
from PIL import Image
tmp, out = sys.argv[1], sys.argv[2]
# Sections cut out of a taller render: name -> (source, top, bottom)
CROPS = {
  'report-page-top':  ('report-page',    0,   900),
  'catalog-card':     ('catalog-tall',   1640, 2040),
  'catalog':          ('catalog-tall',   0,   900),
  'order-fresh':      ('catalog-tall',   4290, 4680),
  'coverage':         ('catalog-tall',   4690, 5200),
  'members-signin':   ('members-tall',   0,   900),
  'members':          ('members-tall',   0,   900),
  'analysts-top':     ('analysts',       0,   1000),
  'analysts-terms':   ('analysts',       1000, 2100),
  'pricing-top':      ('pricing',        0,   1100),
  'pricing-plans':    ('pricing',        1100, 2400),
  'institutions-form':('institutions',   1300, 2400),
  'order-revision-box': ('order-deliv',  380, 1100),
  'order-revised-top':  ('order-revised', 0,   860),
}
made = []
for name, (src, top, bot) in CROPS.items():
    p = os.path.join(tmp, src + '.png')
    if not os.path.exists(p): continue
    im = Image.open(p)
    im.crop((0, top, im.width, min(bot, im.height))).save(os.path.join(tmp, name + '.png'))
    made.append(name)
for f in sorted(os.listdir(tmp)):
    if not f.endswith('.png'): continue
    im = Image.open(os.path.join(tmp, f)).convert('RGB')
    im = im.resize((1000, int(im.height * 1000 / im.width)), Image.LANCZOS)
    if im.height > 2400: im = im.crop((0, 0, 1000, 2400))
    im.save(os.path.join(out, f[:-4] + '.jpg'), 'JPEG', quality=68, optimize=True)
    made.append(f[:-4])
print('  wrote', len(set(made)), 'files into shots/')
PY

echo
echo "done — now run:  node docs/atlas/build.mjs"
