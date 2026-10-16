import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { SymbolView } from 'expo-symbols';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/context/theme-context';
import { getModalPalette } from '@/utils/modal-palette';
import { trackEvent } from '@/services/analytics';
import {
  deleteDocument,
  extractFromDocumentPhoto,
  loadDocuments,
  saveDocument,
  type DocumentExtract,
  type StoredDocument,
} from '@/services/document-ai';

// Universal functional flag colors — not brand-specific
const FLAG_LOW     = '#E8B4B8';
const FLAG_HIGH    = '#E8C98A';
const FLAG_OPTIMAL = '#B8C9B0';

const DOC_TYPES = [
  { id: 'blood',   label: 'Blood Work',    detail: 'CBC, metabolic panels, lipids, thyroid',    accent: '#E8B4B8', icon: 'drop' },
  { id: 'dexa',    label: 'DEXA Scan',     detail: 'Body composition, bone density',             accent: '#C4B7D4', icon: 'person' },
  { id: 'hormone', label: 'Hormone Panel', detail: 'Estrogen, testosterone, cortisol, insulin',  accent: '#B8C9B0', icon: 'waveform' },
  { id: 'gut',     label: 'Gut Health',    detail: 'Microbiome tests, food sensitivity',          accent: '#E8C98A', icon: 'leaf' },
  { id: 'other',   label: 'Other',         detail: 'Any other health record',                     accent: '#A8C4D4', icon: 'doc.text' },
] as const;

type DocTypeId = typeof DOC_TYPES[number]['id'];

type Pending = {
  typeId: DocTypeId;
  typeLabel: string;
  accent: string;
  extract: DocumentExtract;
};

type ScreenView = 'list' | 'processing' | 'confirm';

