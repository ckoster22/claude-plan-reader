#!/usr/bin/env bash
#
# seed-fixture-tree.sh — mark THIS project's own real plan tree in ~/.claude/plans/
# so the nested-sidebar feature is demonstrable on live data.
#
# WHY A HARDCODED TABLE?
#   There is NO programmatic way to discover which random-stemmed files in
#   ~/.claude/plans/ are the sub-plans of a given master. That is precisely the
#   problem the nested-sidebar feature exists to solve: the master -> sub-plan
#   relationship does not exist in the data the app reads — it lives only in
#   project-local .plan-tree/ dirs the app never touches. Most "masters" in the
#   corpus are lone files whose "### Sub-Plan" headers are decomposition *text*,
#   not separate files. So membership for this fixture was verified BY HAND and
#   is encoded below as an explicit (stem, frontmatter-block) table.
#
# WHAT IT DOES
#   For each entry, it prepends the YAML frontmatter marker to
#   $HOME/.claude/plans/<stem>.md ONLY IF that file does not already begin with
#   a "---" fence on line 1. This makes the script idempotent: re-running it
#   skips files that are already marked (e.g. the sub, which the built-in writer
#   created already carrying its frontmatter).
#
# HOW TO EXTEND (e.g. when sub-plan 02 is later drafted)
#   1. Verify by hand which ~/.claude/plans/<stem>.md file is the new sub.
#   2. Append a new ENTRIES block below, e.g.:
#         "some-new-stem"$'\n'"---"$'\n'"tree_id: nested-sidebar-2026"$'\n'"flavor: sub"$'\n'"nn: 2"$'\n'"---"
#      (flavor: sub + nn: N for subs; flavor: master for the master).
#   3. Re-run the script — already-marked files are skipped automatically.
#
# SHELL CONVENTIONS
#   No $() command substitution and no backslash-escaped shell operators, per
#   project conventions. Plain, readable bash.

set -euo pipefail

PLANS_DIR="$HOME/.claude/plans"

# --- Hardcoded, human-verified membership table -----------------------------
# Each entry is a stem followed by the exact frontmatter block to prepend.
# Stems and their frontmatter are paired by array index.

STEMS=(
  "floating-honking-treehouse"
  "humble-exploring-walrus"
  "modular-hatching-bird"
)

# Frontmatter blocks, one per stem (same index as STEMS).
FRONTMATTER_0="---
tree_id: nested-sidebar-2026
flavor: master
---
"

FRONTMATTER_1="---
tree_id: nested-sidebar-2026
flavor: sub
nn: 1
---
"

# Second sub (nn: 2, SAME tree_id) so a 2-child nested group exists for the live visual check.
# modular-hatching-bird is this tree's Sub-Plan 02 plan file in ~/.claude/plans/.
FRONTMATTER_2="---
tree_id: nested-sidebar-2026
flavor: sub
nn: 2
---
"

FRONTMATTERS=(
  "$FRONTMATTER_0"
  "$FRONTMATTER_1"
  "$FRONTMATTER_2"
)

marked_count=0
skipped_count=0

i=0
while [ "$i" -lt "${#STEMS[@]}" ]; do
  stem="${STEMS[$i]}"
  frontmatter="${FRONTMATTERS[$i]}"
  target="$PLANS_DIR/$stem.md"

  if [ ! -f "$target" ]; then
    echo "MISSING: $target does not exist — skipping" >&2
    skipped_count=$((skipped_count + 1))
    i=$((i + 1))
    continue
  fi

  first_line=""
  IFS= read -r first_line < "$target" || true

  if [ "$first_line" = "---" ]; then
    echo "SKIP   : $stem.md already begins with a '---' fence (already marked)"
    skipped_count=$((skipped_count + 1))
  else
    tmp="$target.seed-tmp"
    printf '%s' "$frontmatter" > "$tmp"
    cat "$target" >> "$tmp"
    mv "$tmp" "$target"
    echo "MARK   : $stem.md — prepended frontmatter"
    marked_count=$((marked_count + 1))
  fi

  i=$((i + 1))
done

echo ""
echo "Done. marked=$marked_count skipped=$skipped_count"
