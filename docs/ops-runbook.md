# Ops runbook — key escrow, App Store Connect access, Apple Account recovery

Three questions the repository could not answer before this file existed: where each secret
is escrowed, who other than Shane can mint an App Store Connect API key, and how the Apple
Account is recovered if the release Mac and its phone are both gone. A perfect database
restore does not survive the first of those — the dump carries every `user_api_keys` row, but
those rows are ciphertext, and `API_KEY_ENCRYPTION_SECRET` lives only as a Vercel environment
variable (`api/_lib/keyCrypto.ts`, `api/_lib/providers/connection.ts`; README, "Backups").

**No secret value ever goes in this file.** It records *where* a secret lives, *who* can mint
a replacement, and *what breaks* if it is lost. Where the location is not yet decided, the row
says `TODO (Shane)` and names the exact decision — inventing one would be worse than the gap.

State verified against the tree and `gh secret list` on **2026-09-19**.

## 1. Secret inventory

| Secret | Authoritative copy | Escrow copy | Who can mint a replacement | If it is lost |
|---|---|---|---|---|
| age backup private key(s) | **none — no key exists yet** | — | anyone, `age-keygen -o apex-backup.key` | every uploaded bundle is unreadable, permanently |
| `API_KEY_ENCRYPTION_SECRET` | Vercel → Project → Settings → Environment Variables (Production) | **none** | Shane, `openssl rand -base64 32` | every stored Anthropic key and COROS refresh token is unreadable; a restore into a fresh project loses them all |
| `SUPABASE_DB_URL` | **not set** — `backup.yml` skips with a notice | — | Shane: Supabase → Connect → Session pooler (port 5432, password percent-encoded) | nothing is backed up at all |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel (server-only) | not needed | Shane: Supabase → Settings → API → rotate | rotate and redeploy; `api/*` writes fail until then |
| `CRON_SECRET` | Vercel | not needed | any random string, set in Vercel | set a new one; the two crons 401 until it matches |
| `RESEND_API_KEY` | Vercel | not needed | Shane: <https://resend.com/api-keys> (revoke + create, Sending access, apex-training.app only) | review emails stop; nothing else |
| `COROS_CLIENT_ID` / `COROS_REDIRECT_URI` | Vercel | not needed — public PKCE client | `node scripts/coros-spike.mjs register <callback-url>` | re-register; existing connections must reconnect |
| `SEED_SOURCE_USER_ID` | Vercel | not needed | falls back to the `profiles` row with `is_template_source = true` | new accounts seed from the fallback row |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Vercel + `.env.local` | not needed — public by construction | Supabase → Settings → API | — |
| `ASC_KEY_ID`, `ASC_ISSUER_ID` | GitHub Actions secrets; `ios/Config/appstoreconnect.env` on the release Mac | not needed — identifiers, readable in App Store Connect | — | read them back from Users and Access → Integrations |
| `AuthKey_<KEY_ID>.p8` (= `ASC_KEY_P8_BASE64`) | GitHub Actions secret; `~/.appstoreconnect/private_keys/` on the release Mac | **TODO (Shane)** | Account Holder or Admin — §2 | revoke and mint a new key (§2); Apple offers the download **once** |
| `ANTHROPIC_API_KEY` (repo secret, `evals` job only) | GitHub Actions secret | not needed | Anthropic Console, workspace-scoped key | the nightly eval job fails; the app is unaffected (coach keys are per user) |
| `SUPABASE_ANON_KEY` in `ios/Config/Secrets.xcconfig` | git-ignored, per worktree | **not needed, by design** | `ios/scripts/secrets.sh` re-derives it from the deployed bundle | run the script; a Release build without it traps at launch on `REPLACE_ME` |

`gh secret list` on 2026-09-19 returns exactly `ANTHROPIC_API_KEY`, `ASC_ISSUER_ID`,
`ASC_KEY_ID`, `ASC_KEY_P8_BASE64` — no `SUPABASE_DB_URL` — and
[`scripts/backup/age-recipient.txt`](../scripts/backup/age-recipient.txt) holds zero `age1…`
lines. The first two rows of the table are therefore statements of *absence*, not of location.

