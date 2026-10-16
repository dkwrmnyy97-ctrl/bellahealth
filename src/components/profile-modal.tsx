import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Modal, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { clearOuraToken, initiateOuraConnect } from '@/services/oura';
import { trackEvent } from '@/services/analytics';
import { deleteAccount, signOut } from '@/services/auth';
import { syncProfile } from '@/services/cloud-sync';
import { signInWithApple, isAppleLinked } from '@/services/apple-auth';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';
import { calcGoalsFromProfile, calcGoalsFromTraining, calcWaterGoalOz, getHealthKitProfile, inchesToDisplay } from '@/services/healthkit';

const PRIVACY_POLICY_URL = 'https://bellahealth-beta.netlify.app/privacy';

type Pal = ReturnType<typeof getModalPalette>;

function SectionTitle({ label, pal }: { label: string; pal: Pal }) {
  return (
    <ThemedText style={[styles.sectionTitle, { color: pal.textSecondary }]}>{label}</ThemedText>
  );
}

function Field({ label, value, onChangeText, placeholder, keyboardType, pal, last }: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric';
  pal: Pal;
  last?: boolean;
}) {
  return (
    <View style={[styles.field, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: pal.divider }]}>
      <ThemedText style={[styles.fieldLabel, { color: pal.text }]}>{label}</ThemedText>
      <TextInput
        style={[styles.fieldInput, { color: pal.text }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? '—'}
        placeholderTextColor={pal.textSecondary}
        keyboardType={keyboardType ?? 'default'}
      />
    </View>
  );
}

