/**
 * ErrorBoundary
 *
 * Top-level safety net. Catches any unhandled render error in the React tree
 * and shows a minimal recovery UI instead of crashing to a blank screen.
 *
 * This is especially important on first launch when component state is
 * uninitialized and edge cases in rendering are most likely to surface.
 */

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

type State = { hasError: boolean; error: string };

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }

  static getDerivedStateFromError(error: unknown): State {
    const msg = error instanceof Error ? error.message : String(error);
    return { hasError: true, error: msg };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: '' });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <View style={styles.container}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.subtitle}>BellaHealth encountered an unexpected error.</Text>
        <TouchableOpacity style={styles.btn} onPress={this.handleReset} activeOpacity={0.8}>
          <Text style={styles.btnText}>Try Again</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8F2EC',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: '#2D1B1B',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#8B6B6B',
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 20,
  },
  btn: {
    backgroundColor: '#C17B8E',
    borderRadius: 8,
    paddingHorizontal: 28,
    paddingVertical: 12,
  },
  btnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
