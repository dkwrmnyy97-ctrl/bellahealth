/**
 * BellaHealthWidget.swift
 *
 * iOS Home Screen widget for BellaHealth.
 *
 * Reads a snapshot written by BellaHealthWidgetBridge.swift (via the app)
 * from shared App Group UserDefaults. No independent HealthKit or Oura
 * queries — the app is the single source of truth.
 *
 * Sizes:
 *   systemSmall  — Steps + Water (glanceable)
 *   systemMedium — Steps + Water (two columns, more spacious)
 *
 * Data model:
 *   null fields  = not available (shown as "—", never as "0")
 *   zero fields  = genuinely measured zero
 *
 * Deep link:
 *   Tapping any part of the widget opens BellaHealth via the
 *   bellahealth:// URL scheme.
 */

import WidgetKit
import SwiftUI

// ─── Snapshot model ────────────────────────────────────────────────────────────

struct WidgetSnapshot: Codable {
    var steps:        Int?
    var stepGoal:     Int?
    var waterOz:      Double?
    var waterGoalOz:  Double?
    var sleepHours:   Double?   // e.g. 7.7 means 7h 42m
    var sleepDate:    String?   // YYYY-MM-DD of associated sleep night
    var accentHex:    String?   // current palette accent from the app
    var date:         String?   // YYYY-MM-DD this snapshot is for
    var lastUpdatedAt: String?  // ISO 8601
}

// ─── Timeline entry ────────────────────────────────────────────────────────────

struct BellaEntry: TimelineEntry {
    let date:     Date
    let snapshot: WidgetSnapshot
}

// ─── Shared UserDefaults reader ────────────────────────────────────────────────

private let appGroup   = "group.com.isabellafugaro.BellaHealth"
private let snapshotKey = "bellahealth_widget_snapshot"

func loadSnapshot() -> WidgetSnapshot {
    guard
        let defaults = UserDefaults(suiteName: appGroup),
        let raw      = defaults.string(forKey: snapshotKey),
        let data     = raw.data(using: .utf8),
        let snap     = try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    else {
        return WidgetSnapshot()
    }
    return snap
}

// ─── Timeline provider ────────────────────────────────────────────────────────

struct BellaProvider: TimelineProvider {

    func placeholder(in context: Context) -> BellaEntry {
        BellaEntry(date: Date(), snapshot: WidgetSnapshot(
            steps: 7842, stepGoal: 10000,
            waterOz: 48, waterGoalOz: 64,
            sleepHours: 7.5, sleepDate: nil
        ))
    }

    func getSnapshot(in context: Context, completion: @escaping (BellaEntry) -> Void) {
        completion(BellaEntry(date: Date(), snapshot: loadSnapshot()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BellaEntry>) -> Void) {
        let snap    = loadSnapshot()
        let entry   = BellaEntry(date: Date(), snapshot: snap)
        // Refresh every hour; the app also calls reloadAllTimelines() on data changes.
        let refresh = Calendar.current.date(byAdding: .hour, value: 1, to: Date()) ?? Date()
        completion(Timeline(entries: [entry], policy: .after(refresh)))
    }
}

// ─── Design helpers ────────────────────────────────────────────────────────────

/// Parse a CSS hex color string (e.g. "#C17B8E") into a SwiftUI Color.
/// Falls back to the accent color if parsing fails.
extension Color {
    init(hex: String) {
        var h = hex.trimmingCharacters(in: .alphanumerics.inverted)
        if h.count == 3 { h = h.flatMap { "\($0)\($0)" }.joined() }
        var rgb: UInt64 = 0
        Scanner(string: h).scanHexInt64(&rgb)
        self.init(
            .sRGB,
            red:   Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >>  8) & 0xFF) / 255,
            blue:  Double( rgb        & 0xFF) / 255
        )
    }
}

/// Format sleep hours (decimal) as "7h 42m".
private func formatSleep(_ hours: Double) -> String {
    let h = Int(hours)
    let m = Int(((hours - Double(h)) * 60).rounded())
    if h == 0 { return "\(m)m" }
    if m == 0 { return "\(h)h" }
    return "\(h)h \(m)m"
}

/// Localised step count, e.g. "8,421".
private func formatSteps(_ n: Int) -> String {
    let fmt = NumberFormatter()
    fmt.numberStyle = .decimal
    return fmt.string(from: NSNumber(value: n)) ?? "\(n)"
}

