/**
 * add-widget-target.js
 *
 * Idempotent script: adds the BellaHealthWidget extension target and the
 * BellaHealthWidgetBridge NativeModule to the Xcode project.
 *
 * Run once from the project root:
 *   node scripts/add-widget-target.js
 *
 * After running, commit the updated project.pbxproj together with the
 * Swift/SwiftUI source files and the updated entitlements.
 */

'use strict';

const xcode  = require('xcode');
const fs     = require('fs');
const path   = require('path');

const PROJECT_PATH  = path.join(__dirname, '../ios/BellaHealth.xcodeproj/project.pbxproj');
const APP_GROUP     = 'group.com.isabellafugaro.BellaHealth';
const WIDGET_BUNDLE = 'com.isabellafugaro.BellaHealth.widget';
const WIDGET_NAME   = 'BellaHealthWidget';

// ── Load project ──────────────────────────────────────────────────────────────
const p = xcode.project(PROJECT_PATH);
p.parseSync();

// ── Guard: idempotent ─────────────────────────────────────────────────────────
const existingTargets = p.pbxNativeTargetSection();
const alreadyExists = Object.values(existingTargets).some(
  t => t && t.name && (t.name === `"${WIDGET_NAME}"` || t.name === WIDGET_NAME)
);
if (alreadyExists) {
  console.log('✓ Widget target already present — nothing to do.');
  process.exit(0);
}

console.log('Adding BellaHealthWidget extension target…');

// ── Helpers ───────────────────────────────────────────────────────────────────
function uuid() { return p.generateUuid(); }

function addFileRefAndBuildFile(filePath, lastKnownFileType, groupKey, targetUuid, buildPhaseUuid) {
  const fileRef  = uuid();
  const buildRef = uuid();
  const objects  = p.hash.project.objects;

  // PBXFileReference
  objects['PBXFileReference'][fileRef] = {
    isa: 'PBXFileReference',
    lastKnownFileType,
    name: path.basename(filePath),
    path: filePath,
    sourceTree: '"<group>"',
  };
  objects['PBXFileReference'][fileRef + '_comment'] = path.basename(filePath);

  // PBXBuildFile
  objects['PBXBuildFile'][buildRef] = {
    isa: 'PBXBuildFile',
    fileRef,
  };
  objects['PBXBuildFile'][buildRef + '_comment'] = `${path.basename(filePath)} in Sources`;

  // Add to group
  if (groupKey && objects['PBXGroup'][groupKey]) {
    objects['PBXGroup'][groupKey].children.push({ value: fileRef, comment: path.basename(filePath) });
  }

  // Add to build phase
  if (buildPhaseUuid && objects['PBXSourcesBuildPhase'] && objects['PBXSourcesBuildPhase'][buildPhaseUuid]) {
    objects['PBXSourcesBuildPhase'][buildPhaseUuid].files.push({ value: buildRef, comment: `${path.basename(filePath)} in Sources` });
  }

  return { fileRef, buildRef };
}

function addFrameworkToTarget(frameworkName, frameworkPath, targetFrameworksPhaseUuid) {
  const objects = p.hash.project.objects;

  // Check if framework is already in PBXFileReference
  let fwFileRef = null;
  for (const [key, val] of Object.entries(objects['PBXFileReference'] || {})) {
    if (key.endsWith('_comment')) continue;
    if (val.path === `"${frameworkPath}"` || val.path === frameworkPath) {
      fwFileRef = key;
      break;
    }
  }
  if (!fwFileRef) {
    fwFileRef = uuid();
    objects['PBXFileReference'][fwFileRef] = {
      isa: 'PBXFileReference',
      lastKnownFileType: 'wrapper.framework',
      name: frameworkName,
      path: `"${frameworkPath}"`,
      sourceTree: 'SDKROOT',
    };
    objects['PBXFileReference'][fwFileRef + '_comment'] = frameworkName;
    // Add to Frameworks group
    const fwGroupKey = Object.keys(objects['PBXGroup'] || {}).find(k => {
      const g = objects['PBXGroup'][k];
      return g && g.name === 'Frameworks';
    });
    if (fwGroupKey) {
      objects['PBXGroup'][fwGroupKey].children.push({ value: fwFileRef, comment: frameworkName });
    }
  }

  const buildRef = uuid();
  objects['PBXBuildFile'][buildRef] = {
    isa: 'PBXBuildFile',
    fileRef: fwFileRef,
    settings: { ATTRIBUTES: ['()', 'Required'] },
  };
  objects['PBXBuildFile'][buildRef + '_comment'] = `${frameworkName} in Frameworks`;

  if (targetFrameworksPhaseUuid && objects['PBXFrameworksBuildPhase'] && objects['PBXFrameworksBuildPhase'][targetFrameworksPhaseUuid]) {
    objects['PBXFrameworksBuildPhase'][targetFrameworksPhaseUuid].files.push({ value: buildRef, comment: `${frameworkName} in Frameworks` });
  }

  return buildRef;
}

