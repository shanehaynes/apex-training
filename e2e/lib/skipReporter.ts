// Loud-skip reporter (issue #18): a runtime test.skip() renders as one dim
// line and a green exit code, so a spec that silently stops running looks
// exactly like a healthy suite. This reporter prints every skip with its
// reason at the end of the run and, in CI, fails the run outright if a skip
// appears that isn't in the expected set below.
//
// The expected set is the offline-mode skips: CI's mock job has no
// .env.local, so the auth spec has no login gate to drive, and the intercept
// layer stubs exercise_definitions empty, which empties the picker/library
// specs' precondition. If one of these starts *running* in CI that's fine —
// the list is an allowance, not a requirement.

import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { basename } from 'node:path';

const EXPECTED_CI_SKIPS = new Set([
  'auth.spec.ts › login gate, reset mode, fabricated session, profile view',
  'edit-exercises.spec.ts › add an exercise via the picker and save (stubbed PATCH)',
  'library.spec.ts › library list, detail, editor, and deep link',
]);

export default class SkipReporter implements Reporter {
  private skips: { key: string; reason: string }[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== 'skipped') return;
    this.skips.push({
      key: `${basename(test.location.file)} › ${test.title}`,
      // A runtime test.skip(cond, reason) surfaces its reason as a "skip"
      // annotation; statically skipped tests have none.
      reason: test.annotations.find(a => a.type === 'skip')?.description ?? '(no reason given)',
    });
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | void> {
    if (this.skips.length === 0) return;

    console.log(`\n⚠ ${this.skips.length} skipped test(s):`);
    for (const { key, reason } of this.skips) console.log(`  ⚠ ${key} — ${reason}`);

    if (!process.env.CI) return;
    const unexpected = this.skips.filter(s => !EXPECTED_CI_SKIPS.has(s.key));
    if (unexpected.length === 0) return;

    console.error(
      `\n✖ ${unexpected.length} skip(s) not in the expected CI set ` +
      '(e2e/lib/skipReporter.ts) — a spec has silently stopped running. ' +
      'Fix its precondition, or add it to EXPECTED_CI_SKIPS with a reason.',
    );
    for (const { key } of unexpected) console.error(`  ✖ ${key}`);
    return { status: result.status === 'passed' ? 'failed' : result.status };
  }

  printsToStdio() {
    return false;
  }
}
