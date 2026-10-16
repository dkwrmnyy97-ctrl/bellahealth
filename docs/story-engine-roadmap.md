# Story Engine — Next Milestone

## Episode-Based Longitudinal Comparison

**Status:** Deferred — not in current App Store build.
**Decided:** September 2026 (App Store stabilization session)

---

### Context

The current Story engine is deterministic and operates on a single event window at a time.
It can detect:
- A transition between two adjacent events (e.g. travel → illness)
- A behavioral pattern corroborated by two independent data paths (`strong_contextual_pattern`)
- Conflicting physiological signals (HRV up, readiness down) with substantial magnitude

It cannot detect:
- How the same type of event (travel, training block) affected the user differently across two or more occurrences
- Whether recovery was faster or slower than a previous episode, and what differed
- A repeated relationship that only becomes visible when multiple episodes are compared

The DEMO_EXPLORE_STORY demonstrates the intended future quality:
> "Your largest readiness drops recovered faster than some smaller ones.
>  The first night that crossed roughly seven and a half hours of sleep was
>  what tracked with how quickly things normalized — not how far readiness fell."

This insight required tracing six readiness dips across a 30-day window, comparing each
dip's recovery arc against subsequent sleep lengths, and finding that *dip depth did not
predict recovery duration — first full-sleep night did.* The current engine cannot produce
this. It was handcrafted and bypasses the engine in explore/demo mode.

---

### What This Milestone Requires

**1. Identify repeated instances of the same context type**
- Group all event windows of the same `event.type` (e.g. all `travel` windows)
- Require ≥ 2 qualifying instances (pre-window + during-window + post-window, all with
  sufficient data) before any cross-episode analysis is attempted

**2. Compute per-episode metric windows**
For each episode instance, calculate:
- `preBaseline`: average of key signals (readiness, HRV, sleepHours) in the pre-window
- `duringMean`: average of the same signals during the event
- `peakDrop`: magnitude of the largest single-day departure from the user's personal median
- `postRecovery`: how many days until the user's readiness returned to ≥ personal median
  (or: first day readiness was within 5% of median after the event ended)

**3. Compare recovery speed across episodes**
- For each completed episode, compute `daysToNormalize` (days from event end until
  readiness first returns to within 5% of personal median)
- Identify which episode recovered fastest and which slowest
- Test candidate "distinguishing factors" between faster and slower recoveries:
  - Was sleep on night-1 post-event above a threshold (e.g. personal sleep median)?
  - Was activity lighter in the first 2 days post-event?
  - Was alcohol absent in the 3 days post-event?
  - Was the preceding event shorter or longer?

**4. Surface only when the distinguishing factor is consistent**
- A distinguishing factor qualifies only if it is present in all faster-recovery episodes
  and absent (or reversed) in all slower-recovery episodes
- Require ≥ 2 episodes on each side (faster / slower) before drawing a conclusion
- Never surface a conclusion from a 1-vs-1 comparison

**5. Apply the Insight Value Gate**
Before surfacing a cross-episode conclusion, confirm:
- The conclusion cannot be inferred from a single event window or a single trend chart
- The distinguishing factor is specific to this user (not generic health advice)
- The finding can be stated in one sentence that changes how the user understands themselves

**6. Render with specificity**
The rendered Story must include:
- How many episodes were compared ("across your last 3 trips")
- The specific distinguishing factor ("the nights when sleep crossed X hours")
- The recovery difference ("recovered in 1-2 nights" vs. "took 4-5 nights")
- The direction of surprise if applicable ("how far readiness fell didn't predict it — the next night did")

---

### Suggested Interface (not final)

```typescript
interface EpisodeGroup {
  eventType: string;
  episodes: Array<{
    startDate:        string;
    endDate:          string;
    peakDrop:         number;      // largest single-day departure from personal median
    daysToNormalize:  number;      // days post-event until readiness ≥ 95% of personal median
    nextNightSleep:   number | null; // sleepHours on first night after event ended
    postActivityMean: number | null; // avg workoutDurationMin in days 1-2 post-event
    hadAlcohol:       boolean;     // any alcohol in days 0-2 post-event
  }>;
}

interface CrossEpisodeInsight {
  eventType:          string;
  episodeCount:       number;
  fasterEpisodes:     number;
  slowerEpisodes:     number;
  distinguishingFactor: 'sleep_next_night' | 'activity_level' | 'alcohol_absent' | 'event_duration';
  fasterCondition:    string;   // e.g. "sleep ≥ 7.5h on first night after"
  slowerCondition:    string;   // e.g. "sleep < 7.5h for 2+ nights after"
  recoveryDifference: string;   // e.g. "1-2 nights vs. 4-5 nights"
  confidence:         'preliminary' | 'consistent';   // preliminary = 2 episodes each side, consistent = 3+
}
```

---

### Story-Worthiness Requirements for This Milestone

A cross-episode insight passes the Story-worthiness gate when:

| Criterion | Requirement |
|---|---|
| Episode count | ≥ 2 completed qualifying episodes of the same type |
| Faster group | ≥ 2 episodes that recovered in < median(daysToNormalize) |
| Slower group | ≥ 2 episodes that recovered in > median(daysToNormalize) |
| Distinguishing factor | Present in 100% of faster episodes, absent/reversed in 100% of slower |
| Specificity | The factor must be specific to this user's data, not a generic rule |

If these conditions are not met, no cross-episode Story is generated.

---

### What Does NOT Change

- `detectPatterns()` — detection layer is not modified
- `HealthDayRecord` — no new fields required (all needed data already present)
- Single-episode logic — existing `buildStoryEpisode()` behavior is unchanged
- The two Story-worthiness gates (Evidence Gate + Insight Value Gate) still apply

This milestone adds a new parallel path that runs alongside the existing engine and
only produces output when it passes both gates independently.

---

### Why This Was Deferred

The current build requires App Store review stability. This milestone requires:
- Significant new test coverage (cross-episode comparison logic)
- Edge case handling (partial post-windows, overlapping events, same-day recovery)
- At least 60+ days of real user data to validate in practice

These risks are inappropriate for a submission-cycle build.
