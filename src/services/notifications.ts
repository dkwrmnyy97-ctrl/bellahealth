import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function requestNotificationPermissions(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    if (existing === 'granted') return true;
    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

export async function scheduleWaterReminder(goalOz: number): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync('bella-water-reminder').catch(() => {});
    await Notifications.scheduleNotificationAsync({
      identifier: 'bella-water-reminder',
      content: {
        title: 'Hydration Check',
        body: `Have you been drinking enough water today? Goal: ${goalOz} oz.`,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: 14,
        minute: 0,
      },
    });
  } catch {}
}

export async function scheduleStepsReminder(stepGoal: number): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync('bella-steps-reminder').catch(() => {});
    await Notifications.scheduleNotificationAsync({
      identifier: 'bella-steps-reminder',
      content: {
        title: 'Move a Little',
        body: `Goal: ${stepGoal.toLocaleString()} steps. How are you tracking?`,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: 19,
        minute: 0,
      },
    });
  } catch {}
}

export async function cancelGoalReminders(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync('bella-water-reminder').catch(() => {});
    await Notifications.cancelScheduledNotificationAsync('bella-steps-reminder').catch(() => {});
  } catch {}
}

export async function triggerDrinkWarning(): Promise<void> {
  try {
    // Cancel any previously scheduled drink warnings before rescheduling
    await Notifications.cancelScheduledNotificationAsync('bella-drink-warning-5m').catch(() => {});
    await Notifications.cancelScheduledNotificationAsync('bella-drink-warning-1h').catch(() => {});

    // 5-minute nudge
    await Notifications.scheduleNotificationAsync({
      identifier: 'bella-drink-warning-5m',
      content: {
        title: 'Mix a water in',
        body: "You've had 4 drinks. Alternate with water to feel better tomorrow.",
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 5 * 60,
      },
    });

    // 1-hour follow-up
    await Notifications.scheduleNotificationAsync({
      identifier: 'bella-drink-warning-1h',
      content: {
        title: 'Hydration check',
        body: "Still out? Keep a water going — your HRV will thank you.",
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 60 * 60,
      },
    });
  } catch {}
}
