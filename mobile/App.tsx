/**
 * ZivBot for Android (and iOS): pair with the ZivBot running on your computer,
 * then carry your Zivs in your pocket. The Zivs, the graph and the coding
 * agents stay on your computer — the phone is a window onto them, with native
 * pairing (QR), notifications and haptics.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

const KEY = 'zivbot.pairUrl';
const C = { bg: '#100f0e', panel: '#1a1817', line: '#383029', text: '#f3eee9', muted: '#8f857b', accent: '#ff7a1a' };

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false }),
});

function Dot({ size = 72 }: { size?: number }) {
  return <Image source={require('./assets/ziv.png')} style={{ width: size * 1.3, height: size * 1.3 }} resizeMode="contain" />;
}

/** Accepts "http://192.168.1.4:8787/?pair=abc" (from the QR) or just "192.168.1.4:8787". */
function normalize(raw: string) {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = `http://${s}`;
  try { const u = new URL(s); return u; } catch { return null; }
}

function PairScreen({ onPaired }: { onPaired: (url: string) => void }) {
  const [perm, requestPerm] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tryPair = async (raw: string) => {
    const u = normalize(raw);
    if (!u) return setError('That doesn’t look like a ZivBot link.');
    setBusy(true);
    setError('');
    // "Anywhere" links carry an encrypted relay in the fragment: the web app reaches your computer
    // through it, so there is nothing on this network to check — just open it.
    if (/[#&]relay=/.test(u.hash)) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setBusy(false); setScanning(false);
      return onPaired(u.toString());
    }
    try {
      const r = await fetch(`${u.origin}/api/health`);
      const j = await r.json();
      if (!j.ok) throw new Error('ZivBot is running, but FalkorDB is down on that computer.');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onPaired(u.toString());
    } catch (e: any) {
      setError(e.message?.includes('FalkorDB') ? e.message : `Couldn’t reach ${u.host}. Same Wi-Fi as your computer?`);
    } finally { setBusy(false); setScanning(false); }
  };
  if (scanning && perm?.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={busy ? undefined : ({ data }) => void tryPair(data)} />
        <Pressable style={[s.btn, { position: 'absolute', bottom: 48, alignSelf: 'center' }]} onPress={() => setScanning(false)}><Text style={s.btnText}>Cancel</Text></Pressable>
      </View>
    );
  }
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.pair}>
      <Dot />
      <Text style={s.h1}>Meet your Zivs</Text>
      <Text style={s.p}>ZivBot runs on your computer — your apps, your AI subscriptions and your memory graph live there. Pair this phone and talk to your Zivs from anywhere — at home over Wi-Fi, or out and about through an encrypted relay to your computer.</Text>
      <Pressable style={s.btnPrimary} onPress={async () => { if (!perm?.granted) { const r = await requestPerm(); if (!r.granted) return setError('Camera permission is needed to scan.'); } setScanning(true); }}>
        <Text style={s.btnPrimaryText}>Scan pairing code</Text>
      </Pressable>
      <Text style={[s.p, { fontSize: 13 }]}>On your computer: your avatar → Pair your phone</Text>
      <View style={s.row}>
        <TextInput style={s.input} value={text} onChangeText={setText} placeholder="or paste the link, e.g. 192.168.1.4:8787" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} />
        <Pressable style={s.btn} onPress={() => void tryPair(text)} disabled={busy}>{busy ? <ActivityIndicator color={C.text} /> : <Text style={s.btnText}>Pair</Text>}</Pressable>
      </View>
      {!!error && <Text style={s.err}>{error}</Text>}
    </KeyboardAvoidingView>
  );
}

// Lets the web app talk to native: notifications, haptics, unpair.
const BRIDGE = `
  window.zivbotMobile = { platform: '${Platform.OS}' };
  true;
`;

function Main({ url, onUnpair }: { url: string; onUnpair: () => void }) {
  const web = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack) { web.current?.goBack(); return true; }
      web.current?.injectJavaScript("window.dispatchEvent(new CustomEvent('zivbot:back')); true;");
      return true;
    });
    return () => sub.remove();
  }, [canGoBack]);
  const onMessage = async (e: WebViewMessageEvent) => {
    let m: any;
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (m.type === 'notify') {
      await Notifications.scheduleNotificationAsync({ content: { title: m.title || 'ZivBot', body: m.text }, trigger: null });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (m.type === 'haptic') void Haptics.selectionAsync();
    else if (m.type === 'unpair') onUnpair();
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top', 'bottom']}>
      <WebView
        ref={web}
        source={{ uri: url }}
        style={{ flex: 1, backgroundColor: C.bg }}
        injectedJavaScriptBeforeContentLoaded={BRIDGE}
        onMessage={onMessage}
        onNavigationStateChange={(n) => setCanGoBack(n.canGoBack)}
        domStorageEnabled
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        startInLoadingState
        renderLoading={() => <View style={[StyleSheet.absoluteFill, s.center]}><Dot size={56} /></View>}
        renderError={() => (
          <View style={[StyleSheet.absoluteFill, s.center, { padding: 28, gap: 14 }]}>
            <Dot size={56} />
            <Text style={s.p}>Your computer isn’t answering. Is ZivBot open, and is this phone on the same Wi-Fi?</Text>
            <Pressable style={s.btn} onPress={() => web.current?.reload()}><Text style={s.btnText}>Try again</Text></Pressable>
            <Pressable onPress={onUnpair}><Text style={[s.p, { textDecorationLine: 'underline' }]}>Pair a different computer</Text></Pressable>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

export default function App() {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void AsyncStorage.getItem(KEY).then(setUrl);
    void Notifications.requestPermissionsAsync().catch(() => {});
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {url === undefined ? <View style={s.center}><Dot /></View>
          : url ? <Main url={url} onUnpair={() => { void AsyncStorage.removeItem(KEY); setUrl(null); }} />
            : <SafeAreaView style={{ flex: 1 }}><PairScreen onPaired={(u) => { void AsyncStorage.setItem(KEY, u); setUrl(u); }} /></SafeAreaView>}
      </View>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  pair: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 18, backgroundColor: C.bg },
  h1: { color: C.text, fontSize: 26, fontWeight: '700' },
  p: { color: C.muted, fontSize: 15, textAlign: 'center', lineHeight: 22 },
  row: { flexDirection: 'row', gap: 8, alignSelf: 'stretch' },
  input: { flex: 1, backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 14, color: C.text, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14 },
  btn: { backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 18, justifyContent: 'center', minHeight: 46 },
  btnText: { color: C.text, fontWeight: '600' },
  btnPrimary: { backgroundColor: '#ff7a1a', borderRadius: 24, paddingHorizontal: 28, paddingVertical: 14, alignSelf: 'stretch', alignItems: 'center' },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  err: { color: '#f87171', textAlign: 'center' },
});
