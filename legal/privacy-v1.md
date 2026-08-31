---
title: Privacy Policy
version: privacy-v1
effective: 2026-08-29
---

# Apex Training — Privacy Policy

**Version privacy-v1 · Effective 2026-08-29**

This policy describes what Apex Training actually does with your data. It was
written by reading the source code, not from a template, and it is meant to be
checkable against it. Where Apex does something you might not expect, this
document says so rather than glossing it.

[LEGAL_ENTITY] operates Apex. Contact: [CONTACT_EMAIL].

---

## 1. The short version

- Apex stores your training schedule, your workout logs, your meals, and — if
  you connect a watch — **your heart-rate and GPS data**.
- Using the AI coach sends your training context to **Anthropic**, on an API key
  you supply and pay for yourself.
- Our infrastructure providers are **Vercel** and **Supabase**. Periodic review
  emails are sent through **Google (Gmail SMTP)**.
- **There are no analytics, no trackers, no advertising, and no third-party
  scripts of any kind.** We do not sell or share your data, and we do not use it
  to train models.
- You can export everything and delete your account permanently, from your
  profile, at any time.

---

## 2. What we collect

### 2.1 What you enter

| Data | Where it is stored |
| --- | --- |
| Email address and password | Supabase Auth (`auth.users`); the password is hashed by Supabase and we never see it |
| Display name, avatar choice | `profiles` |
| **Training goal and free-text "context"** for the AI coach | `profiles.coach_goal`, `profiles.coach_context` |
| Workout titles, descriptions, difficulty, tags, equipment, and **location** | `workout_events` |
| Per-set weight, reps, and duration | `workout_set_logs` |
| Cardio duration, distance, elevation, and **average heart rate** | `workout_cardio_logs` |
| Meals: title, time, calories, protein, carbohydrate, fibre, sugar, fat, and free-text notes | `meals`, `meal_favorites` |
| Training blocks, objectives, and notes | `training_blocks`, `objectives` |
| Your Anthropic API key | `user_api_keys`, encrypted (AES-256-GCM) before storage |

**The "context" field is free text and some people record injuries, conditions,
or medications in it.** Anything you type there is stored as written and is sent
to Anthropic with every coach message. It is optional and you can clear it at any
time.

### 2.2 What we compute from it

Estimated one-rep maxes (Epley formula), tonnage, personal records, completion
rates, streaks, training-block attainment, and daily macronutrient totals. These
are derived arithmetically from your own entries — no profiling, no scoring, and
no inference about you as a person.

### 2.3 What AI generates about you, and what we keep

| Output | Stored? |
| --- | --- |
| Post-workout coach summary | **Yes** — `workout_sessions.coach_summary` |
| Monthly and yearly review commentary | **Yes** — `reviews.ai_commentary`, alongside the statistics that produced it |
| Coach chat conversations | **No** — chat messages are not stored on our servers and are gone when you close the sidebar |

### 2.4 What your watch sends, if you connect one

Connecting a COROS account is entirely optional and off by default. If you
connect one, imported activities bring:

- **Health and physiological measurements** — average and maximum heart rate,
  heart-rate zones, heart-rate variability, calories, training load, and VO2 max
  estimates.
- **Precise location history** — the GPS track of each activity, stored as a
  time series of latitude, longitude, and elevation points (downsampled to
  roughly 2,000 points per activity).

Both live in the `activity_streams` table.

**We treat this as the most sensitive data Apex holds.** In many jurisdictions
health data and precise geolocation carry heightened legal protection. If you
would rather Apex did not hold it, do not connect a watch — every other feature
works without it.

### 2.5 Technical data

Server logs at Vercel record request metadata, including IP addresses, in the
ordinary course of operating the site. We record per-user request counts for
rate limiting (`api_request_counts`), which prune themselves automatically. When
you accept these documents we record your IP address and browser user-agent
string as evidence of acceptance (see section 7).

We do not use cookies for tracking. Your login session is held in browser
storage by Supabase's authentication library so that you stay signed in.

---

## 3. Why we process it

To operate the Service you asked for: to show your calendar, log your training,
compute your statistics, generate coaching and reviews at your request, sync
your watch if you connected it, serve your calendar feed and API requests,
secure the Service and enforce rate limits, and keep a record that you accepted
these terms.

We do not process your data for advertising, for analytics, for profiling, or to
train machine-learning models.

<!-- LEGAL REVIEW: This section deliberately avoids naming GDPR legal bases (consent, contract, legitimate interests) because we have not established whether Apex has EU or UK users. If it does, this section needs restating in Article 6 terms, and the watch data in 2.4 is Article 9 special-category data requiring an Article 9(2) condition — most likely explicit consent, which our single combined acceptance checkbox probably does not satisfy. Please advise on both, and on whether an Article 27 representative is required. -->