/// Whether the snapshot's date matches today (data is current).
private func snapshotIsToday(_ snap: WidgetSnapshot) -> Bool {
    guard let d = snap.date else { return false }
    let today = {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.string(from: Date())
    }()
    return d == today
}

// ─── Metric row ────────────────────────────────────────────────────────────────
// Used in the medium widget for each column.

private struct MetricColumn: View {
    let icon:    String   // SF Symbol name
    let label:   String
    let value:   String?  // nil → "—"
    let context: String?  // e.g. "/ 10,000" or "7h 42m · last night"
    let accent:  Color

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .light))
                    .foregroundStyle(accent)
                Text(label)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                    .kerning(0.6)
            }
            Text(value ?? "—")
                .font(.system(size: 22, weight: .semibold, design: .rounded))
                .foregroundStyle(value != nil ? Color.primary : Color.secondary)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            if let ctx = context {
                Text(ctx)
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// ─── Small widget (systemSmall) ────────────────────────────────────────────────

private struct SmallWidgetView: View {
    let snap:   WidgetSnapshot
    let accent: Color

    var stepsValue: String? {
        guard let s = snap.steps else { return nil }
        return formatSteps(s)
    }
    var stepsContext: String? {
        guard let g = snap.stepGoal, g > 0 else { return nil }
        return "of \(formatSteps(g))"
    }
    var waterValue: String? {
        guard let w = snap.waterOz, w > 0 || snap.waterGoalOz != nil else { return nil }
        return w == 0 ? nil : "\(Int(w.rounded())) oz"
    }
    var waterContext: String? {
        guard let g = snap.waterGoalOz, g > 0 else { return nil }
        return "of \(Int(g.rounded())) oz"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Brand label
            Text("BellaHealth")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(accent)
                .textCase(.uppercase)
                .kerning(0.8)
                .padding(.bottom, 8)

            // Steps
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 3) {
                    Image(systemName: "figure.walk")
                        .font(.system(size: 10, weight: .light))
                        .foregroundStyle(accent)
                    Text("STEPS")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                        .kerning(0.5)
                }
                Text(stepsValue ?? "—")
                    .font(.system(size: 24, weight: .semibold, design: .rounded))
                    .foregroundStyle(stepsValue != nil ? Color.primary : Color.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                if let ctx = stepsContext {
                    Text(ctx)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 8)

            // Divider
            Rectangle()
                .fill(Color.secondary.opacity(0.18))
                .frame(height: 0.5)
                .padding(.bottom, 8)

            // Water
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 3) {
                    Image(systemName: "drop")
                        .font(.system(size: 10, weight: .light))
                        .foregroundStyle(accent)
                    Text("WATER")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                        .kerning(0.5)
                }
                Text(waterValue ?? "—")
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    .foregroundStyle(waterValue != nil ? Color.primary : Color.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                if let ctx = waterContext {
                    Text(ctx)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// ─── Medium widget (systemMedium) ─────────────────────────────────────────────

private struct MediumWidgetView: View {
    let snap:   WidgetSnapshot
    let accent: Color

    // Steps
    var stepsValue: String? {
        guard let s = snap.steps else { return nil }
        return formatSteps(s)
    }
    var stepsContext: String? {
        guard let g = snap.stepGoal, g > 0 else { return nil }
        return "/ \(formatSteps(g))"
    }

    // Water
    var waterValue: String? {
        guard let w = snap.waterOz, w > 0 else { return nil }
        return "\(Int(w.rounded())) oz"
    }
    var waterContext: String? {
        guard let g = snap.waterGoalOz, g > 0 else { return nil }
        return "/ \(Int(g.rounded())) oz"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Brand label
            HStack {
                Text("BellaHealth")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(accent)
                    .textCase(.uppercase)
                    .kerning(0.8)
                Spacer()
            }
            .padding(.bottom, 12)

            // Two metric columns: Steps + Water
            HStack(alignment: .top, spacing: 0) {
                MetricColumn(
                    icon: "figure.walk",
                    label: "Steps",
                    value: stepsValue,
                    context: stepsContext,
                    accent: accent
                )

                Rectangle()
                    .fill(Color.secondary.opacity(0.18))
                    .frame(width: 0.5)
                    .padding(.vertical, 2)
                    .padding(.horizontal, 12)

                MetricColumn(
                    icon: "drop",
                    label: "Water",
                    value: waterValue,
                    context: waterContext,
                    accent: accent
                )
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// ─── Lock Screen: Circular (Steps) ────────────────────────────────────────────
//
// Single-metric glanceable. Shows today's step count with a progress ring
// when a step goal is known, or the raw number when no goal is set.
// Tapping opens the app.

private struct CircularLockScreenView: View {
    let snap: WidgetSnapshot

    var stepsValue: String {
        guard let s = snap.steps, s > 0 else { return "—" }
        // Abbreviated for circular: "8.4k" vs "8,421"
        if s >= 1000 { return String(format: "%.1fk", Double(s) / 1000) }
        return "\(s)"
    }

    var progress: Double {
        guard let s = snap.steps, let g = snap.stepGoal, g > 0 else { return 0 }
        return min(Double(s) / Double(g), 1.0)
    }

    var body: some View {
        ZStack {
            if snap.stepGoal != nil && snap.steps != nil {
                // Progress arc behind the number
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .widgetAccentable()
            }
            VStack(spacing: 0) {
                Image(systemName: "figure.walk")
                    .font(.system(size: 9, weight: .light))
                    .widgetAccentable()
                Text(stepsValue)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
            }
        }
        .widgetURL(URL(string: "bellahealth://")!)
    }
}

// ─── Lock Screen: Rectangular (Steps + Water) ─────────────────────────────────
//
// Two-metric compact row. Fits the "bottom lock screen widget" slot.
// Each metric is icon + value in a horizontal stack — no labels to save space.

private struct RectangularLockScreenView: View {
    let snap: WidgetSnapshot

    var stepsText: String {
        guard let s = snap.steps, s > 0 else { return "—" }
        if s >= 1000 { return String(format: "%.1fk", Double(s) / 1000) }
        return "\(s)"
    }
    var waterText: String {
        guard let w = snap.waterOz, w > 0 else { return "—" }
        return "\(Int(w.rounded())) oz"
    }

    var body: some View {
        HStack(spacing: 0) {
            // Steps
            HStack(spacing: 3) {
                Image(systemName: "figure.walk")
                    .font(.system(size: 10, weight: .light))
                    .widgetAccentable()
                Text(stepsText)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)

            Rectangle()
                .fill(.secondary.opacity(0.3))
                .frame(width: 0.5, height: 12)

            // Water
            HStack(spacing: 3) {
                Image(systemName: "drop")
                    .font(.system(size: 10, weight: .light))
                    .widgetAccentable()
                Text(waterText)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
        }
        .widgetURL(URL(string: "bellahealth://")!)
    }
}

// ─── Widget entry view ────────────────────────────────────────────────────────

struct BellaWidgetEntryView: View {
    @Environment(\.widgetFamily) var family
    let entry: BellaEntry

    private var accent: Color {
        Color(hex: entry.snapshot.accentHex ?? "#C17B8E")
    }

    var body: some View {
        switch family {
        case .systemSmall:
            SmallWidgetView(snap: entry.snapshot, accent: accent)
                .widgetURL(URL(string: "bellahealth://")!)
        case .systemMedium:
            MediumWidgetView(snap: entry.snapshot, accent: accent)
                .widgetURL(URL(string: "bellahealth://")!)
        case .accessoryCircular:
            CircularLockScreenView(snap: entry.snapshot)
                .containerBackground(.clear, for: .widget)
        case .accessoryRectangular:
            RectangularLockScreenView(snap: entry.snapshot)
                .containerBackground(.clear, for: .widget)
        default:
            SmallWidgetView(snap: entry.snapshot, accent: accent)
                .widgetURL(URL(string: "bellahealth://")!)
        }
    }
}

// ─── Widget configuration ─────────────────────────────────────────────────────

struct BellaHealthWidget: Widget {
    let kind = "BellaHealthWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BellaProvider()) { entry in
            BellaWidgetEntryView(entry: entry)
                .containerBackground(.background, for: .widget)
        }
        .configurationDisplayName("BellaHealth")
        .description("Steps, water, and sleep at a glance.")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .accessoryCircular,
            .accessoryRectangular,
        ])
    }
}
