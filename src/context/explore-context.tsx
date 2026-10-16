import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { setAnalyticsExploreMode } from '@/services/analytics';

const EXPLORE_KEY = 'explore_mode';

type ExploreContextValue = {
  isExploring: boolean;
  startExploring: () => Promise<void>;
  exitExploring: () => Promise<void>;
};

const ExploreCtx = createContext<ExploreContextValue>({
  isExploring: false,
  startExploring: async () => {},
  exitExploring:  async () => {},
});

export function ExploreProvider({ children }: { children: React.ReactNode }) {
  const [isExploring, setIsExploring] = useState(false);

  // Restore persisted explore state on launch
  useEffect(() => {
    AsyncStorage.getItem(EXPLORE_KEY).then((v) => {
      if (v === 'true') {
        setIsExploring(true);
        setAnalyticsExploreMode(true);
      }
    }).catch(() => {});
  }, []);

  const startExploring = useCallback(async () => {
    await AsyncStorage.setItem(EXPLORE_KEY, 'true').catch(() => {});
    setAnalyticsExploreMode(true);
    setIsExploring(true);
  }, []);

  const exitExploring = useCallback(async () => {
    await AsyncStorage.removeItem(EXPLORE_KEY).catch(() => {});
    setAnalyticsExploreMode(false);
    setIsExploring(false);
  }, []);

  return (
    <ExploreCtx.Provider value={{ isExploring, startExploring, exitExploring }}>
      {children}
    </ExploreCtx.Provider>
  );
}

export function useExplore(): ExploreContextValue {
  return useContext(ExploreCtx);
}