---

## 4. Who receives your data

We do not sell your personal information, share it for cross-context behavioural
advertising, or disclose it for anyone else's independent purposes. The
following providers receive it because they run parts of Apex.

### 4.1 Anthropic — the AI coach

When you use the coach, the post-workout summary, or a periodic review, we send
Anthropic a prompt containing, depending on the feature:

- your workout schedule, including event titles and times;
- your four-week completion rate;
- the meals you logged that day, with macronutrients;
- your exercise library names and active training block;
- **your `coach_goal` and `coach_context` text, verbatim**;
- for post-workout summaries, your logged sets with weights, reps, durations,
  and heart rate, and your personal records;
- for periodic reviews, your aggregate statistics for the period.

**These calls are made with the Anthropic API key you saved in your profile and
are billed to your Anthropic account.** Your relationship with Anthropic is
governed by their terms and privacy policy. If you remove your key, no further
data is sent to them.

### 4.2 Infrastructure

| Provider | What they receive |
| --- | --- |
| **Vercel** | Hosting and serverless execution — all application traffic passes through them. Server logs contain request metadata and IP addresses, and application error messages. Prompt contents are not logged; token counts are. |
| **Supabase** | Database, authentication, and file storage — everything in section 2 is stored on their infrastructure. They also send account emails such as invitations and password resets. |
| **Google (Gmail SMTP)** | Periodic review emails are delivered through a Gmail account belonging to the operator. Google therefore processes your email address and the full contents of those emails, including your statistics and AI commentary. |
| **COROS** | Only if you connect a watch. We exchange OAuth tokens with them and they return your activity, heart-rate, and GPS data. |

<!-- LEGAL REVIEW: Review emails are sent through the operator's personal consumer Gmail account using an app password (api/_lib/mailer.ts), not a Google Workspace account under a business agreement. Google's consumer terms, not a data-processing agreement, therefore govern that transfer of users' health-adjacent data. Please advise whether this is acceptable, and whether the same question applies to Vercel and Supabase — no DPA has been executed with any of the four providers named in this section. -->

### 4.3 Third-party AI clients you authorise

If you mint an access token or approve an OAuth connection, the client holding
it can read, through `/api/mcp`: your schedule, individual workout details
including every logged set, your exercise history and personal records, your
period statistics, your training blocks, your exercise library, and your logged
meals. That endpoint is read-only — a token cannot change or delete anything,
and it cannot reach another user's data.

**Things worth knowing about these tokens:**

- **They do not expire.** A token stays valid until you revoke it in your
  profile.
- **There is no notification when a token is used**, and no per-tool scoping —
  a token grants all of the above or nothing.
- Once a client has read your data, **what it does with the copy is outside our
  control.** Our Terms restrict such clients, but we cannot enforce that
  technically. Only grant tokens to clients you trust, and revoke ones you no
  longer use.

### 4.4 Your calendar feed

Your profile contains a private calendar-feed URL that serves your schedule as
an `.ics` file to any calendar app. It is authorised by a secret token in the
URL itself, so **anyone who obtains that URL can read your workout titles,
dates, times, and locations** without signing in.

**This token cannot currently be rotated.** If your feed URL leaks, there is no
way to invalidate it short of deleting your account. The feed also keeps
serving if we publish new terms and you have not yet accepted them — a
calendar app has no way to show you a document, and silently breaking your
calendar seemed the worse failure. We are telling you this
because it is a real limitation, not a theoretical one. Note also that
subscribing in Google Calendar or iCloud means those companies fetch the feed on
your behalf and hold a copy of its contents.

<!-- LEGAL REVIEW: The inability to rotate the ICS token means a user whose feed URL leaks has no remedy short of account deletion. Please advise whether disclosure alone is sufficient, or whether this is a security defect that must be fixed before accepting users who are not personal acquaintances. -->

### 4.5 Legal disclosure

We may disclose data if we are legally required to, or where we believe in good
faith that disclosure is necessary to protect someone's safety or to
investigate fraud or a security incident.

---

## 5. How long we keep it, and what deletion actually does

**We keep your data until you delete it.** There is no automatic expiry and no
retention schedule — an event you logged four years ago is still there.

Two things behave differently from what you might assume:

- **Deleting a workout** removes its sets, cardio logs, completion state, and
  any imported watch data for it. It deliberately does **not** remove the
  append-only history tables that record *that the change happened*
  (`event_mutations_log`, `workout_completion_log`), nor the import ledger that
  stops a deleted watch activity from being re-imported.
- **Deleting your account** removes everything, including those history tables
  and your acceptance records. Almost every table is configured to delete its
  rows automatically when your authentication record goes; one older
  diagnostic table is not, so it is emptied explicitly first. Both happen in
  the same request.

**Account deletion is immediate and permanent. We cannot undo it.** Export your
data first if you want a copy.

