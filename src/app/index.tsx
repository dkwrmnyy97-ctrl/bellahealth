import { SymbolView } from 'expo-symbols';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, AppState, RefreshControl, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAppTheme } from '@/context/theme-context';
import { useExplore } from '@/context/explore-context';

import { CaffeineModal } from '@/components/caffeine-modal';
import { ChatModal } from '@/components/chat-modal';
import { DocumentsModal } from '@/components/documents-modal';
import { DrinkingModal } from '@/components/drinking-modal';
import { GroundingModal } from '@/components/grounding-modal';
import { MealsModal } from '@/components/meals-modal';
import { MenuModal } from '@/components/menu-modal';
import { ProfileModal } from '@/components/profile-modal';
import { StepsBar } from '@/components/steps-bar';
import { TrainingModal } from '@/components/training-modal';
import { TravelModal } from '@/components/vacation-modal';
import { WellnessModal } from '@/components/wellness-modal';
import { CycleModal, loadCycleEntries, loadCycleProfile, buildCycleContext, type CycleEntry } from '@/components/cycle-modal';
import { SupportModal } from '@/components/support-modal';
import { ThemedText } from '@/components/themed-text';
import { Spacing, Fonts } from '@/constants/theme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getLastNightSleep,
  getLatestHRV,
  getRestingHeartRate,
  getTodayWorkouts,
  getTodaySteps,
  getTodayWater,
  getSleepHours,
  getSleepInBedHours,
  initHealthKit,
  getHealthKitProfile,
  WorkoutSample,
} from '@/services/healthkit';
import * as Device from 'expo-device';
import { fetchOuraDaily, fetchOuraPeriodStart, getOuraToken } from '@/services/oura';
import { fetchWhoopDaily, getWhoopToken } from '@/services/whoop';
import { trackEvent } from '@/services/analytics';
import { isAppleLinked } from '@/services/apple-auth';
import { DEMO_MODE } from '@/config/demo';
import {
  DEMO_HEALTH, DEMO_USER_NAME, DEMO_WORKOUTS, DEMO_CYCLE_DAY, DEMO_SLEEP_GOAL_HRS,
} from '@/demo/demo-data';
import { MetricSourceSheet, type SourceItem } from '@/components/metric-source-sheet';
import { AppleAccountPrompt } from '@/components/apple-account-prompt';
import { CompanionPrompt } from '@/components/companion-prompt';
import { OnboardingFlow } from '@/components/onboarding-flow';
import { WhatsNewContext, WHATS_NEW_KEY } from '@/components/whats-new-context';
import {
  openOura,
  showAppleHealthPath,
  COMPANION_RELEVANCE,
  COMPANION_LABELS,
  COMPANION_OPENERS,
  type MetricType,
  type CompanionApp,
} from '@/utils/health-sources';

function parseDeviceFirstName(): string {
  const deviceName = Device.deviceName ?? '';
  const match = deviceName.match(/^(.+?)'s /i);
  if (match) return match[1].trim().split(' ')[0];
  return 'there';
}
import { requestNotificationPermissions, scheduleWaterReminder, scheduleStepsReminder, cancelGoalReminders } from '@/services/notifications';
import { resolveTravelGoals } from '@/utils/travel-goals';
import { appendWaterHistory } from '@/services/context-events';
import { writeWidgetSnapshot } from '@/services/widget-snapshot';

function localDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function localYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const DEFAULT_HEALTH = {
  sleep:   { hours: 0, score: 0, hrv: 0, readiness: 0, inBedHours: 0, restingHR: 0 },
  steps:   { count: 0, goal: 10000 },
  macros:  { calories: 0, protein: 0, carbs: 0, fat: 0, calGoal: 2000 },
  workout: { type: '—', duration: 0, calories: 0, done: false },
  water:   { oz: 0, goalOz: 80 },
  hadAlcoholLastNight: false,
};

// ── Palettes — one `accent` drives fills, links, active states ────────────────
// Category colors kept for type compat but not used in the main layout.

const PALETTE_FEMALE = {
  background:    '#F8F2EC',
  card:          '#FFFFFF',
  accent:        '#C17B8E',
  text:          '#2D1B1B',
  textSecondary: '#8B6B6B',
  shadow:        'rgba(180,140,130,0.22)',
  divider:       '#E4D8D0',
  cardBorder:    'rgba(45,27,27,0.07)' as string,
  sleep: '#7A9E78', steps: '#B85E68', nutrition: '#A06050',
  workout: '#8070A8', water: '#5A90B0', drinking: '#8C4252', cycle: '#A85878',
};

const PALETTE_FEMALE_DARK = {
  background:    '#1A1218',
  card:          '#251D28',
  accent:        '#C07890',
  text:          '#F2E8EC',
  textSecondary: '#8A7888',
  shadow:        'rgba(0,0,0,0.60)',
  divider:       'rgba(255,255,255,0.10)',
  cardBorder:    'rgba(255,255,255,0.07)' as string,
  sleep: '#72A86E', steps: '#D47880', nutrition: '#C06858',
  workout: '#9888C8', water: '#68A0C0', drinking: '#B05868', cycle: '#C07898',
};

const PALETTE_MALE = {
  background:    '#F8F2EC', // same warm ivory canvas as female — background is sex-neutral
  card:          '#FFFFFF',
  accent:        '#6A9878',
  text:          '#1E2820',
  textSecondary: '#5A6E58',
  shadow:        'rgba(30,40,32,0.18)',
  divider:       '#C8D4C4',
  cardBorder:    'rgba(30,40,32,0.07)' as string,
  sleep: '#6A9878', steps: '#7A8E68', nutrition: '#8A7A58',
  workout: '#7A9870', water: '#5A8878', drinking: '#6A7858', cycle: '#7A9878',
};

const PALETTE_MALE_DARK = {
  background:    '#141414', // neutral dark — no green tint
  card:          '#1C1C1E',
  accent:        '#6A9868',
  text:          '#E8F0E6',
  textSecondary: '#7A9878',
  shadow:        'rgba(0,0,0,0.60)',
  divider:       'rgba(255,255,255,0.10)',
  cardBorder:    'rgba(255,255,255,0.07)' as string,
  sleep: '#5A9068', steps: '#6A8858', nutrition: '#7A6848',
  workout: '#6A9060', water: '#508878', drinking: '#5A7850', cycle: '#6A9068',
};

const PALETTE_NEUTRAL = {
  background:    '#FFFFFF',
  card:          '#FFFFFF',
  accent:        '#111111',
  text:          '#111111',
  textSecondary: '#6B6B6B',
  shadow:        'rgba(0,0,0,0.10)',
  divider:       '#E4E4E4',
  cardBorder:    'rgba(0,0,0,0.07)' as string,
  sleep: '#6B6B6B', steps: '#6B6B6B', nutrition: '#6B6B6B',
  workout: '#6B6B6B', water: '#6B6B6B', drinking: '#6B6B6B', cycle: '#6B6B6B',
};

const PALETTE_NEUTRAL_DARK = {
  background:    '#111111',
  card:          '#1C1C1E',
  accent:        '#F8F8F8',
  text:          '#FFFFFF',
  textSecondary: '#8E8E93',
  shadow:        'rgba(0,0,0,0.60)',
  divider:       'rgba(255,255,255,0.12)',
  cardBorder:    'rgba(255,255,255,0.07)' as string,
  sleep: '#8E8E93', steps: '#8E8E93', nutrition: '#8E8E93',
  workout: '#8E8E93', water: '#8E8E93', drinking: '#8E8E93', cycle: '#8E8E93',
};

export type AppPalette = typeof PALETTE_FEMALE;
const PaletteContext = React.createContext<AppPalette>(PALETTE_NEUTRAL);

// ── Sub-components ────────────────────────────────────────────────────────────

function Rule() {
  const pal = useContext(PaletteContext);
  return <View style={[styles.rule, { backgroundColor: pal.divider }]} />;
}

function SectionHead({
  label,
  actionLabel,
  onAction,
  aside,
}: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
  aside?: React.ReactNode;
}) {
  const pal = useContext(PaletteContext);
  return (
    <View style={styles.sectionHead}>
      <ThemedText style={[styles.sectionLabel, { color: pal.textSecondary }]}>{label}</ThemedText>
      {aside}
      {actionLabel && onAction && (
        <TouchableOpacity onPress={onAction} activeOpacity={0.7}>
          <ThemedText style={[styles.actionLink, { color: pal.accent }]}>{actionLabel}</ThemedText>
        </TouchableOpacity>
      )}
    </View>
  );
}

/** Format a macro gram value to at most 1 decimal place, trimming trailing zeros. */
function fmtMacro(g: number): string {
  return parseFloat(g.toFixed(1)).toString();
}

