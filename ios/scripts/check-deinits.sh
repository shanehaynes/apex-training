#!/usr/bin/env bash
# Every class compiled under MainActor default isolation must declare
# `nonisolated deinit`.
#
# WHY THIS EXISTS
# With SWIFT_DEFAULT_ACTOR_ISOLATION / .defaultIsolation(MainActor.self), the
# Swift 6.2+ compiler synthesizes an *isolated* deinit for every class in the
# module. Deallocation then goes through swift_task_deinitOnExecutor, and on the
# iOS 17/18 runtime (the deployment floor is 17.0, so the back-deploy thunk is
# emitted) that aborts inside libmalloc whenever the object dies outside a task —
# a synchronous XCTest method, a view teardown. swiftlang/swift#87316, #85663,
# D-031 in docs/ios/decisions.md. An explicit `nonisolated deinit {}` removes the
# synthesized one; a class with a real deinit body marks that body nonisolated.
#
# CI's ios job runs the iOS 26 simulator only, which does not reproduce the
# crash, so this grep is the enforcement. It runs from scripts/ci-guards.sh on
# every push, on Linux and on a Mac alike.
#
#   ios/scripts/check-deinits.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# The source directories of every MainActor-default target. Where the setting
# lives: ios/project.yml (Apex, ApexWidgets) and
# ios/Packages/ApexKit/Package.swift (ApexUI, ApexFeatures, ApexActivity).
dirs=(
  ios/Apex
  ios/ApexWidgets
  ios/Packages/ApexKit/Sources/ApexUI
  ios/Packages/ApexKit/Sources/ApexFeatures
  ios/Packages/ApexKit/Sources/ApexActivity
)

# The list above is hand-maintained, so pin the count of targets that opt in:
# a new MainActor-default target has to be added here to pass.
yml=$(grep -cE '^[[:space:]]*SWIFT_DEFAULT_ACTOR_ISOLATION: MainActor' ios/project.yml || true)
pkg=$(grep -c 'defaultIsolation(MainActor.self)' ios/Packages/ApexKit/Package.swift || true)
if [ "$yml" -ne 2 ] || [ "$pkg" -ne 3 ]; then
  echo "::error::MainActor default isolation is set on $yml project.yml target(s) and" \
    "$pkg ApexKit target(s) (expected 2 and 3). A target changed its default isolation:" \
    "update 'dirs' and the expected counts in ios/scripts/check-deinits.sh."
  exit 1
fi

# One `class` declaration per `nonisolated deinit` in the same file. `class func`
# and `class var` do not match: the pattern wants a type name after the keyword.
class_re='^[[:space:]]*(public |internal |private |fileprivate |open |package )?(final )?class [A-Z]'
failed=0
while IFS= read -r file; do
  classes=$(grep -cE "$class_re" "$file" || true)
  [ "$classes" -eq 0 ] && continue
  deinits=$(grep -c 'nonisolated deinit' "$file" || true)
  if [ "$classes" -gt "$deinits" ]; then
    echo "$file: $classes class(es), $deinits nonisolated deinit(s)"
    grep -nE "$class_re" "$file"
    failed=1
  fi
done < <(find "${dirs[@]}" -name '*.swift' -not -path '*/build/*' | sort)

if [ "$failed" -ne 0 ]; then
  echo "::error::A class in a MainActor-default target has no 'nonisolated deinit' (listed above)." \
    "Add 'nonisolated deinit {}' to it — or, if it already has a deinit, mark that deinit" \
    "nonisolated. Otherwise deallocation aborts on the iOS 17/18 runtime (D-031)."
  exit 1
fi
echo "iOS isolated deinits: clean"
