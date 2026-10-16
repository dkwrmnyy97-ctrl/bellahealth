# BellaHealth

**Your health doesn't happen in pieces.**

BellaHealth is a personal health app for iPhone. It brings wearable data, Apple Health, nutrition, and the context of daily life (travel, illness, training, cycle, caffeine, alcohol) into one place. It then helps you understand that information as a continuous whole instead of five separate apps.

Status: **private beta on TestFlight** · Site: [bellahealthapp.com](https://bellahealthapp.com)

> Screenshots are not included in this repository because the only ones I have show real personal health data.

## The problem

Health information is fragmented by design:

- Your ring knows your sleep.
- A nutrition app knows your lunch.
- A lab portal has your bloodwork.

None of them talk to each other. So "why did I feel terrible last Thursday?" has no answer unless you piece it together yourself, and most people don't.

**Who it's for:** individuals, especially women tracking cycle-related context, who already collect health data and want it to mean something. It is not built for clinicians and it does not give diagnoses.

## What's implemented

**Data sources**

- **Apple Health (HealthKit):**
  - What it reads: steps, active energy, sleep, HRV, resting heart rate, water, weight, height, and workouts.
  - A pre-permission screen explains each data type before the iOS prompt appears.
- **Oura:** OAuth sign-in, then daily and 7/30-day sleep, readiness, HRV, and activity data, with automatic token refresh.
- **WHOOP:** *partial.* Data fetch and token refresh exist, but there is no sign-in screen yet.

**Logging and context**

- **Meal logging by photo or text.** Claude estimates the macros. Writes go through a server-side Edge Function.
- **Daily logs:** hydration, caffeine, alcohol, cycle, training goals, travel and vacation, wellness, and a grounding/breathing screen.
- **Context events** (illness, travel, training blocks) layered over the measured data.

**Understanding the data**

- **Trends:** 7-day and 30-day views.
  - The app treats "missing" and "zero" differently, so an unlogged day doesn't distort a trend.
- **Context and "Your Story":** rule-based pattern detection and story generation that does not use an LLM:
  - `pattern-engine`
  - `dow-pattern-engine` (day-of-week patterns)
  - `story-engine`
  - `timeline-builder`

  Examples: "on more active days, sleep the following night tends to be lower", or how sleep quality changed since an illness began.
- **AI health chat** grounded in today's health data, supplements, uploaded documents, cycle context, and (when opened from the Context screen) your detected patterns. It runs through a server-side Claude proxy.
- **Health document upload** (labs and PDFs) with AI extraction.

**App and account**

- **iOS home-screen widget** (WidgetKit extension; data passed through a shared App Group).
- **Onboarding, local notifications, and companion-app quick links.**
- **Account:**
  - anonymous-first sessions
  - optional Sign in with Apple
  - cloud sync of profile, goals, context events, and drink log (free-text notes are never uploaded)
  - in-app account deletion
- **Privacy-conscious product analytics** (see below).

**Not built yet:**

- A BellaHealth+ subscription exists only as a stub (`SUBSCRIPTION_READY = false`).
- Episode-to-episode comparison in the story engine is deferred (`docs/story-engine-roadmap.md`).

## Product decisions

- **Missing data is not zero.** Conflating "not logged" with "0" produces meaningless trends.
- **Goals persist through measurement gaps.** If the ring doesn't sync, your baselines and goals don't disappear.
- **Visual hierarchy that reflects reality.** The app distinguishes primary metrics from supporting ones rather than giving everything equal weight.
- **AI grounded in *your* context, not generic advice.** The chat draws on your measured data, documents, and logged context.
- **Pattern detection is deterministic.** Insights like "Your Story" come from explicit, testable rules rather than an LLM. They are more predictable and easier to explain.
- **Analytics without surveillance:**
  - Product analytics answer real product questions, such as retention cohorts, activation, and whether Trends shows data or an empty state.
  - No health values, meal contents, document contents, or chat text are ever captured.

## Identity and access controls

This is the part of the project closest to my day job in IAM.

- **Oura OAuth 2.0 with PKCE (S256).**
  - The authorization code exchange and token refresh go through a Supabase Edge Function (`oura-token-exchange`), so the Oura **client secret never ships in the app**. A unit test checks that no client secret is sent from the client.
  - The refresh token is stored in the iOS Keychain (`expo-secure-store`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`).
- **Supabase Auth.**
  - Every install gets an anonymous session.
  - Sign in with Apple links to that session via `signInWithIdToken`.
  - The Apple refresh token is kept in a `private` schema table. Only service-role database functions can reach it, and it is used to revoke the token when the account is deleted.
- **Row Level Security.** User tables (profiles, training goals, context events, drink log) have owner-only RLS policies (`auth.uid() = user_id`).
- **Edge Functions verify the caller.**
  - These functions validate the user's JWT before doing anything: `claude-proxy`, `log-meal`, `exchange-apple-code`, and `delete-account`.
  - The Anthropic key lives only on the server.
  - `claude-proxy` only allows specific models.
  - For meal writes, `log-meal` takes the user ID from the verified JWT, never from the client.
- **Analytics pipeline:**
  - Events go through an `ingest-event` Edge Function that accepts only allowlisted event and screen names.
  - Direct writes to the analytics table are blocked: RLS is enabled with no policies.
  - The summary function is restricted to the service role, and the dashboard endpoint requires a shared secret.
  - If analytics fails, the product keeps working.
- **Account deletion** removes user data and revokes the Apple token.

**Known gaps** I'm tracking:

- The Oura access token (not the refresh token) is kept in AsyncStorage, which is not encrypted.
- WHOOP tokens are kept in AsyncStorage too.
- `ingest-event` and `oura-token-exchange` don't require a user JWT.
- Edge Function CORS is `*`.
- The original `nutrition_log` table and its RLS policy were created outside the migrations in this repo. Only later changes to the table are included here.

## Architecture

```
React Native / Expo (iOS, bare workflow + WidgetKit extension)
   │  HealthKit (on-device)      Oura API (OAuth + PKCE)
   ▼
Supabase ── Auth (anonymous + Sign in with Apple)
         ── Postgres + RLS (migrations in supabase/migrations)
         ── Edge Functions (Deno): claude-proxy · log-meal · oura-token-exchange ·
            exchange-apple-code · delete-account · ingest-event · analytics-summary
                │
                └─► Claude API (chat, meal estimation, document extraction)
EAS Build ─► App Store Connect ─► TestFlight
```

| Path | What's there |
|---|---|
| `src/app/` | Expo Router screens: Home, Trends, Context |
| `src/components/` | Modals and UI: logging, chat, documents, onboarding, etc. |
| `src/services/` | HealthKit, Oura, WHOOP, Supabase, auth, analytics, pattern/story engines |
| `supabase/migrations/` | Schema, RLS, analytics |
| `supabase/functions/` | Edge Functions |
| `ios/` | Native project, widget extension, widget bridge |
| `plugins/` | Config plugins for HealthKit entitlements and the privacy manifest |

## Tech stack

Versions are taken from `package.json`:

- Expo SDK 56 (`expo ~56.0.0`), React Native 0.85.3, React 19.2, expo-router ~56.2 (typed routes, React Compiler), TypeScript ~6.0
- `@kingstinct/react-native-healthkit` ^14
- `@supabase/supabase-js` ^2.116
- `expo-secure-store`, `expo-auth-session`, `expo-crypto`, `expo-apple-authentication`, `expo-notifications`, `expo-image-picker`, `expo-document-picker`
- Supabase (Postgres, Auth, Edge Functions on Deno)
- Claude models via the proxy: `claude-sonnet-4-6` and `claude-haiku-4-5`
- Jest (`jest-expo`): 50 suites, 1,400 tests

## Running it

HealthKit needs a **development build** on a real iPhone; Expo Go won't work. You will also need your own Supabase project and an Oura developer app.

```bash
npm install
cp .env.example .env          # fill in your own Supabase + Oura values
npm test                      # unit tests, no device needed
npx expo run:ios --device     # or an EAS development build
```

Backend:

1. Run `supabase link`.
2. Apply `supabase/migrations`.
3. Deploy `supabase/functions`.
4. Set the function secrets listed in `.env.example` with `supabase secrets set`.

The bundle identifier and App Group in `app.json` / `ios/` are mine. Change them to your own before you build.

## How I built it

BellaHealth is my product: I defined it, designed how it behaves, and decided what shipped. I used **Claude Code** as my primary implementation tool. My background is identity and access management rather than software engineering. I made the product, privacy, and access-control decisions:

- what data to bring in
- how missing data should behave
- what analytics may and may not capture
- where secrets live and which calls must be server-side

Claude Code wrote most of the code from my direction. I reviewed it, tested it on my own device daily, and iterated. At runtime, the app calls the Claude API (through `claude-proxy`) for chat, meal estimation, and document extraction. The pattern and story engines don't use an LLM. The `.claude/settings.json` and `AGENTS.md` files are the project context files from that workflow.

## What's not in this repo

This is a cleaned public copy of the working project. It starts with fresh git history.

**Excluded:**

- environment files and OAuth client secrets
- Supabase CLI link state (`supabase/.temp`)
- build output and local Netlify state
- the internal analytics dashboard (`founder-dashboard/`)
- internal planning and App Store submission documents
- all screenshots

**Replaced with placeholders:**

- the Supabase project URL and publishable key (now read from env)
- the Oura client ID
- the EAS project ID
- the App Store Connect app ID

**Removed:** the Expo template's `LICENSE` file, which carried Expo's copyright rather than mine.

## License

No license has been chosen yet, so all rights are reserved by default. Please ask before reusing the code.