function MetricPair({ label, value }: { label: string; value: string }) {
  const pal = useContext(PaletteContext);
  return (
    <View style={styles.metricPair}>
      <ThemedText style={[styles.metricLabel, { color: pal.textSecondary }]}>{label}</ThemedText>
      <ThemedText style={[styles.metricValue, { color: pal.text }]}>{value}</ThemedText>
    </View>
  );
}

function ThinProgress({ value, total }: { value: number; total: number }) {
  const pal = useContext(PaletteContext);
  const pct = Math.min(value / Math.max(total, 1), 1);
  return (
    <View style={[styles.progressTrack, { backgroundColor: pal.divider }]}>
      <View style={[styles.progressFill, { width: `${pct * 100}%` as any, backgroundColor: pal.accent }]} />
    </View>
  );
}

function getGreetingWord() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function HomeScreen() {
  const [mealsOpen, setMealsOpen] = useState(false);
  const [drinkingOpen, setDrinkingOpen] = useState(false);
  const [wellnessOpen, setWellnessOpen] = useState(false);
  const [groundingOpen, setGroundingOpen] = useState(false);
  const [caffeineOpen, setCaffeineOpen] = useState(false);
  const [electrolytesLogged, setElectrolytesLogged] = useState(false);
  const [sleepGoalHrs, setSleepGoalHrs] = useState(8);
  const [isTravelMode, setIsTravelMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);

  // Open Chat if Trends screen requested it via AsyncStorage flag.
  // Also reset to Today whenever the tab regains focus — date browsing is
  // transient navigation, not a persistent preference.
  useFocusEffect(useCallback(() => {
    AsyncStorage.getItem('open_chat_flag').then(v => {
      if (v) {
        AsyncStorage.removeItem('open_chat_flag').catch(() => {});
        setTimeout(() => setChatOpen(true), 350);
      }
    }).catch(() => {});
    trackEvent('home_viewed', { source_screen: 'home' });
  }, []));
  const [trainingOpen, setTrainingOpen] = useState(false);
  const [vacationOpen, setVacationOpen] = useState(false);
  const [healthData, setHealthData] = useState(DEFAULT_HEALTH);
  const [userName, setUserName] = useState(parseDeviceFirstName);
  const [refreshing, setRefreshing] = useState(false);
  const [todayWorkouts, setTodayWorkouts] = useState<WorkoutSample[]>([]);
  const manualWaterRef = useRef(0);
  const [cycleOpen, setCycleOpen] = useState(false);
  const [todayCycleEntry, setTodayCycleEntry] = useState<CycleEntry | null>(null);
  const [cycleDayCount, setCycleDayCount] = useState<number | null>(null);
  const [hasOura, setHasOura] = useState(false);
  const [ouraSleepDate, setOuraSleepDate] = useState<string | null>(null);
  const [hasProfile, setHasProfile] = useState(true); // optimistic — hide banner until we know
  const appOpenTrackedRef = useRef(false);
  // Timestamp of last Oura fetch triggered by foreground transition (ms).
  // Guards against hammering the API every time the user switches apps briefly.
  const ouraLastForegroundFetchRef = useRef<number>(0);
  // Calendar date (YYYY-MM-DD) of the most recent successful Oura fetch.
  // Used to detect cross-midnight stale-score scenarios: a score cached on a prior
  // day must not carry forward when today's data is missing.
  const ouraFetchDateRef = useRef<string>('');
  // Monotonically increasing counter incremented at the start of every Oura API
  // request. Each request captures its own generation number; the result is applied
  // only when the captured number still matches the ref, guaranteeing a slow initial
  // load cannot overwrite a faster pull-to-refresh result that completed first.
  const ouraFetchSeqRef = useRef<number>(0);
  const [supportOpen, setSupportOpen] = useState(false);
  const [supplements, setSupplements] = useState('');
  const { isDark, isMale, hasGenderPref, setIsMale, toggleDark, userTheme } = useAppTheme();
  type SheetConfig = { title: string; sources: SourceItem[] };
  const [sourceSheet, setSourceSheet] = useState<SheetConfig | null>(null);
  const [companionApps, setCompanionApps] = useState<CompanionApp[]>([]);
  const [showCompanionPrompt, setShowCompanionPrompt] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [showApplePrompt, setShowApplePrompt] = useState(false);
  const router = useRouter();
  const { isExploring, startExploring, exitExploring } = useExplore();

  useEffect(() => {
    // ── DEMO / EXPLORE MODE: substitute synthetic data, skip all real data sources
    if (DEMO_MODE || isExploring) {
      setHealthData(DEMO_HEALTH);
      setUserName(DEMO_USER_NAME);
      setTodayWorkouts(DEMO_WORKOUTS);
      setSleepGoalHrs(DEMO_SLEEP_GOAL_HRS);
      setHasOura(true);
      setHasProfile(true);
      setCycleDayCount(DEMO_CYCLE_DAY);
      return;
    }

    // ── Exiting explore mode: reset all state to defaults before loading real data
    // Without this reset, stale demo values persist on screen until each async
    // source returns — and sources that never return (no Oura token, no HK perms)
    // would leave demo data showing permanently.
    setHealthData(DEFAULT_HEALTH);
    setHasOura(false);
    setTodayWorkouts([]);
    setCycleDayCount(null);
    setUserName(parseDeviceFirstName());

    // Track app lifecycle once per process lifetime (ref guards against StrictMode double-invoke)
    if (!appOpenTrackedRef.current) {
      appOpenTrackedRef.current = true;
      // app_first_open fires exactly once per install (AsyncStorage flag persists across launches)
      AsyncStorage.getItem('analytics_first_open_sent').then((sent) => {
        if (!sent) {
          AsyncStorage.setItem('analytics_first_open_sent', '1').catch(() => {});
          trackEvent('app_first_open', { source_screen: 'home' });
        }
      }).catch(() => {});
      trackEvent('app_opened', { source_screen: 'home' });
    }

    // Oura and drink log run independently — don't depend on HealthKit
    async function loadOuraAndDrinkLog() {
      try {
        const [ouraToken, whoopToken] = await Promise.all([getOuraToken(), getWhoopToken()]);

        // One-time catch-up: emit oura_connected for users who connected before
        // analytics instrumentation existed. getOuraToken() is the reliable
        // connected-state check — a non-null token means the OAuth flow was
        // completed at some point. Fire-and-forget; never blocks startup.
        if (ouraToken) {
          AsyncStorage.getItem('analytics_oura_catchup_sent').then((sent) => {
            if (!sent) {
              AsyncStorage.setItem('analytics_oura_catchup_sent', '1').catch(() => {});
              trackEvent('oura_connected', { source_screen: 'home' });
            }
          }).catch(() => {});
        }

        // Whoop loads first as baseline (lower priority than Oura)
        if (whoopToken && !ouraToken) {
          try {
            const whoop = await fetchWhoopDaily(whoopToken);
            setHealthData((prev) => ({
              ...prev,
              sleep: {
                ...prev.sleep,
                score:     whoop.sleepScore,
                hrv:       whoop.hrv,
                hours:     whoop.sleepHours > 0 ? whoop.sleepHours : prev.sleep.hours,
                readiness: whoop.recoveryScore,
                restingHR: whoop.restingHR > 0 ? whoop.restingHR : prev.sleep.restingHR,
              },
            }));
          } catch {}
        }

        if (ouraToken) {
          setHasOura(true); // token present = Oura is connected; show button regardless of fetch outcome
          // Capture generation before the async fetch so a concurrent pull-to-refresh
          // that increments the counter makes this response detectable as stale.
          const mySeq = ++ouraFetchSeqRef.current;
          const oura = await fetchOuraDaily(ouraToken);
          if (mySeq !== ouraFetchSeqRef.current) {
            // A newer Oura request (foreground transition or pull-to-refresh) started
            // while this one was in-flight — discard to avoid overwriting fresher data.
          } else {
            if (oura.sleepDate) setOuraSleepDate(oura.sleepDate);
            const sameDay = oura.fetchDate === ouraFetchDateRef.current;
            ouraFetchDateRef.current = oura.fetchDate;
            setHealthData((prev) => ({
              ...prev,
              sleep: {
                ...prev.sleep,
                // Guard: 0 means "not yet available from Oura today". Preserve a cached
                // value only if this fetch is for the SAME calendar day — a prior day's
                // score must not carry into today when today's data is missing.
                score:     oura.sleepScore    > 0 ? oura.sleepScore
                         : (sameDay ? prev.sleep.score     : 0),
                hrv:       oura.hrvAvg        > 0 ? oura.hrvAvg
                         : (sameDay ? prev.sleep.hrv       : 0),
                hours:     oura.sleepHours    > 0 ? oura.sleepHours
                         : (sameDay ? prev.sleep.hours     : 0),
                readiness: oura.readinessScore > 0 ? oura.readinessScore
                         : (sameDay ? prev.sleep.readiness : 0),
              },
            }));
          }
        }
      } catch {}

      try {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = localYesterdayStr();
        const drinkRaw = await AsyncStorage.getItem('drink_log');
        const drinkLog: any[] = drinkRaw ? JSON.parse(drinkRaw) : [];
        const hadAlcohol = drinkLog.some((e) => e.date === yesterdayStr && e.totalDrinks > 0);
        setHealthData((prev) => ({ ...prev, hadAlcoholLastNight: hadAlcohol }));
      } catch {}
    }

    async function loadHealthData() {
      try {
        await initHealthKit();

        const [stepsResult, sleepResult, hrvResult, restingHRResult, workoutsResult, waterResult] = await Promise.allSettled([
          getTodaySteps(),
          getLastNightSleep(),
          getLatestHRV(),
          getRestingHeartRate(),
          getTodayWorkouts(),
          getTodayWater(),
        ]);

        const steps        = stepsResult.status     === 'fulfilled' ? stepsResult.value     : 0;
        const sleepSamples = sleepResult.status     === 'fulfilled' ? sleepResult.value     : [];
        const hrv          = hrvResult.status        === 'fulfilled' ? hrvResult.value       : 0;
        const restingHR    = restingHRResult.status  === 'fulfilled' ? restingHRResult.value : 0;
        const workouts     = workoutsResult.status   === 'fulfilled' ? workoutsResult.value  : [];
        const waterOz      = waterResult.status      === 'fulfilled' ? waterResult.value     : 0;

        setTodayWorkouts(workouts);

        const sleepHours   = getSleepHours(sleepSamples);
        const inBedHours   = getSleepInBedHours(sleepSamples);

        setHealthData((prev) => ({
          ...prev,
          sleep: {
            hours:      prev.sleep.hours > 0 ? prev.sleep.hours : sleepHours,
            score:      prev.sleep.score,
            hrv:        prev.sleep.hrv > 0 ? prev.sleep.hrv : hrv,
            readiness:  prev.sleep.readiness,
            inBedHours: prev.sleep.inBedHours > 0 ? prev.sleep.inBedHours : inBedHours,
            restingHR:  prev.sleep.restingHR  > 0 ? prev.sleep.restingHR  : restingHR,
          },
          // HealthKit has real-time steps for today; preserve goal from profile
          steps: { count: steps > 0 ? steps : prev.steps.count, goal: prev.steps.goal },
          water: { oz: waterOz + manualWaterRef.current, goalOz: prev.water.goalOz },
          workout: workouts.length > 0
            ? {
                type: workouts.length === 1
                  ? workouts[0].activityName
                  : `${workouts.length} workouts`,
                duration: workouts.reduce((sum, w) => sum + w.duration, 0),
                calories: workouts.reduce((sum, w) => sum + w.calories, 0),
                done: true,
              }
            : prev.workout,
        }));
      } catch {}
    }

    // Load electrolytes state
    AsyncStorage.getItem('electrolytes_log').then((raw) => {
      if (!raw) return;
      const { date, logged } = JSON.parse(raw);
      const today = localDateStr();
      if (date === today) setElectrolytesLogged(logged);
    }).catch(() => {});

    // Load cycle journal — try Oura first for period start date
    Promise.all([loadCycleEntries(), loadCycleProfile()]).then(async ([entries, profile]) => {
      const today = localDateStr();
      setTodayCycleEntry(entries.find((e) => e.date === today) ?? null);

      // Try to get period start from Oura (primary source)
      let effectiveProfile = profile;
      try {
        const token = await getOuraToken();
        if (token) {
          const ouraDate = await fetchOuraPeriodStart(token);
          if (ouraDate && (!profile.lastPeriodDate || ouraDate > profile.lastPeriodDate)) {
            effectiveProfile = { lastPeriodDate: ouraDate };
            await AsyncStorage.setItem('cycle_profile', JSON.stringify(effectiveProfile));
          }
        }
      } catch {}

      if (effectiveProfile.lastPeriodDate) {
        const days = Math.floor((Date.now() - new Date(effectiveProfile.lastPeriodDate + 'T00:00:00').getTime()) / 86400000);
        setCycleDayCount(days);
      }
    }).catch(() => {});

    // Load today's manually logged water
    AsyncStorage.getItem('manual_water').then((raw) => {
      if (!raw) return;
      const { date, oz } = JSON.parse(raw);
      const today = localDateStr();
      if (date === today) {
        manualWaterRef.current = oz;
        setHealthData((prev) => ({ ...prev, water: { ...prev.water, oz: prev.water.oz + oz } }));
      }
    }).catch(() => {});

    // Load today's logged meal macros
    AsyncStorage.getItem('meal_log').then((raw) => {
      if (!raw) return;
      const today = localDateStr();
      const all = JSON.parse(raw);
      const todayMeals = all.filter((m: any) => m.date === today);
      if (todayMeals.length === 0) return;
      const totals = todayMeals.reduce(
        (acc: any, m: any) => ({
          calories: acc.calories + m.calories,
          protein: acc.protein + m.protein,
          carbs: acc.carbs + m.carbs,
          fat: acc.fat + m.fat,
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 },
      );
      setHealthData((prev) => ({ ...prev, macros: { ...prev.macros, ...totals } }));
    }).catch(() => {});

    // ── Context feature walkthrough (one-time, versioned) ─────────────────────
    function checkContextWalkthrough() {
      AsyncStorage.getItem(WHATS_NEW_KEY).then((seen) => {
        if (!seen) setTimeout(() => setShowWhatsNew(true), 800);
      }).catch(() => {});
    }

    // Load saved goals and name from profile
    AsyncStorage.getItem('user_profile').then((raw) => {
      if (!raw) {
        setHasProfile(false);
        AsyncStorage.getItem('onboarding_complete').then((done) => {
          if (!done) { setShowOnboarding(true); return; }
          // Onboarding was completed but profile is gone — still show walkthrough
          checkContextWalkthrough();
        }).catch(() => {});
        return;
      }
      try {
        const p = JSON.parse(raw);
        if (p.name) setUserName(p.name);
        else setHasProfile(false); // stub profile (post-onboarding) — show setup banner
        if (p.supplements) setSupplements(p.supplements);
        if (Array.isArray(p.companionApps)) setCompanionApps(p.companionApps as CompanionApp[]);

        // One-time companion prompt: show if existing user hasn't configured apps yet
        if (p.companionApps === undefined) {
          setTimeout(() => setShowCompanionPrompt(true), 2500);
        }

        if (p.gender?.toLowerCase().startsWith('m')) {
          setIsMale(true);
        } else if (p.gender) {
          setIsMale(false);
        } else {
          // No gender saved — fall back to HealthKit biological sex
          getHealthKitProfile().then((hk) => {
            if (hk.sex?.toLowerCase().startsWith('m')) setIsMale(true);
          }).catch(() => {});
        }
        const goalOz   = parseInt(p.waterGoal, 10);
        const calGoal  = parseInt(p.calGoal,   10);
        const stepGoal = parseInt(p.stepGoal,  10);
        const sleepGoal = parseFloat(p.sleepGoal);
        if (sleepGoal > 0) setSleepGoalHrs(sleepGoal);
        setHealthData((prev) => ({
          ...prev,
          water:  goalOz  > 0 ? { ...prev.water,  goalOz  } : prev.water,
          macros: calGoal > 0 ? { ...prev.macros, calGoal } : prev.macros,
          steps:  stepGoal > 0 ? { ...prev.steps, goal: stepGoal } : prev.steps,
        }));
      } catch {}
      // Existing user — introduce Context feature if not yet seen
      checkContextWalkthrough();
      // Show Apple account prompt if not yet linked, subject to re-prompt throttle.
      // Policy: show on first encounter; show once more ≥30 days later; then stop.
      // Permanent sign-in option remains in Profile → Account.
      isAppleLinked().then(async (linked) => {
        if (linked) return;
        try {
          const countRaw = await AsyncStorage.getItem('apple_prompt_dismissed_count');
          const count    = parseInt(countRaw ?? '0', 10);
          if (count >= 2) return;                // permanently suppressed after 2 dismissals
          if (count >= 1) {
            const lastRaw = await AsyncStorage.getItem('apple_prompt_dismissed_at');
            if (lastRaw) {
              const daysSince = (Date.now() - new Date(lastRaw).getTime()) / 86_400_000;
              if (daysSince < 30) return;        // within 30-day cooldown
            }
          }
          setTimeout(() => setShowApplePrompt(true), 1500);
        } catch {}
      }).catch(() => {});
    }).catch(() => {});

    // Request notification permissions and schedule daily reminders (skip during travel mode)
    requestNotificationPermissions().then((granted) => {
      if (!granted) return;
      Promise.all([
        AsyncStorage.getItem('user_profile'),
        AsyncStorage.getItem('vacation_mode'),
      ]).then(([raw, vm]) => {
        if (vm === 'true') return;  // suppress step + water reminders during travel
        const p = raw ? JSON.parse(raw) : {};
        const goalOz  = parseInt(p.waterGoal, 10) || 80;
        const stepGoal = parseInt(p.stepGoal, 10) || 10000;
        scheduleWaterReminder(goalOz).catch(() => {});
        scheduleStepsReminder(stepGoal).catch(() => {});
      }).catch(() => {});
    }).catch(() => {});

    loadOuraAndDrinkLog();
    // Only request HealthKit on mount if profile already exists.
    // New users get HealthKit requested after they save their profile.
    AsyncStorage.getItem('user_profile').then((raw) => {
      if (raw) loadHealthData();
    }).catch(() => {});
    AsyncStorage.getItem('vacation_mode').then((v) => setIsTravelMode(v === 'true')).catch(() => {});
  }, [isExploring]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh today's step count whenever the app returns to the foreground.
  // HealthKit is real-time but there is no live subscription — this closes
  // the gap without polling or changing source selection.
  useEffect(() => {
    if (DEMO_MODE || isExploring) return;
    const appStateRef = { current: AppState.currentState };
    const sub = AppState.addEventListener('change', (nextState) => {
      if (appStateRef.current !== 'active' && nextState === 'active') {
        // Always refresh real-time step count from HealthKit
        getTodaySteps().then((steps) => {
          if (steps > 0) {
            setHealthData((prev) => ({ ...prev, steps: { ...prev.steps, count: steps } }));
          }
        }).catch(() => {});

        // Re-fetch Oura sleep/readiness at most once per 5 minutes so stale overnight
        // data is picked up when the user opens the app in the morning without needing
        // a manual pull-to-refresh.
        const now = Date.now();
        const FIVE_MIN = 5 * 60 * 1000;
        if (now - ouraLastForegroundFetchRef.current > FIVE_MIN) {
          ouraLastForegroundFetchRef.current = now;
          const mySeqFG = ++ouraFetchSeqRef.current;
          getOuraToken().then((token) => {
            if (!token) return;
            return fetchOuraDaily(token).then((oura) => {
              if (mySeqFG !== ouraFetchSeqRef.current) return; // superseded
              if (oura.sleepDate) setOuraSleepDate(oura.sleepDate);
              const sameDayFG = oura.fetchDate === ouraFetchDateRef.current;
              ouraFetchDateRef.current = oura.fetchDate;
              setHealthData((prev) => ({
                ...prev,
                sleep: {
                  ...prev.sleep,
                  score:     oura.sleepScore    > 0 ? oura.sleepScore
                           : (sameDayFG ? prev.sleep.score     : 0),
                  hrv:       oura.hrvAvg        > 0 ? oura.hrvAvg
                           : (sameDayFG ? prev.sleep.hrv       : 0),
                  hours:     oura.sleepHours    > 0 ? oura.sleepHours
                           : (sameDayFG ? prev.sleep.hours     : 0),
                  readiness: oura.readinessScore > 0 ? oura.readinessScore
                           : (sameDayFG ? prev.sleep.readiness : 0),
                },
              }));
            });
          }).catch(() => {});
        }
      }
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, []);

  async function handleRefresh() {
    if (DEMO_MODE || isExploring) { setRefreshing(false); return; }
    setRefreshing(true);
    try {
      const ouraToken = await getOuraToken();
      if (ouraToken) {
        setHasOura(true); // token present = Oura is connected; show button regardless of fetch outcome
        // Increment generation before the request so any slower concurrent fetch
        // (e.g., a foreground transition that started simultaneously) is discarded.
        const mySeqHR = ++ouraFetchSeqRef.current;
        const oura = await fetchOuraDaily(ouraToken);
        if (mySeqHR === ouraFetchSeqRef.current) {
          if (oura.sleepDate) setOuraSleepDate(oura.sleepDate);
          const sameDayHR = oura.fetchDate === ouraFetchDateRef.current;
          ouraFetchDateRef.current = oura.fetchDate;
          setHealthData((prev) => ({
            ...prev,
            sleep: {
              ...prev.sleep,
              score:     oura.sleepScore    > 0 ? oura.sleepScore
                       : (sameDayHR ? prev.sleep.score     : 0),
              hrv:       oura.hrvAvg        > 0 ? oura.hrvAvg
                       : (sameDayHR ? prev.sleep.hrv       : 0),
              hours:     oura.sleepHours    > 0 ? oura.sleepHours
                       : (sameDayHR ? prev.sleep.hours     : 0),
              readiness: oura.readinessScore > 0 ? oura.readinessScore
                       : (sameDayHR ? prev.sleep.readiness : 0),
            },
          }));
        }
      }
    } catch {}
    try {
      const [stepsR, sleepR, hrvR, hrR, workoutsR, waterR] = await Promise.allSettled([
        getTodaySteps(), getLastNightSleep(), getLatestHRV(),
        getRestingHeartRate(), getTodayWorkouts(), getTodayWater(),
      ]);
      const steps        = stepsR.status    === 'fulfilled' ? stepsR.value    : 0;
      const sleepSamples = sleepR.status    === 'fulfilled' ? sleepR.value    : [];
      const hrv          = hrvR.status      === 'fulfilled' ? hrvR.value      : 0;
      const restingHR    = hrR.status       === 'fulfilled' ? hrR.value       : 0;
      const workouts     = workoutsR.status === 'fulfilled' ? workoutsR.value : [];
      const waterOz      = waterR.status    === 'fulfilled' ? waterR.value    : 0;
      setTodayWorkouts(workouts);
      const sleepHours = getSleepHours(sleepSamples);
      const inBedHours = getSleepInBedHours(sleepSamples);
      setHealthData((prev) => ({
        ...prev,
        sleep: {
          hours:      prev.sleep.hours > 0 ? prev.sleep.hours : sleepHours,
          score:      prev.sleep.score,
          hrv:        prev.sleep.hrv > 0 ? prev.sleep.hrv : hrv,
          readiness:  prev.sleep.readiness,
          inBedHours: inBedHours > 0 ? inBedHours : prev.sleep.inBedHours,
          restingHR:  restingHR > 0 ? restingHR : prev.sleep.restingHR,
        },
        steps: { count: steps > 0 ? steps : prev.steps.count, goal: prev.steps.goal },
        water: { oz: waterOz + manualWaterRef.current, goalOz: prev.water.goalOz },
        workout: workouts.length > 0 ? {
          type: workouts.length === 1 ? workouts[0].activityName : `${workouts.length} workouts`,
          duration: workouts.reduce((s, w) => s + w.duration, 0),
          calories: workouts.reduce((s, w) => s + w.calories, 0),
          done: true,
        } : prev.workout,
      }));
    } catch {}
    setRefreshing(false);
  }

  function logWater(oz: number) {
    const next = manualWaterRef.current + oz;
    manualWaterRef.current = next;
    setHealthData((prev) => ({ ...prev, water: { ...prev.water, oz: prev.water.oz + oz } }));
    const today = localDateStr();
    AsyncStorage.setItem('manual_water', JSON.stringify({ date: today, oz: next }));
    appendWaterHistory({ date: today, oz: next }).catch(() => {});
    trackEvent('water_logged', { source_screen: 'home' });
  }

  function handleLogWater() {
    const PRESETS = [8, 12, 16, 24, 32];
    Alert.alert(
      'Log Water',
      'How much did you drink?',
      [
        ...PRESETS.map((oz) => ({ text: `${oz} oz`, onPress: () => logWater(oz) })),
        {
          text: 'Custom',
          onPress: () =>
            Alert.prompt(
              'Custom Amount',
              'Enter ounces',
              (val) => {
                const oz = parseInt(val, 10);
                if (oz > 0) logWater(oz);
              },
              'plain-text',
              '',
              'numeric',
            ),
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }

  /** Build source items for a metric sheet. Includes relevant companion apps the user has enabled. */
  function buildSources(metric: MetricType, fixed: SourceItem[]): SourceItem[] {
    const relevant = COMPANION_RELEVANCE[metric];
    const extras = relevant
      .filter((app) => companionApps.includes(app))
      .map((app) => ({
        key: app,
        label: `Open in ${COMPANION_LABELS[app]}`,
        onPress: () => { COMPANION_OPENERS[app](); },
      }));
    return [...fixed, ...extras];
  }

  const palette =
    userTheme === 'mauve'   ? (isDark ? PALETTE_FEMALE_DARK  : PALETTE_FEMALE)  :
    userTheme === 'forest'  ? (isDark ? PALETTE_MALE_DARK    : PALETTE_MALE)    :
                              (isDark ? PALETTE_NEUTRAL_DARK : PALETTE_NEUTRAL);
  const { sleep, steps, macros, workout, water, hadAlcoholLastNight } = healthData;
  const tg = resolveTravelGoals(isTravelMode, steps.goal, water.goalOz, sleepGoalHrs);

  // ── Widget snapshot ───────────────────────────────────────────────────────
  // Writes the latest health state to shared App Group UserDefaults so
  // WidgetKit can display it without independent HealthKit access.
  useEffect(() => {
    if (DEMO_MODE || isExploring) return;
    writeWidgetSnapshot({
      steps:       steps.count  > 0 ? steps.count  : undefined,
      stepGoal:    steps.goal   > 0 ? steps.goal   : undefined,
      waterOz:     water.oz,
      waterGoalOz: water.goalOz > 0 ? water.goalOz : undefined,
      sleepHours:  sleep.hours  > 0 ? sleep.hours  : undefined,
      sleepDate:   ouraSleepDate ?? undefined,
      accentHex:   palette.accent,
    }).catch(() => {});
  }, [healthData, ouraSleepDate, palette.accent, isExploring]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PaletteContext.Provider value={palette}>
    <View style={[styles.container, { backgroundColor: palette.background }]}>

      <SafeAreaView style={styles.safeArea}>

        {/* ── Editorial header ─────────────────────────────── */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <View style={styles.greetingRow}>
              <ThemedText style={[styles.greetingWord, { color: palette.textSecondary }]}>
                {getGreetingWord()},{' '}
              </ThemedText>
              <ThemedText style={[styles.greetingName, { color: palette.text }]}>
                {userName}
              </ThemedText>
            </View>
          </View>
          <TouchableOpacity onPress={() => setMenuOpen(true)} activeOpacity={0.7} style={styles.menuBtn}>
            <SymbolView name="person.circle" size={26} tintColor={palette.textSecondary} weight="light" type="monochrome" />
          </TouchableOpacity>
        </View>

        {/* ── DEMO MODE banner — dev-only, never ships to production ── */}
        {DEMO_MODE && (
          <View style={{ backgroundColor: '#CC2200', paddingVertical: 7, alignItems: 'center' }}>
            <ThemedText style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '700', letterSpacing: 1.5 }}>
              DEMO MODE — SYNTHETIC DATA
            </ThemedText>
          </View>
        )}

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={palette.textSecondary} />}
        >

          {/* SETUP BANNER — shown only until profile is saved ── */}
          {!hasProfile && (
            <TouchableOpacity
              style={[styles.setupBanner, { backgroundColor: palette.card, borderColor: palette.accent }]}
              onPress={() => setProfileOpen(true)}
              activeOpacity={0.75}
            >
              <View style={{ flex: 1 }}>
                <ThemedText style={[styles.setupBannerOverline, { color: palette.accent }]}>GET STARTED</ThemedText>
                <ThemedText style={[styles.setupBannerTitle, { color: palette.text }]}>Set up your profile</ThemedText>
                <ThemedText style={[styles.setupBannerSub, { color: palette.textSecondary }]}>
                  Add your name, goals, and connect your devices to personalize your dashboard.
                </ThemedText>
              </View>
              <ThemedText style={[styles.setupBannerArrow, { color: palette.accent }]}>→</ThemedText>
            </TouchableOpacity>
          )}

          {/* EXPLORE MODE BANNER — shown while user is browsing sample data ── */}
          {isExploring && (
            <TouchableOpacity
              style={[styles.exploreBanner, { backgroundColor: palette.accent + '12', borderColor: palette.accent + '40' }]}
              onPress={() => exitExploring()}
              activeOpacity={0.75}
            >
              <View style={{ flex: 1 }}>
                <ThemedText style={[styles.exploreBannerTitle, { color: palette.text }]}>Exploring sample data</ThemedText>
                <ThemedText style={[styles.exploreBannerSub, { color: palette.textSecondary }]}>
                  Tap to set up with your own data →
                </ThemedText>
              </View>
            </TouchableOpacity>
          )}

          {/* TRAVEL MODE INDICATOR — shown when vacation_mode is enabled ── */}
          {isTravelMode && (
            <View style={[styles.travelBanner, { backgroundColor: palette.accent + '0F', borderColor: palette.accent + '35' }]}>
              <ThemedText style={[styles.travelBannerTitle, { color: palette.text }]}>✈  Travel mode</ThemedText>
              <ThemedText style={[styles.travelBannerSub, { color: palette.textSecondary }]}>Goals are relaxed while you're away.</ThemedText>
            </View>
          )}

          {/* SLEEP + RECOVERY ──────────────────────────────── */}
          <Rule />
          <View style={styles.section}>
            <View style={styles.sleepLayout}>
              {/* Left column: SLEEP */}
              <View style={styles.sleepLeft}>
                <SectionHead label="SLEEP" />
                <TouchableOpacity
                  onPress={() => setSourceSheet({
                    title: 'View sleep details',
                    sources: buildSources('sleep', [
                      ...(hasOura ? [{ key: 'oura', label: 'Open in Oura', onPress: () => openOura() }] : []),
                      { key: 'appleHealth', label: 'Open in Apple Health', onPress: () => showAppleHealthPath('sleep') },
                    ]),
                  })}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Sleep ${sleep.hours > 0 ? `${sleep.hours} hours` : ''}${sleep.score > 0 ? `, score ${sleep.score}` : ''}`}
                  accessibilityHint="Double tap to view source details"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <View style={styles.valueRow}>
                    <ThemedText style={[styles.primaryValue, { color: palette.text }]}>
                      {sleep.hours > 0 ? `${sleep.hours}h` : '—'}
                    </ThemedText>
                    <ThemedText style={[styles.primaryValueSub, { color: palette.textSecondary }]}>
                      {' / '}{tg.sleepGoalHrs}h
                    </ThemedText>
                  </View>
                  {hasOura && sleep.score > 0 && (
                    <ThemedText style={[styles.metaText, { color: palette.textSecondary }]}>
                      score {sleep.score}
                    </ThemedText>
                  )}
                </TouchableOpacity>
              </View>

              {/* Right column: RECOVERY — readiness only; HRV + RHR move to secondary row */}
              {(hasOura || sleep.hrv > 0 || sleep.restingHR > 0) && (
                <View style={styles.sleepRight}>
                  <SectionHead label="RECOVERY" />
                  <TouchableOpacity
                    onPress={() => hasOura ? setSourceSheet({
                      title: 'View readiness details',
                      sources: buildSources('readiness', [
                        { key: 'oura', label: 'Open in Oura', onPress: () => openOura() },
                      ]),
                    }) : undefined}
                    activeOpacity={hasOura && sleep.readiness > 0 ? 0.7 : 1}
                    accessibilityRole="button"
                    accessibilityLabel={sleep.readiness > 0 ? `Readiness ${sleep.readiness}` : 'Readiness unavailable'}
                    hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
                  >
                    <ThemedText style={[styles.primaryValue, { color: palette.text }]}>
                      {sleep.readiness > 0 ? `${sleep.readiness}` : '—'}
                    </ThemedText>
                    <ThemedText style={[styles.metaText, { color: palette.textSecondary }]}>
                      readiness
                    </ThemedText>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {/* Secondary recovery row — HRV + Resting HR inline, left/right aligned */}
            {(sleep.hrv > 0 || sleep.restingHR > 0) && (
              <View style={styles.sleepSecondaryRow}>
                {sleep.hrv > 0 ? (
                  <TouchableOpacity
                    style={styles.sleepInlineMetric}
                    onPress={() => setSourceSheet({
                      title: 'View HRV details',
                      sources: buildSources('hrv', [
                        ...(hasOura ? [{ key: 'oura', label: 'Open in Oura', onPress: () => openOura() }] : []),
                        { key: 'appleHealth', label: 'Open in Apple Health', onPress: () => showAppleHealthPath('hrv') },
                      ]),
                    })}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`HRV ${sleep.hrv} milliseconds`}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <ThemedText style={[styles.sleepMetricLabel, { color: palette.textSecondary }]}>HRV</ThemedText>
                    <ThemedText style={[styles.sleepInlineVal, { color: palette.text }]}>{sleep.hrv} ms</ThemedText>
                  </TouchableOpacity>
                ) : <View style={styles.sleepInlineMetric} />}
                {sleep.restingHR > 0 && (
                  <TouchableOpacity
                    style={[styles.sleepInlineMetric, styles.sleepInlineMetricRight]}
                    onPress={() => setSourceSheet({
                      title: 'View resting heart rate details',
                      sources: buildSources('restingHR', [
                        { key: 'appleHealth', label: 'Open in Apple Health', onPress: () => showAppleHealthPath('heartRate') },
                      ]),
                    })}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Resting heart rate ${sleep.restingHR} bpm`}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <ThemedText style={[styles.sleepMetricLabel, { color: palette.textSecondary }]}>RESTING HR</ThemedText>
                    <ThemedText style={[styles.sleepInlineVal, { color: palette.text }]}>{sleep.restingHR} bpm</ThemedText>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>

          {/* MOVEMENT ──────────────────────────────────────── */}
          <Rule />
          <View style={styles.section}>
            <SectionHead label="MOVEMENT" />
            {/* Step count — tappable to view source */}
            <TouchableOpacity
              onPress={() => setSourceSheet({
                title: 'View step details',
                sources: buildSources('steps', [
                  ...(hasOura ? [{ key: 'oura', label: 'Open in Oura', onPress: () => openOura() }] : []),
                  { key: 'appleHealth', label: 'Open in Apple Health', onPress: () => showAppleHealthPath('steps') },
                ]),
              })}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Steps ${steps.count > 0 ? steps.count.toLocaleString() : '—'}`}
              accessibilityHint="Double tap to view source details"
              hitSlop={{ top: 8, bottom: 4, left: 8, right: 8 }}
            >
              <ThemedText style={[styles.primaryValue, { color: palette.text }]}>
                {steps.count > 0 ? steps.count.toLocaleString() : '—'}
              </ThemedText>
              <ThemedText style={[styles.metaText, { color: palette.textSecondary }]}>
                steps  ·  goal {tg.stepGoal.toLocaleString()}
              </ThemedText>
            </TouchableOpacity>
            <View style={styles.stepsBarWrap}>
              <StepsBar steps={steps.count} goal={tg.stepGoal} />
            </View>
          </View>

          {/* HYDRATION ─────────────────────────────────────── */}
          <Rule />
          <View style={styles.section}>
            <SectionHead label="HYDRATION" actionLabel="Log Caffeine →" onAction={() => setCaffeineOpen(true)} />
            <View style={styles.valueRow}>
              <ThemedText style={[styles.primaryValue, { color: palette.text }]}>{water.oz}</ThemedText>
              <ThemedText style={[styles.primaryValueSub, { color: palette.textSecondary }]}>
                {' oz  /  '}{tg.waterGoal}
              </ThemedText>
            </View>
            <ThemedText style={[styles.metaText, { color: palette.textSecondary }]}>
              {water.oz < tg.waterGoal ? `${tg.waterGoal - water.oz} oz remaining` : 'Daily goal reached'}
            </ThemedText>
            <ThinProgress value={water.oz} total={tg.waterGoal} />
            <View style={styles.inlineActionRow}>
              <TouchableOpacity onPress={handleLogWater} activeOpacity={0.7}>
                <ThemedText style={[styles.inlineAction, { color: palette.accent }]}>+ Log Water</ThemedText>
              </TouchableOpacity>
              <ThemedText style={[styles.actionDot, { color: palette.divider }]}>·</ThemedText>
              <TouchableOpacity
                onPress={() => {
                  const next = !electrolytesLogged;
                  setElectrolytesLogged(next);
                  const todayDate = localDateStr();
                  AsyncStorage.setItem('electrolytes_log', JSON.stringify({ date: todayDate, logged: next }));
                  // Append to history for pattern engine (only on log, not un-log)
                  if (next) {
                    AsyncStorage.getItem('electrolytes_history').then((raw) => {
                      const hist: Array<{ date: string }> = raw ? JSON.parse(raw) : [];
                      if (!hist.some((e) => e.date === todayDate)) {
                        AsyncStorage.setItem('electrolytes_history', JSON.stringify([...hist, { date: todayDate }]));
                      }
                    }).catch(() => {});
                  } else {
                    // Remove today's entry if un-logging
                    AsyncStorage.getItem('electrolytes_history').then((raw) => {
                      const hist: Array<{ date: string }> = raw ? JSON.parse(raw) : [];
                      AsyncStorage.setItem('electrolytes_history', JSON.stringify(hist.filter((e) => e.date !== todayDate)));
                    }).catch(() => {});
                  }
                }}
                activeOpacity={0.7}
              >
                <ThemedText style={[styles.inlineAction, { color: electrolytesLogged ? palette.accent : palette.textSecondary }]}>
                  {electrolytesLogged ? 'Electrolytes ✓' : 'Log electrolytes →'}
                </ThemedText>
              </TouchableOpacity>
            </View>
          </View>

          {/* NUTRITION ─────────────────────────────────────── */}
          <Rule />
          <View style={styles.section}>
            <SectionHead label="NUTRITION" actionLabel="My Meals →" onAction={() => setMealsOpen(true)} />
            {tg.caloriesRelaxed ? (
              <ThemedText style={[styles.primaryValue, { color: palette.text }]}>Relaxed</ThemedText>
            ) : macros.calories === 0 && macros.protein === 0 && macros.carbs === 0 && macros.fat === 0 ? (
              <ThemedText style={[styles.metaText, { color: palette.textSecondary }]}>
                No meals logged yet
              </ThemedText>
            ) : (
              <>
                <View style={styles.valueRow}>
                  <ThemedText style={[styles.primaryValue, { color: palette.text }]}>{macros.calories}</ThemedText>
                  <ThemedText style={[styles.primaryValueSub, { color: palette.textSecondary }]}>
                    {` / ${workout.done && workout.calories > 0 ? macros.calGoal + Math.round(workout.calories * 0.5) : macros.calGoal} kcal`}
                  </ThemedText>
                </View>
                {workout.done && workout.calories > 0 && (
                  <ThemedText style={[styles.metaText, { color: palette.textSecondary }]}>
                    adjusted for workout (+½ burn)
                  </ThemedText>
                )}
                <View style={styles.metricRow}>
                  <MetricPair label="PROTEIN" value={`${fmtMacro(macros.protein)}g`} />
                  <MetricPair label="CARBS" value={`${fmtMacro(macros.carbs)}g`} />
                  <MetricPair label="FAT" value={`${fmtMacro(macros.fat)}g`} />
                </View>
              </>
            )}
          </View>

          {/* WORKOUT ───────────────────────────────────────── */}
          <Rule />
          <View style={styles.section}>
            <SectionHead label="WORKOUT" />
            {/* Workout content — tappable to view source */}
            <TouchableOpacity
              onPress={() => setSourceSheet({
                title: 'View workout details',
                sources: buildSources('workout', [
                  ...(hasOura ? [{ key: 'oura', label: 'Open in Oura', onPress: () => openOura() }] : []),
                  { key: 'appleHealth', label: 'Open in Apple Health', onPress: () => showAppleHealthPath('workouts') },
                ]),
              })}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={workout.done ? `Workout: ${workout.type}, ${workout.duration} minutes, ${workout.calories} calories` : 'No workout logged today'}
              accessibilityHint="Double tap to view source details"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <ThemedText style={[styles.primaryValue, { color: palette.text }]}>
                {workout.done ? workout.type : '—'}
              </ThemedText>
              {workout.done ? (
                <View style={styles.metricRow}>
                  <MetricPair label="DURATION" value={`${workout.duration} min`} />
                  <MetricPair label="BURN" value={`${workout.calories} kcal`} />
                </View>
              ) : (
                <ThemedText style={[styles.metaText, { color: palette.textSecondary }]}>
                  no workout logged today
                </ThemedText>
              )}
            </TouchableOpacity>
          </View>

          {/* CYCLE & HORMONES — female only ─────────────────── */}
          {!isMale && (
            <>
              <Rule />
              <View style={styles.section}>
                <SectionHead
                  label="CYCLE & HORMONES"
                  actionLabel={todayCycleEntry ? 'Edit →' : 'Log Today →'}
                  onAction={() => setCycleOpen(true)}
                />
                {cycleDayCount !== null && (
                  <ThemedText style={[styles.cycleDayValue, { color: palette.accent }]}>
                    {'Day '}{cycleDayCount + 1}
                    <ThemedText style={[styles.cycleDaySub, { color: palette.textSecondary }]}>{' of your cycle'}</ThemedText>
                  </ThemedText>
                )}
                {todayCycleEntry ? (
                  <ThemedText style={[styles.metaText, { color: palette.textSecondary }]}>
                    Energy {['','Drained','Tired','Okay','Good','Great'][todayCycleEntry.energy]}
                    {'  ·  '}
                    Stress {['','Calm','Mild','Moderate','High','Very High'][todayCycleEntry.stress]}
                  </ThemedText>
                ) : (
                  <ThemedText style={[styles.metaText, { color: palette.textSecondary }]}>
                    {cycleDayCount !== null ? 'tap to log energy & stress' : 'tap to set up cycle tracking'}
                  </ThemedText>
                )}
              </View>
            </>
          )}

          {/* ── Quick Context ────────────────────────────────── */}
          <Rule />
          <View style={styles.quickContextSection}>
            <ThemedText style={[styles.quickContextLabel, { color: palette.textSecondary }]}>Quick Context</ThemedText>

            {/* Having drinks — martini glass (female) / whiskey tumbler (male) */}
            <TouchableOpacity onPress={() => setDrinkingOpen(true)} activeOpacity={0.75}
              style={[styles.qcCard, { backgroundColor: palette.accent + '12', borderColor: palette.accent + '30', shadowColor: palette.shadow }]}>
              <View style={[styles.qcIconCircle, { backgroundColor: palette.accent + '20' }]}>
                <MaterialCommunityIcons name="glass-cocktail" size={20} color={palette.accent} />
              </View>
              <View style={styles.qcTextBlock}>
                <ThemedText style={[styles.qcTitle, { color: palette.text }]}>Having drinks</ThemedText>
                <ThemedText style={[styles.qcSub,   { color: palette.textSecondary }]}>drinks · vibes · calories</ThemedText>
              </View>
              <View style={[styles.qcChevronCircle, { backgroundColor: palette.accent + '18' }]}>
                <SymbolView name="chevron.right" size={11} tintColor={palette.accent} weight="light" type="monochrome" />
              </View>
            </TouchableOpacity>

            {/* Treat yourself — sun/warmth (sauna heat) */}
            <TouchableOpacity onPress={() => setWellnessOpen(true)} activeOpacity={0.75}
              style={[styles.qcCard, { backgroundColor: palette.accent + '12', borderColor: palette.accent + '30', shadowColor: palette.shadow }]}>
              <View style={[styles.qcIconCircle, { backgroundColor: palette.accent + '20' }]}>
                <Feather name="thermometer" size={20} color={palette.accent} />
              </View>
              <View style={styles.qcTextBlock}>
                <ThemedText style={[styles.qcTitle, { color: palette.text }]}>Treat yourself</ThemedText>
                <ThemedText style={[styles.qcSub,   { color: palette.textSecondary }]}>sauna · cold plunge</ThemedText>
              </View>
              <View style={[styles.qcChevronCircle, { backgroundColor: palette.accent + '18' }]}>
                <SymbolView name="chevron.right" size={11} tintColor={palette.accent} weight="light" type="monochrome" />
              </View>
            </TouchableOpacity>

            {/* Take a minute — wind/breath (exhale, settle, ground) */}
            <TouchableOpacity onPress={() => setGroundingOpen(true)} activeOpacity={0.75}
              style={[styles.qcCard, { backgroundColor: palette.accent + '12', borderColor: palette.accent + '30', shadowColor: palette.shadow }]}>
              <View style={[styles.qcIconCircle, { backgroundColor: palette.accent + '20' }]}>
                <Feather name="wind" size={19} color={palette.accent} />
              </View>
              <View style={styles.qcTextBlock}>
                <ThemedText style={[styles.qcTitle, { color: palette.text }]}>Take a minute</ThemedText>
                <ThemedText style={[styles.qcSub,   { color: palette.textSecondary }]}>breathing · gratitude · grounding</ThemedText>
              </View>
              <View style={[styles.qcChevronCircle, { backgroundColor: palette.accent + '18' }]}>
                <SymbolView name="chevron.right" size={11} tintColor={palette.accent} weight="light" type="monochrome" />
              </View>
            </TouchableOpacity>

          </View>

        </ScrollView>
      </SafeAreaView>

      {/* ── Modals ── */}
      {menuOpen && <MenuModal
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        onOpenScreen={(screen) => {
          setMenuOpen(false);
          if (screen === 'profile')   setTimeout(() => setProfileOpen(true), 350);
          if (screen === 'chat')      setTimeout(() => setChatOpen(true), 350);
          if (screen === 'documents') setTimeout(() => setDocumentsOpen(true), 350);
          if (screen === 'training')  setTimeout(() => setTrainingOpen(true), 350);
          if (screen === 'vacation')  setTimeout(() => setVacationOpen(true), 350);
          if (screen === 'support')   setTimeout(() => setSupportOpen(true), 350);
        }}
      />}
      {profileOpen && <ProfileModal
        visible={profileOpen}
        onClose={() => setProfileOpen(false)}
        onProfileSave={(profile) => {
          const isFirstSave = !hasProfile;
          setHasProfile(true);
          if (isFirstSave) trackEvent('onboarding_completed', { source_screen: 'profile' });
          if (profile.name) setUserName(profile.name);
          if (profile.supplements !== undefined) setSupplements(profile.supplements);
          if (profile.gender?.toLowerCase().startsWith('m')) setIsMale(true);
          else if (profile.gender) setIsMale(false);
          const goalOz  = parseInt(profile.waterGoal, 10);
          const calGoal = parseInt(profile.calGoal,   10);
          const stepGoal = parseInt(profile.stepGoal, 10);
          setHealthData((prev) => ({
            ...prev,
            water:  goalOz  > 0 ? { ...prev.water,  goalOz  } : prev.water,
            macros: calGoal > 0 ? { ...prev.macros, calGoal } : prev.macros,
            steps:  stepGoal > 0 ? { ...prev.steps, goal: stepGoal } : prev.steps,
          }));
          // First-time save: request HealthKit access now that the user has context,
          // then load their data immediately
          if (isFirstSave) {
            initHealthKit().then(() => handleRefresh()).catch(() => {});
          }
        }}
      />}
      {chatOpen      && <ChatModal      visible={chatOpen}       onClose={() => setChatOpen(false)} healthData={healthData} userName={userName} isMale={isMale} supplements={supplements} />}
      {supportOpen   && <SupportModal   visible={supportOpen}    onClose={() => setSupportOpen(false)} />}
      {documentsOpen && <DocumentsModal visible={documentsOpen}  onClose={() => setDocumentsOpen(false)} />}
      {trainingOpen  && <TrainingModal  visible={trainingOpen}   onClose={() => {
          setTrainingOpen(false);
          AsyncStorage.getItem('user_profile').then((raw) => {
            if (!raw) return;
            try {
              const p = JSON.parse(raw);
              const goalOz   = parseInt(p.waterGoal, 10);
              const calGoal  = parseInt(p.calGoal,   10);
              const stepGoal = parseInt(p.stepGoal,  10);
              const sleepGoal = parseFloat(p.sleepGoal);
              if (sleepGoal > 0) setSleepGoalHrs(sleepGoal);
              setHealthData((prev) => ({
                ...prev,
                water:  goalOz   > 0 ? { ...prev.water,  goalOz  } : prev.water,
                macros: calGoal  > 0 ? { ...prev.macros, calGoal } : prev.macros,
                steps:  stepGoal > 0 ? { ...prev.steps,  goal: stepGoal } : prev.steps,
              }));
            } catch {}
          }).catch(() => {});
        }} />}
      {vacationOpen && <TravelModal visible={vacationOpen} onClose={() => setVacationOpen(false)} onModeChange={(enabled) => {
        setIsTravelMode(enabled);
        if (enabled) {
          cancelGoalReminders().catch(() => {});
        } else {
          AsyncStorage.getItem('user_profile').then((raw) => {
            const p = raw ? JSON.parse(raw) : {};
            const goalOz  = parseInt(p.waterGoal, 10) || 80;
            const stepGoal = parseInt(p.stepGoal, 10) || 10000;
            scheduleWaterReminder(goalOz).catch(() => {});
            scheduleStepsReminder(stepGoal).catch(() => {});
          }).catch(() => {});
        }
      }} />}
      {mealsOpen && <MealsModal
        visible={mealsOpen}
        onClose={() => setMealsOpen(false)}
        onMealLogged={(totals, date) => {
          // Only update today's dashboard macros; backdated entries don't affect today's display
          if (date === localDateStr()) {
            setHealthData((prev) => ({ ...prev, macros: { ...prev.macros, ...totals } }));
          }
        }}
      />}
      {wellnessOpen && <WellnessModal
        visible={wellnessOpen}
        onClose={() => setWellnessOpen(false)}
        postWorkout={workout.done}
        watchSessions={todayWorkouts.map((w, i) => ({
          id: String(i),
          name: w.activityName,
          duration: w.duration,
          time: w.startDate ? new Date(w.startDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
          calories: w.calories,
        }))}
      />}
      {groundingOpen && <GroundingModal visible={groundingOpen} onClose={() => setGroundingOpen(false)} />}
      {cycleOpen && <CycleModal
        visible={cycleOpen}
        onClose={() => {
          setCycleOpen(false);
          const today = localDateStr();
          Promise.all([loadCycleEntries(), loadCycleProfile()]).then(([entries, profile]) => {
            setTodayCycleEntry(entries.find((e) => e.date === today) ?? null);
            if (profile.lastPeriodDate) {
              const days = Math.floor((Date.now() - new Date(profile.lastPeriodDate + 'T00:00:00').getTime()) / 86400000);
              setCycleDayCount(days);
            }
          }).catch(() => {});
        }}
        onEntrySaved={() => {
          const today = localDateStr();
          loadCycleEntries().then((entries) => setTodayCycleEntry(entries.find((e) => e.date === today) ?? null)).catch(() => {});
        }}
      />}
      {caffeineOpen && <CaffeineModal
        visible={caffeineOpen}
        onClose={() => setCaffeineOpen(false)}
        sleepScore={sleep.score}
        hrv={sleep.hrv}
        waterOz={water.oz}
        hadAlcoholLastNight={hadAlcoholLastNight}
      />}
      {drinkingOpen && <DrinkingModal
        visible={drinkingOpen}
        onClose={() => setDrinkingOpen(false)}
        sleepScore={sleep.score}
        hrv={sleep.hrv}
        waterOz={water.oz}
        workoutDone={workout.done}
      />}

      {/* ── Source picker sheet ── */}
      <MetricSourceSheet
        visible={!!sourceSheet}
        title={sourceSheet?.title ?? ''}
        sources={sourceSheet?.sources ?? []}
        onDismiss={() => setSourceSheet(null)}
      />

      {/* ── Apple account prompt — re-prompt throttled; permanent option in Profile ── */}
      <AppleAccountPrompt
        visible={showApplePrompt}
        onDismiss={(linked) => {
          setShowApplePrompt(false);
          if (linked) {
            trackEvent('apple_linked_from_prompt', { source_screen: 'home' });
          } else {
            // Record dismissal so the prompt respects the 30-day / 2-strike cooldown
            AsyncStorage.getItem('apple_prompt_dismissed_count').then((raw) => {
              const next = (parseInt(raw ?? '0', 10) + 1).toString();
              return AsyncStorage.multiSet([
                ['apple_prompt_dismissed_count', next],
                ['apple_prompt_dismissed_at', new Date().toISOString()],
              ]);
            }).catch(() => {});
          }
        }}
      />

      {/* ── New user onboarding flow ── */}
      <OnboardingFlow
        visible={showOnboarding}
        onComplete={(apps) => {
          setShowOnboarding(false);
          setCompanionApps(apps);
          initHealthKit().then(() => handleRefresh()).catch(() => {});
          // Introduce the new Context feature after onboarding completes
          setTimeout(() => setShowWhatsNew(true), 600);
        }}
        onExplore={() => {
          setShowOnboarding(false);
          startExploring();
        }}
      />

      {/* ── One-time companion app setup prompt ── */}
      <CompanionPrompt
        visible={showCompanionPrompt}
        onDone={(apps) => {
          setCompanionApps(apps);
          setShowCompanionPrompt(false);
          // Persist to profile so this prompt never fires again
          AsyncStorage.getItem('user_profile').then((raw) => {
            const p = raw ? JSON.parse(raw) : {};
            AsyncStorage.setItem('user_profile', JSON.stringify({ ...p, companionApps: apps }));
          }).catch(() => {});
        }}
      />

      {/* ── "What's New: Context" announcement (shown once, existing + new users) ── */}
      <WhatsNewContext
        visible={showWhatsNew}
        onExplore={() => {
          AsyncStorage.setItem(WHATS_NEW_KEY, '1').catch(() => {});
          setShowWhatsNew(false);
          router.navigate('/context');
        }}
        onDismiss={() => {
          AsyncStorage.setItem(WHATS_NEW_KEY, '1').catch(() => {});
          setShowWhatsNew(false);
        }}
      />
    </View>
    </PaletteContext.Provider>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea:  { flex: 1, paddingHorizontal: Spacing.three },

  // ── Setup banner ────────────────────────────────────────
  setupBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: Spacing.three,
    marginBottom: Spacing.three,
    gap: Spacing.two,
  },
  setupBannerOverline: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase', marginBottom: 4 },
  setupBannerTitle:    { fontFamily: Fonts.serif, fontSize: 20, fontStyle: 'italic', fontWeight: '400', marginBottom: 4 },
  setupBannerSub:      { fontSize: 13, lineHeight: 18 },
  setupBannerArrow:    { fontSize: 22, fontWeight: '300' },

  // ── Explore Mode banner ───────────────────────────────
  exploreBanner: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: Spacing.three,
    paddingVertical: 10,
    marginBottom: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
  },
  exploreBannerTitle: { fontSize: 13, fontWeight: '500' as const },
  exploreBannerSub:   { fontSize: 12, lineHeight: 17, marginTop: 1 },

  // ── Travel Mode indicator ─────────────────────────────
  travelBanner: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: Spacing.three,
    paddingVertical: 6,
    marginBottom: Spacing.three,
    gap: 2,
  },
  travelBannerTitle: { fontSize: 13, fontWeight: '500' as const },
  travelBannerSub:   { fontSize: 12, lineHeight: 17 },

  // ── Header ──────────────────────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  greetingRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
  },
  greetingWord: {
    fontFamily: Fonts.serif,
    fontSize: 18,
    fontStyle: 'italic',
    lineHeight: 26,
    fontWeight: '400',
  },
  greetingName: {
    fontFamily: Fonts.serif,
    fontSize: 26,
    fontWeight: '400',
    fontStyle: 'italic',
    lineHeight: 32,
  },
  menuBtn: { paddingLeft: 8 },

  // ── Scroll ──────────────────────────────────────────────
  scroll: { paddingBottom: 120 },

  // ── Section anatomy ─────────────────────────────────────
  rule: { height: StyleSheet.hairlineWidth },
  section: {
    paddingVertical: Spacing.three,
    gap: Spacing.two,
  },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionLabel: {
    fontSize: 9,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
  },
  asideBlock: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  asideValue: { fontFamily: Fonts.serif, fontSize: 18, fontWeight: '400' },
  asideUnit:  { fontSize: 10, letterSpacing: 0.5 },
  actionLink: { fontSize: 11, fontWeight: '500', letterSpacing: 0.3 },

  // ── Typography ──────────────────────────────────────────
  primaryValue: {
    fontFamily: Fonts.serif,
    fontSize: 38,
    fontWeight: '400',
    lineHeight: 44,
  },
  primaryValueSub: {
    fontFamily: Fonts.serif,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 44,
    alignSelf: 'flex-end',
    paddingBottom: 2,
  },
  valueRow: { flexDirection: 'row', alignItems: 'flex-end' },
  metaText: {
    fontSize: 12,
    fontStyle: 'italic',
    letterSpacing: 0.2,
    lineHeight: 18,
  },

  // ── Metric clusters ─────────────────────────────────────
  metricRow: {
    flexDirection: 'row',
    gap: Spacing.four,
    flexWrap: 'wrap',
    marginTop: Spacing.one,
  },
  metricPair: { gap: 3 },
  metricLabel: {
    fontSize: 9,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  metricValue: { fontSize: 14, fontWeight: '600', letterSpacing: 0.2 },

  // ── Sleep two-column layout ──────────────────────────────
  sleepLayout: {
    flexDirection: 'row',
    gap: Spacing.four,
    alignItems: 'flex-start',
  },
  sleepLeft: { flex: 1 },
  sleepRight: {
    gap: Spacing.two,
    alignItems: 'flex-end',
    paddingRight: Spacing.two,   // 8px — italic glyphs lean right
  },
  sleepMetricLabel: { fontSize: 9, letterSpacing: 2, textTransform: 'uppercase' },
  // Secondary row: HRV + RESTING HR displayed inline (label + value side-by-side)
  sleepSecondaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.three,
  },
  sleepInlineMetric: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 7,
  },
  sleepInlineMetricRight: {
    justifyContent: 'flex-end',
  },
  sleepInlineVal: {
    fontSize: 9,
    letterSpacing: 1.5,
    paddingRight: 4,
  },

  // ── Cycle ────────────────────────────────────────────────
  cycleDayValue: {
    fontFamily: Fonts.serif,
    fontSize: 22,
    fontStyle: 'italic',
    lineHeight: 28,
  },
  cycleDaySub: {
    fontFamily: Fonts.serif,
    fontSize: 14,
    fontStyle: 'italic',
    lineHeight: 28,
  },

  // ── Steps bar wrap ──────────────────────────────────────
  stepsBarWrap: { marginTop: Spacing.one },

  // ── Thin progress track ─────────────────────────────────
  progressTrack: {
    height: 2,
    borderRadius: 1,
    overflow: 'hidden',
    marginTop: Spacing.one,
  },
  progressFill: { height: '100%', borderRadius: 1 },

  // ── Inline actions ──────────────────────────────────────
  inlineActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    marginTop: Spacing.one,
  },
  inlineAction: { fontSize: 12, fontWeight: '500', letterSpacing: 0.3 },
  actionDot:    { fontSize: 16 },

  // ── Quick Context elevated cards ──────────────────────────
  quickContextSection: { paddingTop: Spacing.two, paddingBottom: Spacing.three },
  quickContextLabel: {
    fontSize: 9,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    marginBottom: Spacing.three,
  },
  qcCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: Spacing.two,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.35,
    shadowRadius: 3,
    elevation: 2,
  },
  qcIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  qcTextBlock: { flex: 1 },
  qcTitle: {
    fontFamily: Fonts.serif,
    fontSize: 17,
    fontStyle: 'italic',
    fontWeight: '400',
  },
  qcSub: { fontSize: 11, letterSpacing: 0.2, marginTop: 2 },
  qcChevronCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: Spacing.two,
  },
});
