import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useAppTheme } from '@/context/theme-context';

export default function AppTabs() {
  const { isDark, userTheme } = useAppTheme();

  // Match editorial screen backgrounds exactly
  const tabBg = isDark
    ? (userTheme === 'mauve' ? '#1A1218' : userTheme === 'forest' ? '#141414' : '#111111')
    : (userTheme === 'mauve' ? '#FAF5F0' : userTheme === 'forest' ? '#F8F2EC' : '#FFFFFF');

  const tabAccent = isDark
    ? (userTheme === 'mauve' ? '#C07890' : userTheme === 'forest' ? '#6A9868' : '#F8F8F8')
    : (userTheme === 'mauve' ? '#C17B8E' : userTheme === 'forest' ? '#6A9878' : '#111111');

  // Muted secondary text for unselected labels
  const tabSecondary = isDark
    ? (userTheme === 'mauve' ? '#7A6070' : userTheme === 'forest' ? '#7A9878' : '#8E8E93')
    : (userTheme === 'mauve' ? '#8B6B6B' : userTheme === 'forest' ? '#5A6E58' : '#6B6B6B');

  // Pill indicator: barely-there tint — selection communicated by label/icon color
  const indicatorTint = isDark
    ? 'rgba(245,240,232,0.06)'
    : 'rgba(17,17,16,0.05)';

  return (
    <NativeTabs
      backgroundColor={tabBg}
      indicatorColor={indicatorTint}
      labelStyle={{
        default:  { color: tabSecondary, fontSize: 10 },
        selected: { color: tabAccent,    fontSize: 10 },
      }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/home.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="explore">
        <NativeTabs.Trigger.Label>Trends</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="context">
        <NativeTabs.Trigger.Label>Context</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/context.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

    </NativeTabs>
  );
}