function ToggleField({ label, options, value, onChange, pal, last }: {
  label: string; options: string[]; value: string; onChange: (v: string) => void; pal: Pal; last?: boolean;
}) {
  return (
    <View style={[styles.toggleField, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: pal.divider }]}>
      <ThemedText style={[styles.fieldLabel, { color: pal.text }]}>{label}</ThemedText>
      <View style={styles.toggleOptions}>
        {options.map((opt) => (
          <TouchableOpacity
            key={opt}
            style={[
              styles.toggleBtn,
              { borderColor: pal.divider },
              value === opt && { borderColor: pal.accent },
            ]}
            onPress={() => onChange(opt)}
            activeOpacity={0.7}
          >
            <ThemedText style={[
              styles.toggleBtnText,
              { color: pal.textSecondary },
              value === opt && { color: pal.accent },
            ]}>{opt}</ThemedText>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

function parseDeviceFirstName(): string {
  const deviceName = Device.deviceName ?? '';
  const match = deviceName.match(/^(.+?)'s /i);
  if (match) return match[1].trim().split(' ')[0];
  return '';
}

const PROFILE_KEY = 'user_profile';

export type SavedProfile = {
  name: string;
  age: string;
  gender: string;
  height: string;
  weight: string;
  weightGoal: string;
  stepGoal: string;
  calGoal: string;
  sleepGoal: string;
  waterGoal: string;
  supplements: string;
  companionApps?: string[]; // e.g. ['strava', 'whoop', 'garmin']
  units?: string;           // 'automatic' | 'imperial' | 'metric'
};

export function ProfileModal({
  visible,
  onClose,
  onProfileSave,
  onSignOut,
}: {
  visible: boolean;
  onClose: () => void;
  onProfileSave?: (profile: SavedProfile) => void;
  /** Called after a successful sign-out so the parent can reset state. */
  onSignOut?: () => void;
}) {
  const { isDark, userTheme, setUserTheme, themeMode, setThemeMode } = useAppTheme();
  const dynPalette = getModalPalette(isDark, userTheme);

  const [name,       setName]       = useState('');
  const [age,        setAge]        = useState('');
  const [gender,     setGender]     = useState('');
  const [height,     setHeight]     = useState('');
  const [weight,     setWeight]     = useState('');
  const [weightGoal, setWeightGoal] = useState('');
  const [stepGoal,   setStepGoal]   = useState('10000');
  const [calGoal,    setCalGoal]    = useState('2000');
  const [sleepGoal,  setSleepGoal]  = useState('8');
  const [waterGoal,  setWaterGoal]  = useState('80');
  const [supplements, setSupplements] = useState('');
  const [companionApps, setCompanionApps] = useState<string[]>([]);
  const [units, setUnits] = useState('automatic');
  const [trainingBody, setTrainingBody] = useState<string | null>(null);
  const [trainingPerf, setTrainingPerf] = useState<string | null>(null);
  const [ouraConnected, setOuraConnected] = useState(false);
  const [hkLoading, setHkLoading] = useState(false);
  const [hkHasData, setHkHasData] = useState<boolean | null>(null);
  const [goalsAutoCalced, setGoalsAutoCalced] = useState(false);
  const [appleLinked, setAppleLinked] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);

  // Load saved profile + Oura status on open.
  // ORDERING: profile + training_goals are resolved together via Promise.all
  // BEFORE HealthKit enrichment runs. This guarantees hasActiveTraining is a
  // plain local variable (not React state) known at the moment the HK callback
  // fires, eliminating the race condition where HK could overwrite a
  // training-adjusted waterGoal.
  // Precedence: explicit training intent > inferred weight direction > HK biometrics.
  useEffect(() => {
    if (!visible) return;

    AsyncStorage.getItem('oura_access_token').then((t) => setOuraConnected(!!t));
    isAppleLinked().then(setAppleLinked).catch(() => {});

    Promise.all([
      AsyncStorage.getItem(PROFILE_KEY),
      AsyncStorage.getItem('training_goals'),
    ]).then(([profileRaw, trainingRaw]) => {
      // 1. Restore saved profile into state
      if (profileRaw) {
        try {
          const p: SavedProfile = JSON.parse(profileRaw);
          setName(p.name || parseDeviceFirstName());
          if (p.age)        setAge(p.age);
          if (p.gender)     setGender(p.gender);
          if (p.height)     setHeight(p.height);
          if (p.weight)     setWeight(p.weight);
          if (p.weightGoal) setWeightGoal(p.weightGoal);
          if (p.stepGoal)   setStepGoal(p.stepGoal);
          if (p.calGoal)    setCalGoal(p.calGoal);
          if (p.sleepGoal)  setSleepGoal(p.sleepGoal);
          if (p.waterGoal)  setWaterGoal(p.waterGoal);
          if (p.supplements) setSupplements(p.supplements);
          if (Array.isArray(p.companionApps)) setCompanionApps(p.companionApps);
          if (p.units) setUnits(p.units);
        } catch {}
      } else {
        setName(parseDeviceFirstName());
      }

      // 2. Restore training selections. Capture intent as a local variable —
      //    NOT React state — so the HK callback below can read it synchronously.
      let hasActiveTraining = false;
      if (trainingRaw) {
        try {
          const { body, perf } = JSON.parse(trainingRaw);
          setTrainingBody(body ?? null);
          setTrainingPerf(perf ?? null);
          hasActiveTraining = !!(body || perf);
        } catch {}
      }

      // 3. Enrich from HealthKit — runs only after both storage keys are known.
      //    waterGoal from HK is applied only when NO training program is active;
      //    training-adjusted waterGoal (e.g. +16 oz for marathon) takes precedence.
      setHkLoading(true);
      getHealthKitProfile().then((hk) => {
        if (hk.age)          setAge(String(hk.age));
        if (hk.sex)          setGender(hk.sex.charAt(0).toUpperCase() + hk.sex.slice(1));
        if (hk.heightInches) setHeight(inchesToDisplay(hk.heightInches));
        if (hk.weightLbs) {
          setWeight(String(hk.weightLbs));
          // Only derive waterGoal from body weight when no training program is
          // active. Training modal already wrote the training-adjusted value
          // (e.g. base + 16 oz for marathon) to user_profile; do not overwrite it.
          if (!hasActiveTraining) {
            setWaterGoal(String(calcWaterGoalOz(hk.weightLbs)));
          }
        }
        // Track whether HealthKit returned any data — used to show a truthful
        // status. "Active" = data received; "Enabled" = framework accessible
        // but no data (denied permissions or empty Apple Health profile).
        setHkHasData(!!(hk.age || hk.sex || hk.heightInches || hk.weightLbs));
      }).catch(() => {
        setHkHasData(false);
      }).finally(() => setHkLoading(false));
    });
  }, [visible]);

  // Recalculate goals only when the user explicitly types a new weight goal —
  // NOT on initial load (which would overwrite training-adjusted goals).
  // If training goals are active, apply them on top of the updated profile baseline.
  function handleWeightGoalChange(val: string) {
    setWeightGoal(val);
    if (!val || !weight || !age || !gender || !height) return;

    if (trainingBody || trainingPerf) {
      // Re-run the training calculation with the updated profile so marathon/recomp
      // multipliers are preserved and the new weight is reflected in the numbers.
      const updatedProfile = { name, age, gender, height, weight, weightGoal: val, calGoal, sleepGoal, waterGoal, stepGoal };
      const result = calcGoalsFromTraining(updatedProfile, trainingBody, trainingPerf);
      if (result) {
        setCalGoal(String(result.calGoal));
        setStepGoal(String(result.stepGoal));
        setWaterGoal(String(result.waterGoal));
        setGoalsAutoCalced(true);
        return;
      }
    }

    const suggested = calcGoalsFromProfile({ age, gender, height, weight, weightGoal: val });
    if (!suggested) return;
    setCalGoal(String(suggested.calGoal));
    setStepGoal(String(suggested.stepGoal));
    setWaterGoal(String(suggested.waterGoal));
    setGoalsAutoCalced(true);
  }

  async function save() {
    const profile: SavedProfile = {
      name, age, gender, height, weight, weightGoal,
      stepGoal, calGoal, sleepGoal, waterGoal, supplements,
      companionApps, units,
    };
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    onProfileSave?.(profile);
    syncProfile(profile).catch(() => {}); // fire-and-forget; local state is authoritative
    onClose();
  }

  async function handleOuraPress() {
    if (ouraConnected) {
      await clearOuraToken();
      setOuraConnected(false);
      return;
    }

    // Shared flow — stores refresh credentials alongside the access token.
    if (await initiateOuraConnect()) {
      setOuraConnected(true);
      trackEvent('oura_connected', { source_screen: 'profile' });
    }
  }

  async function handleAppleSignIn() {
    setAppleLoading(true);
    try {
      const result = await signInWithApple();
      if (result.ok) {
        setAppleLinked(true);
        trackEvent('apple_linked', { source_screen: 'profile' });
      }
    } catch {}
    setAppleLoading(false);
  }

  function handleSignOut() {
    Alert.alert(
      'Sign Out',
      'Your health data stays on this device. Sign back in with Apple any time to restore your account.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            await signOut();
            setAppleLinked(false);
            onClose();
            onSignOut?.();
          },
        },
      ],
    );
  }

  async function handleDeleteAllData() {
    Alert.alert(
      'Delete All Data',
      'This will permanently delete all your health data on this device (logs, profile, settings) and your nutrition history from BellaHealth\'s server. Anonymous usage statistics are not deleted as they contain no personal or health information. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Everything',
          style: 'destructive',
          onPress: async () => {
            // deleteAccount() deletes nutrition_log rows and the auth.users entry
            // server-side, then signs out the local session.
            // Only clear local data if server deletion succeeded — prevents
            // data loss when server is unreachable and the user can retry.
            const serverDeleted = await deleteAccount();
            if (!serverDeleted) {
              Alert.alert(
                'Could Not Delete Data',
                'There was a problem deleting your data from BellaHealth\'s server. Please check your connection and try again. Your local data has not been deleted.',
              );
              return;
            }
            await clearOuraToken(); // Keychain credentials survive AsyncStorage.clear()
            await AsyncStorage.clear();
            onClose();
          },
        },
      ]
    );
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={[styles.container, { backgroundColor: dynPalette.background, paddingTop: Spacing.three }]}>

        <View style={[styles.header, { borderBottomColor: dynPalette.divider }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <ThemedText style={[styles.title, { color: dynPalette.text }]}>Profile</ThemedText>
            {hkLoading && <ActivityIndicator size="small" color={dynPalette.accent} />}
          </View>
          <TouchableOpacity onPress={save} activeOpacity={0.7}>
            <ThemedText style={[styles.saveBtn, { color: dynPalette.accent }]}>Save</ThemedText>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

          {/* About you */}
          <SectionTitle label="About You" pal={dynPalette} />
          <View style={[styles.section, { borderColor: dynPalette.divider }]}>
            <Field label="Name"   value={name}   onChangeText={setName}   placeholder="Your name" pal={dynPalette} />
            <Field label="Age"    value={age}    onChangeText={setAge}    placeholder="from Apple Health" keyboardType="numeric" pal={dynPalette} />
            <ToggleField label="Gender" options={['Female', 'Male', 'Other']} value={gender} onChange={setGender} pal={dynPalette} />
            <Field label="Height" value={height} onChangeText={setHeight} placeholder="from Apple Health" pal={dynPalette} />
            <Field label="Weight" value={weight} onChangeText={setWeight} placeholder="from Apple Health" keyboardType="numeric" pal={dynPalette} last />
          </View>

          {/* Goals */}
          <SectionTitle label="Goals" pal={dynPalette} />
          {goalsAutoCalced && (
            <ThemedText style={[styles.goalsHint, { color: dynPalette.accent }]}>
              {(trainingBody || trainingPerf)
                ? 'Calculated for your weight goal + training — you can adjust below'
                : 'Calculated for your weight goal — you can adjust below'}
            </ThemedText>
          )}
          <View style={[styles.section, { borderColor: dynPalette.divider }]}>
            <Field label="Weight Goal"   value={weightGoal} onChangeText={handleWeightGoalChange} placeholder="lbs" keyboardType="numeric" pal={dynPalette} />
            <Field label="Daily Steps"   value={stepGoal}   onChangeText={setStepGoal}   placeholder="10000" keyboardType="numeric" pal={dynPalette} />
            <Field label="Calories"      value={calGoal}    onChangeText={setCalGoal}    placeholder="kcal"  keyboardType="numeric" pal={dynPalette} />
            <Field label="Sleep"         value={sleepGoal}  onChangeText={setSleepGoal}  placeholder="hrs"   keyboardType="numeric" pal={dynPalette} />
            <Field label="Water"         value={waterGoal}  onChangeText={setWaterGoal}  placeholder="oz"    keyboardType="numeric" pal={dynPalette} last />
          </View>

          {/* Supplements */}
          <SectionTitle label="Supplements" pal={dynPalette} />
          <View style={[styles.section, { borderColor: dynPalette.divider }]}>
            <View style={styles.supplementsInner}>
              <ThemedText style={[styles.fieldLabel, { color: dynPalette.textSecondary }]}>What supplements do you take?</ThemedText>
              <TextInput
                style={[styles.fieldInput, styles.multiline, { color: dynPalette.text }]}
                value={supplements}
                onChangeText={setSupplements}
                placeholder="e.g. Magnesium, Vitamin D, Creatine, Collagen..."
                placeholderTextColor={dynPalette.textSecondary}
                multiline
                numberOfLines={3}
              />
            </View>
          </View>

          {/* Apps I Use */}
          <SectionTitle label="Apps I Use" pal={dynPalette} />
          <ThemedText style={[styles.sectionHint, { color: dynPalette.textSecondary }]}>
            BellaHealth will show these in relevant metric views so you can navigate there directly. We don't connect to these apps.
          </ThemedText>
          <View style={[styles.section, { borderColor: dynPalette.divider }]}>
            {(['strava', 'whoop', 'garmin'] as const).map((app, i) => {
              const labels: Record<string, string> = { strava: 'Strava', whoop: 'WHOOP', garmin: 'Garmin Connect' };
              const isOn = companionApps.includes(app);
              return (
                <TouchableOpacity
                  key={app}
                  style={[
                    styles.toggleField,
                    i < 2 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: dynPalette.divider },
                    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 0 },
                  ]}
                  onPress={() => setCompanionApps((prev) =>
                    prev.includes(app) ? prev.filter((a) => a !== app) : [...prev, app]
                  )}
                  activeOpacity={0.7}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isOn }}
                  accessibilityLabel={labels[app]}
                >
                  <ThemedText style={[styles.fieldLabel, { color: dynPalette.text }]}>{labels[app]}</ThemedText>
                  <View style={[
                    styles.checkbox,
                    { borderColor: isOn ? dynPalette.accent : dynPalette.divider },
                    isOn && { backgroundColor: dynPalette.accent },
                  ]}>
                    {isOn && <ThemedText style={styles.checkmark}>✓</ThemedText>}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Units */}
          <SectionTitle label="Units" pal={dynPalette} />
          <View style={[styles.section, { borderColor: dynPalette.divider }]}>
            <ToggleField
              label="Measurement"
              options={['Automatic', 'Imperial', 'Metric']}
              value={units.charAt(0).toUpperCase() + units.slice(1)}
              onChange={(v) => setUnits(v.toLowerCase())}
              pal={dynPalette}
              last
            />
          </View>

          {/* Appearance */}
          <SectionTitle label="Appearance" pal={dynPalette} />
          <View style={[styles.section, { borderColor: dynPalette.divider }]}>
            <ToggleField
              label="Theme"
              options={['Neutral', 'Mauve', 'Forest']}
              value={userTheme.charAt(0).toUpperCase() + userTheme.slice(1)}
              onChange={(v) => setUserTheme(v.toLowerCase() as 'neutral' | 'mauve' | 'forest')}
              pal={dynPalette}
            />
            <ToggleField
              label="Brightness"
              options={['Auto', 'Light', 'Dark']}
              value={themeMode.charAt(0).toUpperCase() + themeMode.slice(1)}
              onChange={(v) => setThemeMode(v.toLowerCase() as 'auto' | 'light' | 'dark')}
              pal={dynPalette}
              last
            />
          </View>

          {/* Connected Health */}
          <SectionTitle label="Connected Health" pal={dynPalette} />
          <View style={[styles.section, { borderColor: dynPalette.divider }]}>

            <View style={[styles.intRow, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: dynPalette.divider }]}>
              <ThemedText style={[styles.intLabel, { color: dynPalette.text }]}>Apple Health</ThemedText>
              <ThemedText style={[styles.intStatus, { color: hkHasData ? dynPalette.accent : dynPalette.textSecondary }]}>
                {hkLoading ? '—' : hkHasData ? 'Active' : 'Check Settings'}
              </ThemedText>
            </View>

            <TouchableOpacity
              style={styles.intRow}
              onPress={handleOuraPress}
              activeOpacity={0.7}
            >
              <ThemedText style={[styles.intLabel, { color: dynPalette.text }]}>Oura Ring</ThemedText>
              <ThemedText style={[styles.intStatus, { color: ouraConnected ? dynPalette.accent : dynPalette.textSecondary }]}>
                {ouraConnected ? 'Connected' : 'Connect →'}
              </ThemedText>
            </TouchableOpacity>

          </View>

          <ThemedText style={[styles.sectionHint, { color: dynPalette.textSecondary }]}>
            Garmin Connect and WHOOP can sync sleep, HRV, and activity data to Apple Health automatically — enable this in each app's settings under Health Integration.
          </ThemedText>

          {/* Account */}
          <SectionTitle label="Account" pal={dynPalette} />
          <View style={[styles.section, { borderColor: dynPalette.divider }]}>
            <View style={[styles.intRow, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: dynPalette.divider }]}>
              <ThemedText style={[styles.intLabel, { color: dynPalette.text }]}>Apple Sign In</ThemedText>
              <ThemedText style={[styles.intStatus, { color: appleLinked ? dynPalette.accent : dynPalette.textSecondary }]}>
                {appleLinked ? 'Linked ✓' : 'Not linked'}
              </ThemedText>
            </View>
            {!appleLinked && (
              <TouchableOpacity
                style={[styles.intRow, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: dynPalette.divider }]}
                onPress={handleAppleSignIn}
                disabled={appleLoading}
                activeOpacity={0.7}
              >
                <ThemedText style={[styles.intLabel, { color: dynPalette.accent }]}>
                  {appleLoading ? 'Signing in…' : 'Sign in with Apple'}
                </ThemedText>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.intRow}
              onPress={handleSignOut}
              activeOpacity={0.7}
            >
              <ThemedText style={[styles.intLabel, { color: '#C0392B' }]}>Sign Out</ThemedText>
            </TouchableOpacity>
          </View>

          {/* Data & Privacy */}
          <SectionTitle label="Data & Privacy" pal={dynPalette} />
          <View style={[styles.section, { borderColor: dynPalette.divider }]}>
            <TouchableOpacity
              style={[styles.intRow, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: dynPalette.divider }]}
              onPress={() => {
                if (PRIVACY_POLICY_URL) {
                  Linking.openURL(PRIVACY_POLICY_URL);
                } else {
                  Alert.alert('Privacy Policy', 'Privacy Policy URL not yet configured. Please contact support.');
                }
              }}
              activeOpacity={0.7}
            >
              <ThemedText style={[styles.intLabel, { color: dynPalette.text }]}>Privacy Policy</ThemedText>
              <ThemedText style={[styles.intStatus, { color: dynPalette.accent }]}>View →</ThemedText>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.intRow}
              onPress={handleDeleteAllData}
              activeOpacity={0.7}
            >
              <ThemedText style={[styles.intLabel, { color: '#C0392B' }]}>Delete All My Data</ThemedText>
            </TouchableOpacity>
          </View>
          <ThemedText style={[styles.sectionHint, { color: dynPalette.textSecondary }]}>
            Your health logs, profile, and app settings are stored locally on this device. Nutrition history is stored on BellaHealth's server and will also be deleted.
          </ThemedText>

        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.three, paddingBottom: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title:   { fontFamily: Fonts.serif, fontSize: 26, fontStyle: 'italic', fontWeight: '400', paddingTop: 3, paddingRight: 4 },
  saveBtn: { fontSize: 14, letterSpacing: 0.3 },
  scroll:  { gap: Spacing.three, paddingHorizontal: Spacing.three, paddingTop: Spacing.three, paddingBottom: Spacing.six },
  sectionTitle: {
    fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase',
    marginBottom: -Spacing.one,
  },
  section: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2, overflow: 'hidden',
  },
  field: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.three, paddingVertical: 14,
  },
  fieldLabel: { fontSize: 15 },
  fieldInput: {
    fontSize: 15, textAlign: 'right', minWidth: 100,
  },
  supplementsInner: {
    paddingHorizontal: Spacing.three, paddingTop: 14, paddingBottom: Spacing.two, gap: Spacing.two,
  },
  multiline: {
    textAlign: 'left', paddingVertical: Spacing.two, minHeight: 72, lineHeight: 22,
  },
  toggleField: {
    paddingHorizontal: Spacing.three, paddingVertical: 14, gap: Spacing.two,
  },
  toggleOptions: { flexDirection: 'row', gap: Spacing.one },
  toggleBtn: {
    paddingVertical: 5, paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toggleBtnText: { fontSize: 13 },
  intRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.three, paddingVertical: 14,
  },
  intLabel:  { flex: 1, fontSize: 15 },
  intStatus: { fontSize: 12, letterSpacing: 0.2 },
  goalsHint: { fontSize: 12, fontStyle: 'italic', marginTop: -Spacing.two, marginBottom: -Spacing.one },
  sectionHint: { fontSize: 12, lineHeight: 17, marginTop: -Spacing.two, marginBottom: -Spacing.one },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmark: { fontSize: 12, color: '#fff', fontWeight: '700' },
});