function findingAccent(text: string, fallback: string): string {
  const upper = text.toUpperCase();
  if (upper.includes('— LOW') || upper.includes('— CRITICAL')) return FLAG_LOW;
  if (upper.includes('— HIGH')) return FLAG_HIGH;
  if (upper.includes('— OPTIMAL')) return FLAG_OPTIMAL;
  return fallback;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function UploadedDocCard({
  doc,
  onDelete,
  pal,
}: {
  doc: StoredDocument;
  onDelete: (id: string) => void;
  pal: ReturnType<typeof getModalPalette>;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={[styles.docCard, { borderColor: pal.divider, borderLeftColor: doc.accent }]}>
      <TouchableOpacity
        style={styles.docCardHeader}
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.8}
      >
        <View style={[styles.accentBar, { backgroundColor: doc.accent }]} />
        <View style={{ flex: 1 }}>
          <ThemedText style={[styles.docName, { color: pal.text }]}>{doc.type}</ThemedText>
          <ThemedText style={[styles.docDate, { color: pal.textSecondary }]}>{doc.date}</ThemedText>
        </View>
        <ThemedText style={[styles.chevron, { color: pal.textSecondary }]}>{expanded ? '▾' : '▸'}</ThemedText>
      </TouchableOpacity>

      {expanded && (
        <View style={[styles.docExpanded, { borderTopColor: pal.divider }]}>
          <ThemedText style={[styles.docSummary, { color: pal.textSecondary }]}>{doc.summary}</ThemedText>
          {doc.keyFindings.map((f, i) => (
            <View key={i} style={styles.findingRow}>
              <View style={[styles.findingDot, { backgroundColor: findingAccent(f, pal.textSecondary) }]} />
              <ThemedText style={[styles.findingText, { color: pal.text }]}>{f}</ThemedText>
            </View>
          ))}
          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={() =>
              Alert.alert('Remove document', 'This will remove it from your health profile.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Remove', style: 'destructive', onPress: () => onDelete(doc.id) },
              ])
            }
            activeOpacity={0.7}
          >
            <ThemedText style={[styles.deleteBtnText, { color: pal.textSecondary }]}>Remove</ThemedText>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function DocumentsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark, userTheme } = useAppTheme();
  const dynPalette = getModalPalette(isDark, userTheme);

  const [view, setView] = useState<ScreenView>('list');
  const [docs, setDocs] = useState<StoredDocument[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [processingLabel, setProcessingLabel] = useState('');

  useEffect(() => {
    if (!visible) return;
    setView('list');
    setPending(null);
    loadDocuments().then(setDocs).catch(() => {});
  }, [visible]);

  function handleUpload(typeId: DocTypeId) {
    const dt = DOC_TYPES.find((d) => d.id === typeId)!;

    if (typeId === 'other') {
      // "Other" requires the user to name the document type before uploading.
      Alert.prompt(
        'Document Type',
        'What type of health document is this?',
        (customLabel) => {
          const label = customLabel?.trim();
          if (!label) return;
          startUploadFlow(typeId, label, dt.accent);
        },
        'plain-text',
        '',
      );
      return;
    }

    startUploadFlow(typeId, dt.label, dt.accent);
  }

  async function startUploadFlow(typeId: DocTypeId, typeLabel: string, accent: string) {
    // Pre-request permissions before the Alert so they're ready
    await Promise.allSettled([
      ImagePicker.requestCameraPermissionsAsync(),
      ImagePicker.requestMediaLibraryPermissionsAsync(),
    ]);
    Alert.alert(
      `Add ${typeLabel}`,
      'Choose how to add your document.',
      [
        { text: 'Files (PDF or image)', onPress: () => pickFromFiles(typeId, typeLabel, accent) },
        { text: 'Photo Library',        onPress: () => setTimeout(() => pickFromImagePicker(typeId, typeLabel, accent, 'library'), 300) },
        { text: 'Camera',               onPress: () => setTimeout(() => pickFromImagePicker(typeId, typeLabel, accent, 'camera'), 300) },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }

  async function pickFromFiles(typeId: DocTypeId, typeLabel: string, accent: string) {
    let result;
    try {
      result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });
    } catch {
      Alert.alert('Error', 'Could not open Files. Please try again.');
      return;
    }

    if (result.canceled || !result.assets?.[0]) return;
    const file = result.assets[0];

    setProcessingLabel(typeLabel);
    setView('processing');

    try {
      const mimeType = file.mimeType ?? 'application/pdf';
      let base64: string;

      if (mimeType.startsWith('image/')) {
        // Resize & compress images before sending — avoids API size limits
        const resized = await ImageManipulator.manipulateAsync(
          file.uri,
          [{ resize: { width: 1536 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true },
        );
        if (!resized.base64) throw new Error('Could not process image file.');
        base64 = resized.base64;
      } else {
        base64 = await FileSystem.readAsStringAsync(file.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        // Rough size check: base64 of a 20MB PDF is ~27MB string
        if (base64.length > 27_000_000) {
          throw new Error('File is too large. Try a smaller or cropped version.');
        }
      }

      const extract = await extractFromDocumentPhoto(base64, mimeType, typeLabel);
      setPending({ typeId, typeLabel, accent, extract });
      setView('confirm');
    } catch (e: any) {
      setView('list');
      Alert.alert('Could not read document', e?.message ?? 'Please try again.');
    }
  }

  async function pickFromImagePicker(typeId: DocTypeId, typeLabel: string, accent: string, source: 'camera' | 'library') {
    const perm = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (perm.status !== 'granted') {
      Alert.alert('Permission needed', `Please allow ${source === 'camera' ? 'camera' : 'photo library'} access in Settings.`);
      return;
    }

    const opts: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images' as any],
      quality: 1,
    };

    let result: ImagePicker.ImagePickerResult;
    try {
      result = source === 'camera'
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
    } catch {
      Alert.alert('Could not open camera', 'Please check camera and photo access in Settings.');
      return;
    }

    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    setProcessingLabel(typeLabel);
    setView('processing');

    try {
      const resized = await ImageManipulator.manipulateAsync(
        asset.uri,
        [{ resize: { width: 1536 } }],  // slightly larger for documents — more text legible
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (!resized.base64) throw new Error('Could not process image.');

      const extract = await extractFromDocumentPhoto(resized.base64, 'image/jpeg', typeLabel);
      setPending({ typeId, typeLabel, accent, extract });
      setView('confirm');
    } catch (e: any) {
      setView('list');
      Alert.alert('Could not read document', e?.message ?? 'Please try again.');
    }
  }

  async function confirmSave() {
    if (!pending) return;
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const doc: StoredDocument = {
      id: Date.now().toString(),
      type: pending.typeLabel,
      name: `${pending.typeLabel} — ${date}`,
      date,
      accent: pending.accent,
      summary: pending.extract.summary,
      keyFindings: pending.extract.keyFindings,
      context: pending.extract.context,
    };
    await saveDocument(doc);
    trackEvent('document_uploaded', { source_screen: 'documents' });
    setDocs((prev) => [...prev, doc]);
    setPending(null);
    setView('list');
  }

  async function handleDelete(id: string) {
    await deleteDocument(id);
    setDocs((prev) => prev.filter((d) => d.id !== id));
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={[styles.container, { backgroundColor: dynPalette.background, paddingTop: Spacing.three }]}>

        {/* ── Header ── */}
        <View style={styles.header}>
          {view !== 'list' ? (
            <TouchableOpacity
              onPress={() => { setPending(null); setView('list'); }}
              style={styles.backBtn}
              activeOpacity={0.7}
            >
              <ThemedText style={[styles.backBtnText, { color: dynPalette.accent }]}>← Back</ThemedText>
            </TouchableOpacity>
          ) : (
            <View>
              <ThemedText style={[styles.title, { color: dynPalette.text }]}>Documents</ThemedText>
              <ThemedText style={[styles.subtitle, { color: dynPalette.textSecondary }]}>upload health records to improve your insights</ThemedText>
            </View>
          )}
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <ThemedText style={[styles.doneBtn, { color: dynPalette.accent }]}>Done</ThemedText>
          </TouchableOpacity>
        </View>

        {/* ── LIST VIEW ── */}
        {view === 'list' && (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

            {docs.length > 0 && (
              <View style={styles.section}>
                <ThemedText style={[styles.sectionLabel, { color: dynPalette.textSecondary }]}>In Your Health Profile</ThemedText>
                {docs.map((doc) => (
                  <UploadedDocCard key={doc.id} doc={doc} onDelete={handleDelete} pal={dynPalette} />
                ))}
              </View>
            )}

            <ThemedText style={[styles.sectionLabel, { color: dynPalette.textSecondary }]}>Upload a Document</ThemedText>
            <ThemedText style={[styles.uploadHint, { color: dynPalette.textSecondary }]}>
              Take a photo or select a screenshot — Claude will extract your values and use them when giving insights.
            </ThemedText>

            <View style={[styles.uploadGroup, { borderColor: dynPalette.divider }]}>
              {DOC_TYPES.map((dt, i) => (
                <TouchableOpacity
                  key={dt.id}
                  style={[
                    styles.uploadRow,
                    { borderBottomColor: dynPalette.divider },
                    i < DOC_TYPES.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth },
                  ]}
                  onPress={() => handleUpload(dt.id)}
                  activeOpacity={0.8}
                >
                  <View style={[styles.docTypeIcon, { backgroundColor: dt.accent + '28' }]}>
                    <SymbolView name={dt.icon as any} size={11} tintColor={dt.accent} weight="thin" type="monochrome" />
                  </View>
                  <View style={styles.uploadContent}>
                    <ThemedText style={[styles.uploadLabel, { color: dynPalette.text }]}>{dt.label}</ThemedText>
                    <ThemedText style={[styles.uploadDetail, { color: dynPalette.textSecondary }]}>{dt.detail}</ThemedText>
                  </View>
                  <ThemedText style={[styles.uploadArrow, { color: dynPalette.textSecondary }]}>›</ThemedText>
                </TouchableOpacity>
              ))}
            </View>

            <ThemedText style={[styles.privacyText, { color: dynPalette.textSecondary }]}>
              Your documents are stored locally on this device. When you upload a document, its contents are sent to an AI model to extract health insights. Raw document data is not retained by the AI after processing.
            </ThemedText>

          </ScrollView>
        )}

        {/* ── PROCESSING ── */}
        {view === 'processing' && (
          <View style={styles.centeredContent}>
            <ActivityIndicator size="large" color={dynPalette.accent} />
            <ThemedText style={[styles.processingTitle, { color: dynPalette.text }]}>Reading your {processingLabel}…</ThemedText>
            <ThemedText style={[styles.processingSubText, { color: dynPalette.textSecondary }]}>
              Claude is extracting your health values and flagging anything outside normal range
            </ThemedText>
          </View>
        )}

        {/* ── CONFIRM ── */}
        {view === 'confirm' && pending && (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

            {/* Summary card */}
            <View style={[styles.confirmCard, { borderColor: pending.accent + '60', borderLeftColor: pending.accent }]}>
              <ThemedText style={[styles.confirmDocType, { color: pending.accent }]}>{pending.typeLabel}</ThemedText>
              <ThemedText style={[styles.confirmSummary, { color: dynPalette.text }]}>{pending.extract.summary}</ThemedText>
            </View>

            {/* Key findings */}
            <View style={[styles.findingsCard, { borderColor: dynPalette.divider }]}>
              <ThemedText style={[styles.sectionLabel, { color: dynPalette.textSecondary }]}>Key Findings</ThemedText>
              <ThemedText style={[styles.findingsHint, { color: dynPalette.textSecondary }]}>
                Review below — tap Save to add these to your health profile
              </ThemedText>
              {pending.extract.keyFindings.map((f, i) => (
                <View key={i} style={styles.findingRow}>
                  <View style={[styles.findingDot, { backgroundColor: findingAccent(f, dynPalette.textSecondary) }]} />
                  <ThemedText style={[styles.findingText, { color: dynPalette.text }]}>{f}</ThemedText>
                </View>
              ))}
            </View>

            {/* Info */}
            <ThemedText style={[styles.infoNote, { color: dynPalette.textSecondary }]}>
              Once saved, Claude will factor these results into all health insights, goal recommendations, and chat responses.
            </ThemedText>

            <TouchableOpacity
              style={[styles.saveBtn, { borderColor: dynPalette.accent }]}
              onPress={confirmSave}
              activeOpacity={0.8}
            >
              <ThemedText style={[styles.saveBtnText, { color: dynPalette.accent }]}>Save to Health Profile →</ThemedText>
            </TouchableOpacity>

          </ScrollView>
        )}

      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: Spacing.three,
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: Spacing.three,
  },
  title: { fontFamily: Fonts.serif, fontSize: 26, fontStyle: 'italic', fontWeight: '400', paddingTop: 3, paddingRight: 4 },
  subtitle: { fontSize: 12, fontStyle: 'italic', marginTop: 3 },
  doneBtn: { fontSize: 16, fontWeight: '400', paddingTop: 6 },
  backBtn: { paddingVertical: 6 },
  backBtnText: { fontSize: 16 },
  scroll: { gap: Spacing.two, paddingBottom: Spacing.six },
  section: { gap: Spacing.one },
  sectionLabel: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase', marginBottom: 2 },
  uploadHint: { fontSize: 13, lineHeight: 19, marginTop: -Spacing.one, marginBottom: Spacing.one },

  // Uploaded doc card
  docCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    borderRadius: 2,
    overflow: 'hidden',
  },
  docCardHeader: {
    flexDirection: 'row', alignItems: 'center',
    gap: Spacing.two, padding: Spacing.two,
  },
  accentBar: { width: 3, height: 32, borderRadius: 1, flexShrink: 0 },
  docName: { fontSize: 14 },
  docDate: { fontSize: 11, marginTop: 1 },
  chevron: { fontSize: 14 },
  docExpanded: {
    paddingHorizontal: Spacing.two, paddingBottom: Spacing.two, gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 0, paddingTop: Spacing.two,
  },
  docSummary: { fontSize: 13, fontStyle: 'italic', marginBottom: 4 },
  deleteBtn: { alignSelf: 'flex-start', marginTop: 4 },
  deleteBtnText: { fontSize: 12, textDecorationLine: 'underline' },

  // Upload group
  uploadGroup: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 2, overflow: 'hidden' },
  uploadRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.two,
    paddingHorizontal: Spacing.three, paddingVertical: 14,
  },
  accentDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
  docTypeIcon: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  uploadContent: { flex: 1, gap: 2 },
  uploadLabel: { fontSize: 15 },
  uploadDetail: { fontSize: 12 },
  uploadArrow: { fontSize: 18 },

  // Privacy note
  privacyText: { fontSize: 11, lineHeight: 17, fontStyle: 'italic' },

  // Processing
  centeredContent: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: Spacing.three, gap: Spacing.two,
  },
  processingTitle: { fontFamily: Fonts.serif, fontSize: 18, fontStyle: 'italic', fontWeight: '400', marginTop: Spacing.three },
  processingSubText: { fontSize: 13, textAlign: 'center', lineHeight: 20 },

  // Confirm
  confirmCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    borderRadius: 2,
    padding: Spacing.three, gap: Spacing.two,
  },
  confirmDocType: { fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase' },
  confirmSummary: { fontSize: 15, lineHeight: 22 },
  findingsCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 2, padding: Spacing.three, gap: Spacing.two },
  findingsHint: { fontSize: 12, fontStyle: 'italic', marginTop: -4 },
  findingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  findingDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7, flexShrink: 0 },
  findingText: { flex: 1, fontSize: 13, lineHeight: 20 },
  infoNote: { fontSize: 12, lineHeight: 18, fontStyle: 'italic' },
  saveBtn: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 2,
    paddingVertical: 16, alignItems: 'center',
  },
  saveBtnText: { fontSize: 15 },
});