// ── Step 1: Add BellaHealthWidgetBridge files to main target ──────────────────
console.log('  1. Adding NativeModule files to main BellaHealth target…');

const objects = p.hash.project.objects;
const mainTarget = p.getFirstTarget();
const mainTargetObj = mainTarget.firstTarget;

// Find main Sources build phase
let mainSourcesPhaseKey = null;
for (const phaseKey of (mainTargetObj.buildPhases || [])) {
  const phaseVal = phaseKey.value || phaseKey;
  if (objects['PBXSourcesBuildPhase'] && objects['PBXSourcesBuildPhase'][phaseVal]) {
    mainSourcesPhaseKey = phaseVal;
    break;
  }
}

// Find the BellaHealth group
let mainGroupKey = null;
for (const [key, val] of Object.entries(objects['PBXGroup'] || {})) {
  if (key.endsWith('_comment')) continue;
  if (val.name === 'BellaHealth') {
    mainGroupKey = key;
    break;
  }
}

if (mainSourcesPhaseKey) {
  addFileRefAndBuildFile(
    'BellaHealth/BellaHealthWidgetBridge.swift',
    'sourcecode.swift',
    mainGroupKey,
    mainTarget.uuid,
    mainSourcesPhaseKey
  );
  addFileRefAndBuildFile(
    'BellaHealth/BellaHealthWidgetBridge.m',
    'sourcecode.c.objc',
    mainGroupKey,
    mainTarget.uuid,
    mainSourcesPhaseKey
  );
  console.log('     ✓ BellaHealthWidgetBridge.swift + .m added to main target');
} else {
  console.error('ERROR: Could not find main Sources build phase');
  process.exit(1);
}

// Add WidgetKit to main app's Frameworks phase (needed for WidgetCenter)
let mainFrameworksPhaseKey = null;
for (const phaseKey of (mainTargetObj.buildPhases || [])) {
  const phaseVal = phaseKey.value || phaseKey;
  if (objects['PBXFrameworksBuildPhase'] && objects['PBXFrameworksBuildPhase'][phaseVal]) {
    mainFrameworksPhaseKey = phaseVal;
    break;
  }
}
if (mainFrameworksPhaseKey) {
  addFrameworkToTarget(
    'WidgetKit.framework',
    'System/Library/Frameworks/WidgetKit.framework',
    mainFrameworksPhaseKey
  );
  console.log('     ✓ WidgetKit.framework added to main target');
}

// ── Step 2: Create widget extension target ────────────────────────────────────
console.log('  2. Creating BellaHealthWidget extension target…');

const widgetTarget = p.addTarget(WIDGET_NAME, 'app_extension', WIDGET_NAME, WIDGET_BUNDLE);
const widgetTargetUuid = widgetTarget.uuid;
console.log('     ✓ Target created:', widgetTargetUuid);

// ── Step 3: Add build phases to widget target ─────────────────────────────────
console.log('  3. Adding build phases to widget target…');

const widgetSourcesPhase = p.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', widgetTargetUuid);
const widgetFrameworksPhase = p.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', widgetTargetUuid);
const widgetResourcesPhase = p.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', widgetTargetUuid);

// ── Step 4: Create group and add widget source files ──────────────────────────
console.log('  4. Adding widget source files…');

// Create PBXGroup for widget extension
const widgetGroupKey = uuid();
objects['PBXGroup'] = objects['PBXGroup'] || {};
objects['PBXGroup'][widgetGroupKey] = {
  isa: 'PBXGroup',
  children: [],
  name: WIDGET_NAME,
  path: WIDGET_NAME,
  sourceTree: '"<group>"',
};
objects['PBXGroup'][widgetGroupKey + '_comment'] = WIDGET_NAME;

// Add widget group to root project group
const rootGroupKey = p.hash.project.objects['PBXProject'][
  Object.keys(p.hash.project.objects['PBXProject']).find(k => !k.endsWith('_comment'))
].mainGroup;
if (rootGroupKey && objects['PBXGroup'][rootGroupKey]) {
  objects['PBXGroup'][rootGroupKey].children.push({ value: widgetGroupKey, comment: WIDGET_NAME });
}

// Add Swift source files to widget target
const widgetSourcesPhaseKey = widgetSourcesPhase.buildPhase.uuid;

addFileRefAndBuildFile(
  `${WIDGET_NAME}/BellaHealthWidget.swift`,
  'sourcecode.swift',
  widgetGroupKey,
  widgetTargetUuid,
  widgetSourcesPhaseKey
);
addFileRefAndBuildFile(
  `${WIDGET_NAME}/BellaHealthWidgetBundle.swift`,
  'sourcecode.swift',
  widgetGroupKey,
  widgetTargetUuid,
  widgetSourcesPhaseKey
);
console.log('     ✓ BellaHealthWidget.swift + BellaHealthWidgetBundle.swift added');

