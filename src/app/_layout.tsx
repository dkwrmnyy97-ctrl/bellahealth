import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { ErrorBoundary } from '@/components/error-boundary';
import { AppThemeProvider } from '@/context/theme-context';
import { ExploreProvider } from '@/context/explore-context';
import { initializeAuth } from '@/services/auth';
import { retrySyncIfPending } from '@/services/cloud-sync';

export default function TabLayout() {
  const colorScheme = useColorScheme();

  // Establish (or recover) the anonymous Supabase session on every launch.
  // On subsequent launches the session is restored from AsyncStorage instantly.
  // On first launch a network call creates the anonymous auth.users row.
  // After the session is ready, retry any cloud sync that previously failed
  // (e.g. device was offline). Fire-and-forget: never blocks app launch.
  useEffect(() => {
    initializeAuth().then(() => {
      retrySyncIfPending().catch(() => {});
    });
  }, []);

  return (
    <ErrorBoundary>
      <AppThemeProvider>
        <ExploreProvider>
          <SafeAreaProvider>
            <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
              <AppTabs />
            </ThemeProvider>
          </SafeAreaProvider>
          <AnimatedSplashOverlay />
        </ExploreProvider>
      </AppThemeProvider>
    </ErrorBoundary>
  );
}
