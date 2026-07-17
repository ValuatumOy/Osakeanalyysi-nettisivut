# Report lifecycle contract

Report visibility and price are separate concerns.

## Publication status

- `ready`: the report may appear on Reports pages, company pages, checkout lookup, related links and the sitemap.
- `hidden`: the PDF exists but is not public. This is the default for a newly delivered customer-specific report.
- `archived`: retained internally, but excluded from public pages, checkout and the sitemap.
- `expired`: outside its sale or publication window and excluded from public pages, checkout and the sitemap.

The catalog also accepts the legacy `availability: "available"` value and maps it to `ready`. `hidden`, `archived`, `expired`, `expiresAt`, and the older boolean flags remain supported for sidecar compatibility.

## Access status

Ready reports have a separate `accessStatus`:

- `free`: direct PDF download, no checkout.
- `paid`: ready-report checkout.

Fresh generation is an order type, not a publication status. A generated report starts as `hidden` unless resale is enabled. When resale is enabled it starts as `ready` + `paid`. The reaper removes generated resale copies after the configured resale window; the permanent engine copy is not deleted.

## Consumer rules

- Reports catalog: only `ready`; latest dated report wins when a company has several.
- Company page: show the latest `ready` report and always retain the fresh-generation option.
- Checkout: accept only a `ready` + `paid` report returned by the public catalog.
- Sitemap and related reports: include only pages generated from `ready` catalog entries.
- Free rotation: choose only `ready` reports, then set `accessStatus` to `free`.

Curated samples can set `forceFree: true`. Reports that must never enter free rotation should set `excludeFromFree: true`.