// Add Info.plist as a file reference (not a build file — it's referenced via INFOPLIST_FILE)
const infoPlistRef = uuid();
objects['PBXFileReference'][infoPlistRef] = {
  isa: 'PBXFileReference',
  lastKnownFileType: 'text.plist.xml',
  name: 'Info.plist',
  path: `${WIDGET_NAME}/Info.plist`,
  sourceTree: '"<group>"',
};
objects['PBXFileReference'][infoPlistRef + '_comment'] = 'Info.plist';
objects['PBXGroup'][widgetGroupKey].children.push({ value: infoPlistRef, comment: 'Info.plist' });

// Add entitlements as a file reference
const entRef = uuid();
objects['PBXFileReference'][entRef] = {
  isa: 'PBXFileReference',
  lastKnownFileType: 'text.plist.entitlements',
  name: `${WIDGET_NAME}.entitlements`,
  path: `${WIDGET_NAME}/${WIDGET_NAME}.entitlements`,
  sourceTree: '"<group>"',
};
objects['PBXFileReference'][entRef + '_comment'] = `${WIDGET_NAME}.entitlements`;
objects['PBXGroup'][widgetGroupKey].children.push({ value: entRef, comment: `${WIDGET_NAME}.entitlements` });

// ── Step 5: Add WidgetKit and SwiftUI frameworks to widget target ──────────────
console.log('  5. Linking WidgetKit and SwiftUI to widget target…');

const widgetFrameworksPhaseKey = widgetFrameworksPhase.buildPhase.uuid;
addFrameworkToTarget('WidgetKit.framework', 'System/Library/Frameworks/WidgetKit.framework', widgetFrameworksPhaseKey);
addFrameworkToTarget('SwiftUI.framework', 'System/Library/Frameworks/SwiftUI.framework', widgetFrameworksPhaseKey);
console.log('     ✓ WidgetKit.framework + SwiftUI.framework linked');

// ── Step 6: Configure build settings for widget target ────────────────────────
console.log('  6. Configuring widget build settings…');

p.updateBuildProperty('SWIFT_VERSION', '5.0', 'Debug', WIDGET_NAME);
p.updateBuildProperty('SWIFT_VERSION', '5.0', 'Release', WIDGET_NAME);
p.updateBuildProperty('IPHONEOS_DEPLOYMENT_TARGET', '16.4', 'Debug', WIDGET_NAME);
p.updateBuildProperty('IPHONEOS_DEPLOYMENT_TARGET', '16.4', 'Release', WIDGET_NAME);
p.updateBuildProperty('TARGETED_DEVICE_FAMILY', '"1"', 'Debug', WIDGET_NAME);
p.updateBuildProperty('TARGETED_DEVICE_FAMILY', '"1"', 'Release', WIDGET_NAME);
// Override the default -Info.plist path set by addTarget
p.updateBuildProperty('INFOPLIST_FILE', `"${WIDGET_NAME}/Info.plist"`, 'Debug', WIDGET_NAME);
p.updateBuildProperty('INFOPLIST_FILE', `"${WIDGET_NAME}/Info.plist"`, 'Release', WIDGET_NAME);
p.updateBuildProperty('CODE_SIGN_ENTITLEMENTS', `"${WIDGET_NAME}/${WIDGET_NAME}.entitlements"`, 'Debug', WIDGET_NAME);
p.updateBuildProperty('CODE_SIGN_ENTITLEMENTS', `"${WIDGET_NAME}/${WIDGET_NAME}.entitlements"`, 'Release', WIDGET_NAME);
// Widget extensions must not be stripped / stripped differently
p.updateBuildProperty('SKIP_INSTALL', 'YES', 'Debug', WIDGET_NAME);
p.updateBuildProperty('SKIP_INSTALL', 'YES', 'Release', WIDGET_NAME);
// Silence arc/bridging warnings in extension
p.updateBuildProperty('CLANG_ENABLE_OBJC_ARC', 'YES', 'Debug', WIDGET_NAME);
p.updateBuildProperty('CLANG_ENABLE_OBJC_ARC', 'YES', 'Release', WIDGET_NAME);
console.log('     ✓ Build settings configured');

// ── Step 7: Write project ─────────────────────────────────────────────────────
console.log('  7. Writing project.pbxproj…');
fs.writeFileSync(PROJECT_PATH, p.writeSync());
console.log('\n✓ Done. project.pbxproj updated successfully.\n');
console.log('Next steps:');
console.log('  1. cd ios && pod install && cd ..');
console.log('  2. Open ios/BellaHealth.xcworkspace and verify both targets build');
console.log('  3. Run eas build to test the cloud build');