Provider backups are the exception we cannot control: Supabase and Vercel retain
their own backups on their own schedules, so deleted data may persist there
briefly until those rotate.

<!-- LEGAL REVIEW: Account deletion also destroys the terms-acceptance audit log for that user, because the record is tied to their authentication row by a cascading foreign key. This is a direct conflict: the acceptance record exists to prove the user agreed, and the deletion promise destroys the proof at exactly the moment a dispute becomes likely. The alternatives are (a) accept the loss, as currently built, (b) retain a de-identified acceptance record after deletion under a legitimate-interest basis, or (c) retain the record in full for a limited period. Please advise which is defensible. -->

---

## 6. Your choices and rights

From your profile you can, at any time:

- **Export everything** — a JSON file of every record we hold for you, across
  every table. Two things are deliberately left out, and the file says so
  where they would have been: your stored Anthropic API key, and the OAuth
  tokens for a connected watch. Both are credential material; handing you a
  copy in a downloads folder would create a risk without giving you anything
  you could use. Your access tokens are stored only as hashes and cannot be
  recovered at all, though their names and usage dates are included.
- **Delete your account** — permanently, as described above.
- **Correct or delete individual records** — every workout, log, meal, and note
  is editable and deletable in the app.
- **Remove your Anthropic API key**, which stops any further data reaching
  Anthropic.
- **Revoke access tokens and OAuth connections.**
- **Clear your `coach_context` field**, which stops that text being sent with
  future prompts.
- **Disconnect your watch.**

These are actual buttons in the application, not a request process. For anything
else, contact [CONTACT_EMAIL].

**What we do not currently offer:** an automated way to object to or restrict
specific processing while continuing to use the Service, a data-portability
format other than the JSON export, or a formal complaints process. If you need
one of these, write to us and we will handle it by hand.

<!-- LEGAL REVIEW: This section describes capabilities rather than asserting statutory rights under GDPR, UK GDPR, CCPA/CPRA, or any state privacy law, because we have not determined which apply. If CCPA applies, we likely need explicit notice of the rights to know, delete, correct, and to limit the use of sensitive personal information — the watch data in 2.4 is sensitive personal information under CPRA on both the health and the precise-geolocation grounds. Please advise on applicability and required notice language, including whether state health-privacy statutes such as Washington's My Health My Data Act reach a non-HIPAA operator holding this category of data. -->

---

## 7. Records of your acceptance

When you accept these documents we write a permanent record: your user id, the
version of each document you accepted, the time, your IP address, and your
browser's user-agent string. These records are append-only — a new acceptance is
added, and earlier ones are never modified or overwritten.

We keep them as evidence that the agreement was formed. They are deleted if you
delete your account.

---

## 8. Security, honestly stated

Passwords are hashed by Supabase and never reach us. Your Anthropic API key and
your watch's OAuth tokens are encrypted before storage. Access tokens are stored
only as SHA-256 hashes, so we cannot recover one. Every database query is scoped
to the requesting user's own identity, and row-level security is enabled
throughout. The site is served over HTTPS with strict transport security.

**What we do not claim:** Apex is a personal project maintained by one person.
There is no security team, no penetration testing, no SOC 2 or ISO
certification, no bug bounty, and no formal incident-response plan. We are not a
HIPAA-covered entity and Apex is not HIPAA-compliant. No system is perfectly
secure, and we cannot guarantee yours will not be breached.

If you find a vulnerability, please tell us at [CONTACT_EMAIL].

<!-- LEGAL REVIEW: We make no breach-notification commitment here because none exists operationally — there is no incident-response plan and no defined notification path. Most US states impose statutory notification duties regardless of what a policy says. Please advise on the minimum viable commitment we can honestly make and are obliged to make. -->

---

## 9. Children

Apex is not intended for anyone under 18 and we do not knowingly collect data
from children. If you believe a child has an account, contact us and we will
delete it. Note that the application has no age verification of any kind.

---

## 10. International users

Apex is operated from the United States and its providers store data in the
United States. If you use Apex from elsewhere, your data is transferred to and
processed in the United States, which may not offer the same protections as your
home country. We have not implemented standard contractual clauses or any other
formal transfer mechanism.

<!-- LEGAL REVIEW: This states plainly that no transfer mechanism exists. If there are EU or UK users, that is a compliance gap rather than a disclosure. Please advise whether to implement transfer machinery, or to restrict the Service to US users and enforce that at the invitation stage. -->

---

## 11. Changes to this policy

This policy carries a version identifier — **privacy-v1**. When we make a
substantive change we publish the new version, bump the identifier, and prompt
you to accept it the next time you use Apex, recording that acceptance as
described in section 7. Minor corrections may be made without a version bump.

Questions: [CONTACT_EMAIL].
