/**
 * BellaHealthWidgetBridge.swift
 *
 * Native module that writes the BellaHealth widget snapshot to the shared
 * App Group UserDefaults and tells WidgetKit to reload its timelines.
 *
 * Called from JS via:
 *   NativeModules.BellaHealthWidgetBridge.writeSnapshot(snapshot)
 *
 * The snapshot is a plain JSON-serializable object assembled in
 * src/services/widget-snapshot.ts from the app's live health data.
 */

import Foundation
import WidgetKit

@objc(BellaHealthWidgetBridge)
class BellaHealthWidgetBridge: NSObject {

  private let appGroup = "group.com.isabellafugaro.BellaHealth"
  private let snapshotKey = "bellahealth_widget_snapshot"

  /// Old-architecture NativeModules can be instantiated on a background thread.
  @objc static func requiresMainQueueSetup() -> Bool { return false }

  @objc(writeSnapshot:resolver:rejecter:)
  func writeSnapshot(
    _ data: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let defaults = UserDefaults(suiteName: appGroup) else {
      reject("APP_GROUP", "Could not open App Group UserDefaults for \(appGroup)", nil)
      return
    }

    do {
      let json = try JSONSerialization.data(withJSONObject: data, options: [])
      guard let jsonString = String(data: json, encoding: .utf8) else {
        reject("ENCODE", "Could not encode snapshot as UTF-8", nil)
        return
      }
      defaults.set(jsonString, forKey: snapshotKey)
      // Prompt WidgetKit to pick up the new data immediately.
      WidgetCenter.shared.reloadAllTimelines()
      resolve(nil)
    } catch {
      reject("SERIALIZE", "Could not serialize widget snapshot: \(error.localizedDescription)", error)
    }
  }
}
