const { withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');

function withHealthKit(config) {
  config = withEntitlementsPlist(config, (c) => {
    c.modResults['com.apple.developer.healthkit'] = true;
    c.modResults['com.apple.developer.healthkit.access'] = [];
    return c;
  });

  config = withInfoPlist(config, (c) => {
    c.modResults.NSHealthShareUsageDescription =
      'BellaHealth reads your health data to show sleep, steps, workouts, and heart rate on your dashboard.';
    c.modResults.NSHealthUpdateUsageDescription =
      'BellaHealth does not write to Apple Health.';
    return c;
  });

  return config;
}

module.exports = withHealthKit;
