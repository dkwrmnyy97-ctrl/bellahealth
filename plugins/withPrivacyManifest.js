// Writes PrivacyInfo.xcprivacy into the iOS app target during EAS prebuild.
// Required by Apple for all apps submitted to the App Store as of Spring 2024.
//
// Declared APIs:
//   NSPrivacyAccessedAPICategoryUserDefaults — used by AsyncStorage (CA92.1: app-provided defaults)
//
// Collected data:
//   Device ID — anonymous UUID stored in AsyncStorage, used for product analytics only.
//   Not linked to identity, not used for tracking.

const { withDangerousMod } = require('@expo/config-plugins');
const fs   = require('fs');
const path = require('path');

const PRIVACY_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSPrivacyTracking</key>
    <false/>
    <key>NSPrivacyTrackingDomains</key>
    <array/>
    <key>NSPrivacyCollectedDataTypes</key>
    <array>
        <dict>
            <key>NSPrivacyCollectedDataType</key>
            <string>NSPrivacyCollectedDataTypeDeviceID</string>
            <key>NSPrivacyCollectedDataTypeLinked</key>
            <false/>
            <key>NSPrivacyCollectedDataTypeTracking</key>
            <false/>
            <key>NSPrivacyCollectedDataTypePurposes</key>
            <array>
                <string>NSPrivacyCollectedDataTypePurposeAnalytics</string>
            </array>
        </dict>
    </array>
    <key>NSPrivacyAccessedAPITypes</key>
    <array>
        <dict>
            <key>NSPrivacyAccessedAPIType</key>
            <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
            <key>NSPrivacyAccessedAPITypeReasons</key>
            <array>
                <string>CA92.1</string>
            </array>
        </dict>
    </array>
</dict>
</plist>`;

function withPrivacyManifest(config) {
  return withDangerousMod(config, [
    'ios',
    (c) => {
      const projectName = c.modRequest.projectName;
      const iosProjectDir = path.join(c.modRequest.projectRoot, 'ios', projectName);
      fs.mkdirSync(iosProjectDir, { recursive: true });
      fs.writeFileSync(path.join(iosProjectDir, 'PrivacyInfo.xcprivacy'), PRIVACY_MANIFEST, 'utf8');
      return c;
    },
  ]);
}

module.exports = withPrivacyManifest;
