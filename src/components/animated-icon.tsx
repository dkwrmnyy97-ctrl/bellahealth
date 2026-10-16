import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { Animated as RNAnimated, Dimensions, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import { useAppTheme } from '@/context/theme-context';
import { Fonts } from '@/constants/theme';

const INITIAL_SCALE_FACTOR = Dimensions.get('screen').height / 90;
const DURATION = 600;

export function AnimatedSplashOverlay() {
  const { isDark, userTheme } = useAppTheme();
  const [visible, setVisible] = useState(true);

  // Palette-aware colours — mirrors the active theme palette exactly
  // Forest and Neutral share the same splash treatment; Mauve has its own tinted bg.
  const bg = isDark
    ? (userTheme === 'mauve' ? '#1A1218' : '#111111')
    : '#F8F2EC';
  const textColor = isDark
    ? (userTheme === 'mauve' ? '#F2E8EC' : '#FFFFFF')
    : (userTheme === 'mauve' ? '#2D1B1B' : '#111111');
  const secondary = isDark
    ? (userTheme === 'mauve' ? '#8A7888' : '#8E8E93')
    : (userTheme === 'mauve' ? '#8B6B6B' : '#6B6B6B');
  const divider = isDark ? 'rgba(255,255,255,0.12)'
    : (userTheme === 'mauve' ? '#E4D8D0' : '#E4E4E4');

  const overlayOpacity = useRef(new RNAnimated.Value(1)).current;
  const titleOpacity   = useRef(new RNAnimated.Value(0)).current;
  const ruleOpacity    = useRef(new RNAnimated.Value(0)).current;
  const taglineOpacity = useRef(new RNAnimated.Value(0)).current;

  useEffect(() => {
    RNAnimated.sequence([
      // 1. Wordmark reveals
      RNAnimated.timing(titleOpacity,   { toValue: 1, duration: 550, useNativeDriver: true }),
      // 2. Rule appears
      RNAnimated.timing(ruleOpacity,    { toValue: 1, duration: 300, useNativeDriver: true }),
      // 3. Tagline fades in
      RNAnimated.timing(taglineOpacity, { toValue: 1, duration: 450, useNativeDriver: true }),
      // 4. Hold
      RNAnimated.delay(800),
      // 5. Elegant fade out
      RNAnimated.timing(overlayOpacity, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) setVisible(false);
    });
  }, []);

  if (!visible) return null;

  return (
    <RNAnimated.View style={[styles.overlay, { opacity: overlayOpacity, backgroundColor: bg }]}>
      <View style={styles.wordmark}>
        <RNAnimated.View style={{ opacity: titleOpacity }}>
          <Text style={[styles.title, { color: textColor }]}>BellaHealth</Text>
        </RNAnimated.View>
        <RNAnimated.View style={[styles.splashRule, { backgroundColor: divider, opacity: ruleOpacity }]} />
        <RNAnimated.View style={{ opacity: taglineOpacity }}>
          <Text style={[styles.tagline, { color: secondary }]}>your health, in context</Text>
        </RNAnimated.View>
      </View>
    </RNAnimated.View>
  );
}

const keyframe = new Keyframe({
  0: {
    transform: [{ scale: INITIAL_SCALE_FACTOR }],
  },
  100: {
    transform: [{ scale: 1 }],
    easing: Easing.elastic(0.7),
  },
});

const logoKeyframe = new Keyframe({
  0: {
    transform: [{ scale: 1.3 }],
    opacity: 0,
  },
  40: {
    transform: [{ scale: 1.3 }],
    opacity: 0,
    easing: Easing.elastic(0.7),
  },
  100: {
    opacity: 1,
    transform: [{ scale: 1 }],
    easing: Easing.elastic(0.7),
  },
});

const glowKeyframe = new Keyframe({
  0: {
    transform: [{ rotateZ: '0deg' }],
  },
  100: {
    transform: [{ rotateZ: '7200deg' }],
  },
});

export function AnimatedIcon() {
  return (
    <View style={styles.iconContainer}>
      <Animated.View entering={glowKeyframe.duration(60 * 1000 * 4)} style={styles.glow}>
        <Image style={styles.glow} source={require('@/assets/images/logo-glow.png')} />
      </Animated.View>

      <Animated.View entering={keyframe.duration(DURATION)} style={styles.background} />
      <Animated.View style={styles.imageContainer} entering={logoKeyframe.duration(DURATION)}>
        <Image style={styles.image} source={require('@/assets/images/expo-logo.png')} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: Dimensions.get('window').width,
    height: Dimensions.get('window').height,
    zIndex: 9999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  wordmark: {
    alignItems: 'center',
    gap: 16,
  },
  title: {
    fontFamily: Fonts.serif,
    fontSize: 36,
    fontStyle: 'italic',
    fontWeight: '400',
    letterSpacing: -0.5,
  },
  splashRule: {
    width: 40,
    height: StyleSheet.hairlineWidth,
  },
  tagline: {
    fontSize: 13,
    fontStyle: 'italic',
    letterSpacing: 1.5,
  },
  // Legacy styles used by AnimatedIcon (unused in app but kept for safety)
  imageContainer: { justifyContent: 'center', alignItems: 'center' },
  glow: { width: 201, height: 201, position: 'absolute' },
  iconContainer: { justifyContent: 'center', alignItems: 'center', width: 128, height: 128, zIndex: 100 },
  image: { position: 'absolute', width: 76, height: 71 },
  background: { borderRadius: 40, width: 128, height: 128, position: 'absolute' },
});
