# Editing the report text by hand

A customer or member can change the text of a delivered report directly on
the order page and save the result as a new version. The engine re-renders
the report with the new text in seconds; no AI is involved. This sits next to
the existing AI revisions ("request a revision" with instructions), which stay
as they are.

## Rules

- **Free and unlimited.** An edit never consumes a revision round and is
  offered on any delivered report, including one with no rounds at all.
- **Counts as a change.** A forked analysis must be revised *or edited* at
  least once before it can be published (`editsUsed` alongside `revisionsUsed`
  on the order row).
- **Published means frozen** for edits exactly as for revisions.
- **The current version only.** An edit is applied to the newest delivered
  version and becomes the next one; versions stay linear. `originalJobId` on
  the order row keeps version 1's engine job so editing an older version can
  be added later without a migration.
- **Prose only.** Headings the template owns can be edited too; figures,
  tables and charts cannot. The engine warns when an edit changes a number in
  prose (the tables were not updated) and when a page no longer fits.

## Who wrote which version

Every history entry carries `kind` (`revision` | `edit`) and `authorship`
(`ai` | `analyst` | `mixed`; the engine's word for a person is "analyst").
The order page labels them:

| Entry | Label |
|---|---|
| the original delivery | Version 1 · Original report — *AI-written* |
| an AI revision | Version N · AI revision — *AI-written* |
| an AI revision of a version that had hand edits | Version N · AI revision — *AI-written · keeps your hand edits*, plus which paragraphs were kept, rewritten or dropped (`changes.analystProse`) |
| a hand edit | Version N · Edited by hand — *Written by ⟨name⟩*, and "from version M" when M is not N−1 |

Entries written before this existed have neither field and are AI revisions.

## What "what changed" shows

- AI revisions: the engine's change memo, as before.
- Hand edits: every edited paragraph **before and after**, word-level, from
  the `edits: [{ pointer, before, after }]` stored on the entry. `before` is
  the text the editor showed (sent by the browser as `originals`), display
  only; the engine's own mechanical memo is stored alongside and rendered
  when an entry has no stored edits. Then the engine's warnings per paragraph
  (figures changed by hand, over the length hint) and the page-fit report.

## How it works

```
order page ── GET /preview ──► Lambda ── engine.getJob(order.jobId).previewUrl ──► S3 (presigned)
   │  the engine's rendered HTML, with `data-pointer` on every editable element
   │  + a small editing script appended, in an <iframe sandbox="allow-scripts">
   │  (no same-origin: the page never touches the document, nor the reverse)
   │  click → contenteditable; edits and a live page-fit estimate come back
   │  through postMessage
   └─ POST /edits { edits: {pointer: text}, originals, editedBy? }
        └─► claimEdit: DELIVERED → REVISING, pendingEdit on the row
              └─► worker: engine POST /jobs/{jobId}/edits → poll → deliverRevision()
                    with `activeEdit` set: own PDF file, no email, editsUsed+1,
                    history entry { kind: 'edit', authorship, edits, editWarnings, fit }
```

Routes: shop orders use `POST /api/orders/{id}/edits` and
`GET /api/orders/{id}/preview` on the API Lambda, reached through the Vercel
proxies `api/order-revision.js` (body `edits`) and `api/order-status.js`
(`?preview=1`) — the Vercel plan is at its twelve-function ceiling, so no new
functions. Members use `POST /generations/{genId}/edits` and
`GET /generations/{genId}/preview`; the byline is always the member's own
name. Validation for both lives in `server/report-edits.js`; the shared
payload/preview helpers in `server/order-editing.js`.

The preview is proxied (~1.6 MB per load) rather than fetched from S3 by the
browser, so the engine's bucket needs no cross-origin configuration and the
presigned URL never leaves the server — the same choice `ai-stock-analysis`
made.

## Prerequisites

The engine must be deployed with `POST /jobs/{jobId}/edits` and `previewUrl`
on `GET /jobs/{jobId}` (branch `2160-analyst-edits-roundtrip` of
`pdf-report-engine`). Reports rendered before that deploy have no preview:
the order page's edit button appears (`hasPreview` is unknown for them) and
opening the editor explains that the report predates editing. Reports
delivered after it record `hasPreview` and the button is hidden when the
engine sent none.

Not built yet: a per-paragraph "let the AI rewrite this" control on the
revision form (the engine's `unfreeze` list — every AI revision currently
keeps all hand edits), editing an older version than the current one, and
any public labelling of a published analysis as hand-edited.