**The decisions this table is waiting on:**

- **TODO (Shane):** generate two age identities (`age-keygen -o apex-backup.key`, twice),
  paste both `# public key:` values into `scripts/backup/age-recipient.txt`, and record here
  **which password-manager vault and item name** holds each private key. Two recipients means
  losing one identity is not losing the archive. The work is issue #198; this file owns the
  record of where they ended up.
- **TODO (Shane):** copy the live `API_KEY_ENCRYPTION_SECRET` out of Vercel into the password
  manager and record the **item name** here. Decide also whether a second copy exists offline
  (printed, in the same place as the recovery key of §3) — with one copy in one SaaS account,
  losing that account loses every user's saved coach key.
- **TODO (Shane):** set the `SUPABASE_DB_URL` repo secret (issue #198), then note here that
  the row above is no longer "not set".
- **TODO (Shane):** record whether the `.p8` is escrowed in the password manager and under
  what item. It is the one ASC value that cannot be read back out of Apple's console.

Rotation note: `API_KEY_ENCRYPTION_SECRET` is the only secret whose rotation has a user-visible
cost — rotating it invalidates every saved coach key and users must re-enter theirs — so treat
it as escrow-and-keep, not rotate-on-a-schedule.

## 2. App Store Connect API key — who can mint one, and how to replace it

The TestFlight path (`ios/scripts/testflight.sh`, `.github/workflows/testflight.yml`,
`ios/fastlane/Fastfile`) authenticates with one App Store Connect API key. Apple's rules for it:

- **Getting API access at all is the Account Holder's job.** "The Account Holder must request
  access to the API in App Store Connect."
- **Minting a Team Key needs Account Holder or Admin** — App Store Connect → **Users and
  Access** → **Integrations** → **App Store Connect API** → **Team Keys** → **(+)** →
  choose the access role (this repo's key uses **App Manager**) → **Generate**.
- **Individual Keys are a fallback with a smaller blast radius.** Any App Store Connect user
  may generate one for their own use "unless an Admin or Account Holder has revoked this
  ability", and each user has at most one active individual key.
- **The private key downloads exactly once.** "API keys are private and can only be downloaded
  once." There is no second chance and no copy on Apple's side.
- **Revocation is final:** "An API key can't be reinstated once revoked", and Apple says to
  "revoke a key immediately if it becomes lost or compromised".

**Replacing the key** (because it leaked, or because the Mac holding it is gone):

1. Users and Access → Integrations → App Store Connect API → revoke the old key by name.
2. Generate a new Team Key with the App Manager role; download the `.p8` on the spot.
3. Put it at `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8` on the release Mac and write
   the new `APEX_ASC_KEY_ID` into `ios/Config/appstoreconnect.env` (the issuer id does not
   change; it is the team's).
4. Update all three repo secrets — `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`
   (`base64 -i AuthKey_<KEY_ID>.p8 | tr -d '\n'`). The workflow's "Check secrets" step names
   any that are missing before it builds anything.
5. Prove it without publishing a build: `ios/scripts/testflight.sh --check`.

**Bus factor.** Apple allows exactly one Account Holder: "Only one person can be the Account
Holder", and the role is transferred through Apple's
[Account Holder transfer](https://developer.apple.com/support/account-holder-transfer/)
process, not reassigned in the console. An individual enrollment is not stuck at one person —
"Individuals enrolled in the Apple Developer Program can give up to 50 additional users access
to their content in App Store Connect", though those users "aren't part of the Apple Developer
Program team" and get no other membership resources. So a second **Admin** can be added who
could mint a replacement API key and ship a build, while certificates, agreements and renewal
stay with the Account Holder.

- **TODO (Shane):** decide whether a second App Store Connect Admin exists, and who. If yes,
  add them (Users and Access → **(+)**) and record the person here. If no, record the decision
  and its consequence: nobody but Shane can mint a key or release a build, and a locked Apple
  Account (§3) stops both until account recovery completes.

## 3. Apple Account recovery, independent of the release machine

Everything in §2 is gated on signing in to the Apple Account that holds the membership. The
recovery options below are set up **on the account, in advance** — none of them requires the
release Mac, and none can be arranged after the lockout.

- **Trusted phone numbers.** Two-factor authentication sends verification codes to trusted
  devices or a trusted phone number; a second trusted number that is not the phone kept next to
  the Mac is the cheapest protection against a single lost or stolen device.
- **Recovery key.** "A 28-character code that you can use, along with a trusted phone number
  and an Apple device, to help you regain access to your Apple Account"
  (Settings → *your name* → Sign-In & Security → Recovery Key). It cuts both ways, and Apple
  says so: "If you set up a recovery key and can't provide it when you lose access to your
  account, you'll be locked out of your account permanently." A recovery key is worth having
  only if it is escrowed as carefully as the age private key of §1.
- **Recovery contact.** "An account recovery contact is someone you designate who can help you
  regain access to your Apple Account" — they fetch a recovery code for you and you use it to
  reset the password. They need an Apple device on iOS 15 / iPadOS 15 / macOS 12 or later, and
  to be over 13. This is the one recovery route that survives losing every device *and* the
  written-down key.
- **Account recovery, the fallback.** With none of the above, Apple's automated account
  recovery is what remains: "It might be several days or more before you can reset your
  password", and "Contacting Apple Support can't help you shorten this time." Days of not
  being able to ship a fix is the actual risk this section exists to remove.

- **TODO (Shane):** record on this line, without values, (a) how many trusted phone numbers the
  Apple Account has and whether one is off-site, (b) whether a recovery key is turned on and —
  if so — which password-manager item and which physical location hold the 28 characters, and
  (c) the named recovery contact, or an explicit "none, accepted risk". Do (c) first if only one
  gets done: it is two minutes on the phone and it is the only option that needs another person
  to have already agreed.

## 4. Disaster recovery

The restore steps are proven and written down once, in the README — **do not duplicate them
here**: [README → Operations → "Backup setup, restoring a bundle, and disaster
recovery"](../README.md#operations) covers one-time setup, restoring a bundle locally with
[`scripts/db-restore-drill.sh`](../scripts/db-restore-drill.sh), and loading a decrypted dump
into a fresh Supabase project including the `on_auth_user_created` trigger that no schema dump
carries.

Two things that path needs from this file:

1. **An age private key** to decrypt the bundle (§1, first row — today there is none).
2. **`API_KEY_ENCRYPTION_SECRET`, unchanged** (§1). Restore the database into a fresh project
   with a new value and every user's stored Anthropic key and COROS token stays ciphertext
   nobody can read; the app will not error, it will simply behave as though no key was ever
   saved.

Issue #198 owns making that path real end to end — the keys, the `SUPABASE_DB_URL` secret, a
green `backup.yml`, and a by-hand restore into a scratch project.

## 5. Keep it true

Quarterly, or after anything in §1 changes:

- `gh secret list` against §1's table, and `gh variable list` for anything new.
- Download one backup bundle to offline storage — artifacts are 90-day rolling, and GitHub
  disables a scheduled workflow after 60 days without commits (README).
- `ios/scripts/testflight.sh --check` — proves the ASC key still authenticates before a release
  needs it to.
- Re-read the two TODO blocks above; every one of them should eventually become a location.

Apple sources, current as of 2026-09-19:
[App Store Connect API access and keys](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/) ·
[accounts and roles](https://developer.apple.com/help/app-store-connect/manage-your-team/overview-of-accounts-and-roles/) ·
[two-factor authentication](https://support.apple.com/en-us/102660) ·
[recovery key](https://support.apple.com/en-us/109345) ·
[recovery contact](https://support.apple.com/en-us/102641) ·
[account recovery](https://support.apple.com/en-us/118574).
