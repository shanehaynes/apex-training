# Tech stack

What Apex is built on, why, and what would make us revisit each choice. Loaded
into every session beside the constitution. Changing a row here (a new layer, a
new runtime dependency, a ruled-out choice coming back) is proposed in a PR of
its own with the reason; dependency manifests are already held for Shane.

## Principles

- **Code computes, the model narrates** (Constitution VI). Every number comes
  from pure TypeScript in `src/lib/`. The web imports that module; iOS gets the
  same results from the API. Every client shows the same number.
- **One backend, thin clients.** Web and iOS read through RLS and write through
  the same API handlers; no client writes a table directly. A new client
  reimplements nothing.
- **Cost follows users.** Apex earns nothing yet, so it runs on free tiers. Each
  constraint below names the point at which it ends.

## Layers

| Layer | Choice | Why | Constraint and exit |
|---|---|---|---|
| Web | React 19, TypeScript strict, Vite, Tailwind, Recharts | A signed-in SPA; no SEO or server rendering need | — |
| Client state | React context for distribution only; logic lives in `src/lib/` | Domain logic stays testable without React | No store library |
| API | Vercel functions on Node 24; one catch-all into a Hono router | Hobby plan caps a deployment at 12 functions | Four root functions, enforced by `ci:guards`; new handlers go in `api/_lib/handlers/`. **Exit:** Vercel Pro at 30+ active iOS users, or when Apex charges (Hobby terms exclude commercial use), whichever comes first |
| Data | Supabase Postgres, RLS on every table, `supabase-js` typed by generated types | Clients read PostgREST directly, so RLS is the authorization layer | No ORM. Migrations are append-only `phaseN` files, applied to production by hand |
| AI | Claude via `@anthropic-ai/sdk`; the athlete's own key and model; NDJSON streaming | Apex pays no inference while it earns nothing | Every coach change passes the eval gate. **Exit:** bring-your-own-key is a bootstrap phase; a managed tier replaces it when Apex charges |
| iOS | SwiftUI, iOS 17+, GRDB read cache and write queue, XcodeGen | `docs/ios/decisions.md` D-000, D-001, D-003, D-004, D-005, D-007 | Android is deferred and planned, not ruled out |
| Supporting libraries | `date-fns`, `framer-motion`, `react-grid-layout`, `lucide-react`, `@garmin/fitsdk` (COROS FIT decode) | The baseline a new runtime dependency is judged against | — |
| Email | Resend SMTP via `nodemailer` | Invite and review mail on the `apex-training.app` domain | — |
| Tests | Vitest, Playwright (mock and live), XCTest with snapshots, coach evals | `npm run agent:check` is the gate, same as CI | — |

## Integrations

Constitution IV promises the athlete's kit. This is how Apex gets there.

1. **Aggregator first.** Most wearables (Garmin, Whoop, Oura, Wahoo and others)
   already write to Apple Health, so HealthKit on iOS reaches all of them
   through one integration: the HealthKit reader in the iOS app and its server
   mapper in `api/_lib/providers/apple/`. Health Connect plays
   the same role when Android lands.
2. **Direct integration only where the aggregator loses something an athlete
   needs:** full-resolution streams (heart rate, power, GPS), structured
   workouts pushed to the device, or a sport the aggregator flattens. COROS
   (`api/_lib/providers/coros/`) is the precedent.
3. **Every provider is an adapter** under `api/_lib/providers/<name>/` that maps
   into Apex's own model. Nothing above that layer knows which device the data
   came from, and two sources describing one activity resolve to one record.
   Today only Apple Health imports are checked against other sources; COROS
   imports are not yet.
4. **Order by reach.** The next integration is the one that serves the most
   athletes the aggregator does not already serve.

## Not without a PR here first

- React Native, Expo or a web wrapper for iOS (D-000); a separate iOS
  repository (D-001).
- A file per API endpoint, or a fifth root function, before the Vercel exit.
- An ORM, a client state library, or a second database.
- A model producing a number the athlete will rely on.
- A per-brand integration for data Apple Health already carries at the fidelity
  athletes need.
