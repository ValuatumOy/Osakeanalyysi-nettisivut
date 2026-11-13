#!/usr/bin/env bash
# Run only after the workflow's new, unpushed commit; the worktree must be clean.
set -euo pipefail

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Cannot finalize freshness with uncommitted changes.' >&2
  exit 1
fi

commit_time="$(git show -s --format=%cI HEAD)"
for attempt in 1 2; do
  node scripts/build-page-freshness.mjs
  git add -u -- index.html reports.html pricing.html faq.html methodology.html about.html analysts.html analyst-story.html analyst-terms.html institutions.html blog.html disclaimer.html members.html comparisons.html
  if git diff --cached --quiet; then break; fi
  GIT_COMMITTER_DATE="$commit_time" git commit --amend --no-edit
done
node scripts/build-page-freshness.mjs --check
