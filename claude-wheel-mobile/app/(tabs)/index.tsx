import { useState, useRef, useEffect } from 'react';
import { useKeepAwake } from 'expo-keep-awake';
import { StyleSheet, TouchableOpacity, View, Text, ActivityIndicator, ScrollView, Switch, Modal, TextInput, Alert, KeyboardAvoidingView, Platform, Keyboard, PanResponder, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import CryptoJS from 'crypto-js';

// Polyfill CryptoJS random for Hermes (no crypto.getRandomValues)
(CryptoJS.lib.WordArray as any).random = function(nBytes: number) {
  const bytes = Crypto.getRandomBytes(nBytes);
  const words: number[] = [];
  for (let i = 0; i < nBytes; i += 4) {
    words.push(
      ((bytes[i] ?? 0) << 24) | ((bytes[i+1] ?? 0) << 16) |
      ((bytes[i+2] ?? 0) << 8) | (bytes[i+3] ?? 0)
    );
  }
  return CryptoJS.lib.WordArray.create(words, nBytes);
};
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';

// ── Constants ────────────────────────────────────────────────────────────────
const APP_VERSION = '1.0.0';
const SPEECH_THRESHOLD = -25;
const SILENCE_DURATION = 2500;
const MAX_MESSAGES = 100;
const TERMINAL_LINES = 10;      // default lines per page in terminal

const LANGUAGES = [
  { code: 'zh', label: '🇨🇳 中文' },
  { code: 'en', label: '🇬🇧 English' },
  { code: 'fr', label: '🇫🇷 Français' },
  { code: 'de', label: '🇩🇪 Deutsch' },
  { code: 'ja', label: '🇯🇵 日本語' },
  { code: 'ru', label: '🇷🇺 Русский' },
  { code: 'es', label: '🇪🇸 Español' },
];

const STORAGE_KEYS = {
  serverUrl:       'setting_server_url',
  serverApiKey:    'setting_server_api_key',
  groqApiKey:      'setting_groq_api_key',
  projectsDir:     'setting_projects_dir',
  language:        'setting_language',
  ttsEnabled:      'setting_tts_enabled',
  speechThreshold: 'setting_speech_threshold',
  silenceDuration: 'setting_silence_duration',
  currentSession:  'setting_current_session',
  sessionLocking:  'setting_session_locking',
  hapticOnHang:    'setting_haptic_on_hang',
  hangTimeout:     'setting_hang_timeout',
  pinAttempts:     'pin_attempts',
  hapticStyle:     'setting_haptic_style',
  voiceGender:     'setting_voice_gender',
  lockTimeout:     'setting_lock_timeout',
  fontSize:        'setting_font_size',
  terminalLines:   'setting_terminal_lines',
};


const HAPTIC_OPTIONS = [
  { value: 'none',   label: 'Off' },
  { value: 'light',  label: 'Light' },
  { value: 'medium', label: 'Medium' },
  { value: 'heavy',  label: 'Heavy' },
];
// ────────────────────────────────────────────────────────────────────────────

function KeepAwake() { useKeepAwake(); return null; }

type Message = { role: 'user' | 'claude'; text: string };
type Status  = 'idle' | 'listening' | 'recording' | 'processing' | 'speaking';

const PIN_HASH_KEY = 'pin_hash';
const PIN_SALT_KEY = 'pin_salt';

function hashPin(pin: string, salt: string): string {
  return CryptoJS.PBKDF2(pin, salt, { keySize: 256 / 32, iterations: 1000, hasher: CryptoJS.algo.SHA512 }).toString();
}

export default function VoiceScreen() {
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();


  // ── PIN state ─────────────────────────────────────────────────────────────
  const [pinMode, setPinMode]       = useState<'loading' | 'setup' | 'enter' | 'unlocked'>('loading');
  const [pinInput, setPinInput]     = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError]     = useState('');
  const [pinAttempts, setPinAttempts] = useState(0);
  const MAX_PIN_ATTEMPTS = 5;
  const [pinVisible, setPinVisible]         = useState(false);
  const encryptionKeyRef = useRef<CryptoJS.lib.WordArray | null>(null);

  function deriveKey(pin: string, salt: string): CryptoJS.lib.WordArray {
    return CryptoJS.PBKDF2(pin, salt, { keySize: 256 / 32, iterations: 1000, hasher: CryptoJS.algo.SHA256 });
  }

  function encrypt(data: string): string {
    if (!encryptionKeyRef.current) return data;
    return CryptoJS.AES.encrypt(data, encryptionKeyRef.current.toString()).toString();
  }

  function decrypt(data: string): string {
    if (!encryptionKeyRef.current) return data;
    try {
      return CryptoJS.AES.decrypt(data, encryptionKeyRef.current.toString()).toString(CryptoJS.enc.Utf8);
    } catch {
      return '';
    }
  }
  const [changePinOpen, setChangePinOpen]   = useState(false);
  const [currentPin, setCurrentPin]         = useState('');
  const [newPin, setNewPin]                 = useState('');
  const [newPinConfirm, setNewPinConfirm]   = useState('');
  const [changePinError, setChangePinError] = useState('');
  const [changePinVisible, setChangePinVisible] = useState(false);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(PIN_HASH_KEY),
      AsyncStorage.getItem(STORAGE_KEYS.pinAttempts),
    ]).then(([hash, attempts]) => {
      if (attempts) setPinAttempts(parseInt(attempts) || 0);
      setPinMode(hash ? 'enter' : 'setup');
    });
  }, []);

  async function setupPin() {
    if (pinInput.length < 4) { setPinError('Minimum 4 characters'); return; }
    if (pinInput !== pinConfirm) { setPinError('Passwords do not match'); return; }
    const salt = Array.from(await Crypto.getRandomBytesAsync(16)).map(b => b.toString(16).padStart(2, '0')).join('');
    const hash = hashPin(pinInput, salt);
    await AsyncStorage.setItem(PIN_SALT_KEY, salt);
    await AsyncStorage.setItem(PIN_HASH_KEY, hash);
    encryptionKeyRef.current = deriveKey(pinInput, salt);
    setPinInput(''); setPinConfirm(''); setPinError('');
    lastActivityRef.current = Date.now();
    setPinMode('unlocked');
  }

  async function verifyPin() {
    const [hash, salt] = await Promise.all([
      AsyncStorage.getItem(PIN_HASH_KEY),
      AsyncStorage.getItem(PIN_SALT_KEY),
    ]);
    if (!hash || !salt) { setPinMode('setup'); return; }
    const entered = hashPin(pinInput, salt);
    if (entered === hash) {
      encryptionKeyRef.current = deriveKey(pinInput, salt);
      setPinInput(''); setPinError(''); setPinAttempts(0);
      AsyncStorage.removeItem(STORAGE_KEYS.pinAttempts).catch(() => {});
      lastActivityRef.current = Date.now();
      setPinMode('unlocked');
    } else {
      const attempts = pinAttempts + 1;
      setPinAttempts(attempts);
      setPinInput('');
      if (attempts >= MAX_PIN_ATTEMPTS) {
        await AsyncStorage.clear();
        encryptionKeyRef.current = null;
        setMessages([]);
        setPinAttempts(0);
        setPinError('');
        setPinMode('setup');
      } else {
        await AsyncStorage.setItem(STORAGE_KEYS.pinAttempts, String(attempts));
        setPinError(`Wrong password. Attempts left: ${MAX_PIN_ATTEMPTS - attempts}`);
      }
    }
  }

  async function changePin() {
    const [hash, salt] = await Promise.all([
      AsyncStorage.getItem(PIN_HASH_KEY),
      AsyncStorage.getItem(PIN_SALT_KEY),
    ]);
    if (!hash || !salt) return;
    const currentHash = hashPin(currentPin, salt);
    if (currentHash !== hash) { setChangePinError('Wrong current password'); return; }
    if (newPin.length < 4) { setChangePinError('Minimum 4 characters'); return; }
    if (newPin !== newPinConfirm) { setChangePinError('Passwords do not match'); return; }
    const newSalt = Array.from(await Crypto.getRandomBytesAsync(16)).map(b => b.toString(16).padStart(2, '0')).join('');
    const newHash = hashPin(newPin, newSalt);
    await AsyncStorage.setItem(PIN_SALT_KEY, newSalt);
    await AsyncStorage.setItem(PIN_HASH_KEY, newHash);
    setCurrentPin(''); setNewPin(''); setNewPinConfirm(''); setChangePinError('');
    setChangePinOpen(false);
    Alert.alert('Done', 'Password changed successfully');
  }

  const [status, setStatus]     = useState<Status>('idle');
  const [vadMode, setVadMode]   = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError]       = useState('');

  const [textInput, setTextInput]           = useState('');
  const [currentSession, setCurrentSession] = useState<string>('');
  const [terminalOpen, setTerminalOpen]     = useState(false);
  const [screenLines, setScreenLines]       = useState<string[]>([]);
  const terminalScrollRef  = useRef<any>(null);
  const terminalAtBottom   = useRef(true);
  const [headerH,        setHeaderH]        = useState(80);
  const [terminalToggleH, setTerminalToggleH] = useState(36);
  const [terminalKeysH,  setTerminalKeysH]  = useState(50);
  const [belowTerminalH, setBelowTerminalH] = useState(120);
  const [settingsOpen, setSettingsOpen]     = useState(false);
  const [language, setLanguage]             = useState('en');
  const [langOpen, setLangOpen]             = useState(false);
  const [secConnection, setSecConnection]   = useState(false);
  const [secAudio, setSecAudio]             = useState(false);
  const [secLanguage, setSecLanguage]       = useState(false);
  const [secSecurity, setSecSecurity]       = useState(false);
  const [secBehaviour, setSecBehaviour]     = useState(false);
  const [hapticOnHang, setHapticOnHang]     = useState('none');
  const [hangTimeout, setHangTimeout]       = useState(20);
  const [fontSize, setFontSize]             = useState(15);
  const [fontSizeText, setFontSizeText]     = useState('15');
  const [terminalLines, setTerminalLines]   = useState(10);
  const [terminalLinesText, setTerminalLinesText] = useState('10');
  const [hapticOnHangOpen, setHapticOnHangOpen] = useState(false);
  const [lockTimeout, setLockTimeout]       = useState(10);
  const [sessionLocking, setSessionLocking] = useState(true);
  const lastActivityRef = useRef(Date.now());
  const [hapticStyle, setHapticStyle]       = useState('medium');
  const [hapticOpen, setHapticOpen]         = useState(false);
  const [voiceGender, setVoiceGender]       = useState<'female' | 'male'>('female');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [currentTime, setCurrentTime] = useState(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

  const [sessionsOpen, setSessionsOpen]       = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const [newSessionExpanded, setNewSessionExpanded] = useState(false);
  const [shellSessionsExpanded, setShellSessionsExpanded] = useState(false);
  const [shellSessionsList, setShellSessionsList] = useState<{name: string; running: boolean}[]>([]);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessionsList, setSessionsList]     = useState<{name: string; dir: string; running: boolean}[]>([]);
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionDir, setNewSessionDir]   = useState('');
  const [dirEdited, setDirEdited]           = useState(false);
  const [sessionError, setSessionError]     = useState('');
  const [projectMode, setProjectMode]       = useState(false);
  const screenInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const messagesScrollRef = useRef<ScrollView>(null);
  const isLoadingMessagesRef = useRef(false);
  const hangWatcherRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastScreenRef = useRef('');
  const lastScreenChangeRef = useRef(Date.now());
  const [sessionHung, setSessionHung] = useState(false);

  // ── Configurable settings ─────────────────────────────────────────────────
  const [serverUrl, setServerUrl]         = useState('');
  const [serverApiKey, setServerApiKey]   = useState('');
  const [groqApiKey, setGroqApiKey]       = useState('');
  const [projectsDir, setProjectsDir]     = useState('');
  const [settingsReady, setSettingsReady] = useState(false);
  const [serverOnline, setServerOnline]   = useState<boolean | null>(null);
  const healthFailCount = useRef(0);
  const [speechThreshold, setSpeechThreshold] = useState(SPEECH_THRESHOLD);
  const [silenceDuration, setSilenceDuration] = useState(SILENCE_DURATION);
  const speechThresholdRef = useRef(SPEECH_THRESHOLD);
  const silenceDurationRef = useRef(SILENCE_DURATION);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide  = Keyboard.addListener('keyboardDidHide',  () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (lockTimeout === 0 || pinMode !== 'unlocked') return;
    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current > lockTimeout * 60 * 1000) {
        Keyboard.dismiss();
        encryptionKeyRef.current = null;
        setPinMode('enter');
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [lockTimeout, pinMode]);

  function resetActivity() { lastActivityRef.current = Date.now(); }

  useEffect(() => {
    if (status !== 'processing' || terminalOpen || !currentSession || !serverUrl || !serverApiKey) {
      if (hangWatcherRef.current) { clearInterval(hangWatcherRef.current); hangWatcherRef.current = null; }
      setSessionHung(false);
      return;
    }
    lastScreenRef.current = '';
    lastScreenChangeRef.current = Date.now();
    // suspect positions: Map<charIndex, Set<charsSeenThere>>
    const suspectPositions = new Map<number, Set<string>>();
    let active = true;
    let initialLogged = false;
    hangWatcherRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${serverUrl}/screen?session=${encodeURIComponent(currentSession)}&api_key=${encodeURIComponent(serverApiKey)}`);
        const data = await r.json();
        if (!active) return;
        const screen = (data.screen ?? '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        const prev = lastScreenRef.current;
        lastScreenRef.current = screen;

        if (!prev) return; // first snapshot, nothing to compare

        // Find differing lines (for logging when hung)
        const currLines = screen.split('\n');
        const prevLines = prev.split('\n');

        // Find differing positions (for hang detection logic)
        const maxLen = Math.max(screen.length, prev.length);
        const diffs: number[] = [];
        for (let i = 0; i < maxLen; i++) {
          if ((screen[i] ?? '') !== (prev[i] ?? '')) diffs.push(i);
        }

        const sinceChange = Date.now() - lastScreenChangeRef.current;

        function logHung() {
          const now = new Date();
          const ts = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
          if (!initialLogged) {
            initialLogged = true;
            console.log(`${ts} [initial]`);
            currLines.forEach((line: string, i: number) => console.log(`[${i+1}] ${line}`));
          } else {
            const maxLines = Math.max(currLines.length, prevLines.length);
            let hasChanges = false;
            for (let i = 0; i < maxLines; i++) {
              if ((currLines[i] ?? '') !== (prevLines[i] ?? '')) {
                if (!hasChanges) { console.log(ts); hasChanges = true; }
                console.log(`[${i+1}] prev: ${prevLines[i] ?? ''}`);
                console.log(`[${i+1}] curr: ${currLines[i] ?? ''}`);
              }
            }
            if (!hasChanges) console.log(`${ts} no diff`);
          }
        }

        if (diffs.length === 0) {
          // No change at all
          if (sinceChange > hangTimeout * 1000) { setSessionHung(true); logHung(); }
        } else if (diffs.length > 5) {
          // Many chars changed — real progress
          suspectPositions.clear();
          lastScreenChangeRef.current = Date.now();
          setSessionHung(false);
        } else {
          // Small change — check if it's just cycling symbols
          let realChange = false;
          for (const pos of diffs) {
            const ch = screen[pos] ?? '';
            if (!suspectPositions.has(pos)) {
              // First time seeing this position change
              suspectPositions.set(pos, new Set([prev[pos] ?? '', ch]));
            } else {
              const seen = suspectPositions.get(pos)!;
              if (!seen.has(ch)) {
                // New symbol at this position → real progress
                seen.add(ch);
                realChange = true;
              }
            }
          }
          if (realChange) {
            suspectPositions.clear();
            lastScreenChangeRef.current = Date.now();
            setSessionHung(false);
          } else if (sinceChange > hangTimeout * 1000) {
            setSessionHung(true);
          }
        }
      } catch {}
    }, 5000);
    return () => { active = false; if (hangWatcherRef.current) { clearInterval(hangWatcherRef.current); hangWatcherRef.current = null; } };
  }, [status, terminalOpen, currentSession, serverUrl, serverApiKey]);

  useEffect(() => {
    if (sessionHung && hapticOnHang !== 'none') {
      const style = hapticOnHang === 'light'  ? Haptics.ImpactFeedbackStyle.Light
                  : hapticOnHang === 'medium' ? Haptics.ImpactFeedbackStyle.Medium
                  :                             Haptics.ImpactFeedbackStyle.Heavy;
      Haptics.impactAsync(style);
    }
  }, [sessionHung]);

  useEffect(() => {
    setTimeout(() => messagesScrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages]);

  useEffect(() => {
    if (!currentSession) return;
    isLoadingMessagesRef.current = true;
    AsyncStorage.getItem(`messages_${currentSession}`)
      .then(saved => {
        if (saved) {
          const json = decrypt(saved);
          setMessages(json ? JSON.parse(json) : []);
        } else {
          setMessages([]);
        }
      })
      .catch(() => {})
      .finally(() => { isLoadingMessagesRef.current = false; });
  }, [currentSession]);

  useEffect(() => {
    if (!currentSession || isLoadingMessagesRef.current) return;
    AsyncStorage.setItem(`messages_${currentSession}`, encrypt(JSON.stringify(messages))).catch(() => {});
  }, [messages]);

  function appendMessage(msg: Message) {
    lastActivityRef.current = Date.now();
    setMessages(prev => {
      const next = [...prev, msg];
      return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
    });
  }

  // Load settings after PIN unlock (so encrypted fields can be decrypted)
  useEffect(() => {
    if (pinMode !== 'unlocked') return;
    async function loadSettings() {
      const [url, apiKey, groq, projDir, lang, tts, sThresh, sDur, haptic, gender, lockTimeoutVal, savedSession, sessionLockingVal, hapticOnHangVal, hangTimeoutVal, fontSizeVal, terminalLinesVal] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.serverUrl),
        AsyncStorage.getItem(STORAGE_KEYS.serverApiKey),
        AsyncStorage.getItem(STORAGE_KEYS.groqApiKey),
        AsyncStorage.getItem(STORAGE_KEYS.projectsDir),
        AsyncStorage.getItem(STORAGE_KEYS.language),
        AsyncStorage.getItem(STORAGE_KEYS.ttsEnabled),
        AsyncStorage.getItem(STORAGE_KEYS.speechThreshold),
        AsyncStorage.getItem(STORAGE_KEYS.silenceDuration),
        AsyncStorage.getItem(STORAGE_KEYS.hapticStyle),
        AsyncStorage.getItem(STORAGE_KEYS.voiceGender),
        AsyncStorage.getItem(STORAGE_KEYS.lockTimeout),
        AsyncStorage.getItem(STORAGE_KEYS.currentSession),
        AsyncStorage.getItem(STORAGE_KEYS.sessionLocking),
        AsyncStorage.getItem(STORAGE_KEYS.hapticOnHang),
        AsyncStorage.getItem(STORAGE_KEYS.hangTimeout),
        AsyncStorage.getItem(STORAGE_KEYS.fontSize),
        AsyncStorage.getItem(STORAGE_KEYS.terminalLines),
      ]);
      if (url)     setServerUrl(decrypt(url));
      if (apiKey)  setServerApiKey(decrypt(apiKey));
      if (groq)    setGroqApiKey(decrypt(groq));
      if (projDir) setProjectsDir(projDir.trim());
      if (lang)    setLanguage(lang);
      if (tts !== null) setTtsEnabled(tts === 'true');
      if (sThresh !== null) { const v = parseFloat(sThresh); setSpeechThreshold(v); speechThresholdRef.current = v; }
      if (sDur    !== null) { const v = parseInt(sDur);     setSilenceDuration(v);  silenceDurationRef.current = v; }
      if (haptic)           setHapticStyle(haptic);
      if (gender)           setVoiceGender(gender as 'female' | 'male');
      if (lockTimeoutVal !== null) setLockTimeout(parseInt(lockTimeoutVal) || 0);
      if (savedSession)           setCurrentSession(savedSession);
      if (sessionLockingVal !== null) setSessionLocking(sessionLockingVal !== 'false');
      if (hapticOnHangVal)          setHapticOnHang(hapticOnHangVal);
      if (hangTimeoutVal !== null)  setHangTimeout(parseInt(hangTimeoutVal) || 20);
      if (fontSizeVal !== null)     { const v = parseInt(fontSizeVal) || 15; setFontSize(v); setFontSizeText(String(v)); }
      if (terminalLinesVal !== null) { const v = parseInt(terminalLinesVal) || 10; setTerminalLines(v); setTerminalLinesText(String(v)); }
      setSettingsReady(true);
    }
    loadSettings();
  }, [pinMode]);

  useEffect(() => {
    if (settingsReady && pinMode === 'unlocked' && !sessionLocking) {
      Alert.alert(
        'No request locking',
        'Request locking is disabled. Simultaneous requests from multiple users may conflict.',
        [{ text: 'OK' }]
      );
    }
  }, [settingsReady]);

  async function saveSettings(updates: Partial<{
    serverUrl: string; serverApiKey: string; groqApiKey: string;
    projectsDir: string; language: string; ttsEnabled: boolean;
    speechThreshold: number; silenceDuration: number; hapticStyle: string; voiceGender: string;
    lockTimeout: number;
  }>) {
    const pairs: [string, string][] = [];
    if (updates.serverUrl       !== undefined) pairs.push([STORAGE_KEYS.serverUrl,       encrypt(updates.serverUrl)]);
    if (updates.serverApiKey    !== undefined) pairs.push([STORAGE_KEYS.serverApiKey,    encrypt(updates.serverApiKey)]);
    if (updates.groqApiKey      !== undefined) pairs.push([STORAGE_KEYS.groqApiKey,      encrypt(updates.groqApiKey)]);
    if (updates.projectsDir     !== undefined) pairs.push([STORAGE_KEYS.projectsDir,     updates.projectsDir]);
    if (updates.language        !== undefined) pairs.push([STORAGE_KEYS.language,        updates.language]);
    if (updates.ttsEnabled      !== undefined) pairs.push([STORAGE_KEYS.ttsEnabled,      String(updates.ttsEnabled)]);
    if (updates.speechThreshold !== undefined) pairs.push([STORAGE_KEYS.speechThreshold, String(updates.speechThreshold)]);
    if (updates.silenceDuration !== undefined) pairs.push([STORAGE_KEYS.silenceDuration, String(updates.silenceDuration)]);
    if (updates.hapticStyle     !== undefined) pairs.push([STORAGE_KEYS.hapticStyle,     updates.hapticStyle]);
    if (updates.voiceGender     !== undefined) pairs.push([STORAGE_KEYS.voiceGender,     updates.voiceGender]);
    if (updates.lockTimeout     !== undefined) pairs.push([STORAGE_KEYS.lockTimeout,     String(updates.lockTimeout)]);
    await AsyncStorage.multiSet(pairs);
  }

  // Health check
  async function checkHealth(url: string) {
    if (!url) { setServerOnline(null); return; }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      const r = await fetch(`${url}/health`, { signal: abort.signal });
      if (r.ok) {
        healthFailCount.current = 0;
        setServerOnline(true);
      } else {
        healthFailCount.current += 1;
        if (healthFailCount.current >= 2) setServerOnline(false);
      }
    } catch {
      healthFailCount.current += 1;
      if (healthFailCount.current >= 2) setServerOnline(false);
    } finally {
      clearTimeout(timer);
    }
  }

  const healthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function scheduleHealth(url: string, online: boolean | null) {
    if (healthIntervalRef.current) clearInterval(healthIntervalRef.current);
    const delay = online ? 30000 : 15000;
    healthIntervalRef.current = setInterval(() => checkHealth(url), delay);
  }

  useEffect(() => {
    if (!settingsReady) return;
    checkHealth(serverUrl);
    scheduleHealth(serverUrl, serverOnline);
    return () => { if (healthIntervalRef.current) clearInterval(healthIntervalRef.current); };
  }, [settingsReady, serverUrl, serverOnline]);

  // Refresh session after settings are ready
  useEffect(() => { if (settingsReady && serverUrl && serverApiKey) refreshSession(); }, [settingsReady, serverUrl, serverApiKey]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function apiHeaders(extra?: Record<string, string>) {
    const headers: Record<string, string> = { 'x-api-key': serverApiKey };
    if (groqApiKey) headers['x-groq-api-key'] = groqApiKey;
    return { ...headers, ...extra };
  }

  async function refreshSession() {
    try {
      const r = await fetch(`${serverUrl}/dispatch?action=list`, {
        method: 'POST',
        headers: apiHeaders(),
      });
      const data = await r.json();
      if (data.sessions) setSessionsList(data.sessions);
    } catch {}
  }

  async function loadSessions() {
    try {
      const r = await fetch(`${serverUrl}/dispatch?action=list`, {
        method: 'POST', headers: apiHeaders(),
      });
      const data = await r.json();
      if (data.sessions) setSessionsList(data.sessions);
    } catch {}
  }

  async function switchSession(name: string) {
    const doSwitch = async () => {
      cancelProcessing();
      try {
        await fetch(`${serverUrl}/dispatch?action=switch&session=${encodeURIComponent(name)}`, {
          method: 'POST', headers: apiHeaders(),
        });
        setCurrentSession(name);
        AsyncStorage.setItem(STORAGE_KEYS.currentSession, name).catch(() => {});
        setSessionsOpen(false);
      } catch {}
    };
    if (!sessionLocking) {
      Alert.alert(
        'No request locking',
        'Request locking is disabled. Make sure no one else is working in this session.',
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Switch', onPress: doSwitch }]
      );
    } else {
      doSwitch();
    }
  }

  async function stopSession(name: string) {
    try {
      await fetch(`${serverUrl}/dispatch?action=stop&session=${encodeURIComponent(name)}`, {
        method: 'POST', headers: apiHeaders(),
      });
      await loadSessions();
      if (name === currentSession) {
        Keyboard.dismiss();
        encryptionKeyRef.current = null;
        setPinMode('enter');
      }
    } catch {}
  }

  function closeSession(name: string) {
    Alert.alert(
      'Delete session',
      `Remove "${name}" from the list? The directory will not be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await fetch(`${serverUrl}/dispatch?action=close&session=${encodeURIComponent(name)}`, {
              method: 'POST', headers: apiHeaders(),
            });
            await loadSessions();
          } catch {}
        }},
      ]
    );
  }

  function recreateSession(name: string) {
    Alert.alert(
      'Clear context?',
      `Session "${name}" will be restarted with a fresh context. Conversation history will be lost.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: async () => {
          try {
            await fetch(`${serverUrl}/dispatch?action=recreate&session=${encodeURIComponent(name)}`, {
              method: 'POST', headers: apiHeaders(),
            });
            await AsyncStorage.removeItem(`messages_${name}`);
            setMessages([]);
          } catch {}
        }},
      ]
    );
  }

  async function createSession() {
    if (!newSessionName.trim()) return;
    setSessionError('');
    const baseDir = projectsDir.trim();
    if (!baseDir) {
      setSessionError('Set the working directory in settings (General → Projects directory)');
      return;
    }
    const dir = newSessionDir.trim();
    if (dir && !dir.startsWith(baseDir)) {
      setSessionError(`Directory must be inside ${baseDir}`);
      return;
    }
    setCreatingSession(true);
    try {
      const params = new URLSearchParams({ action: 'create', session: newSessionName.trim() });
      if (dir) params.set('dir', dir);
      if (projectMode) params.set('project_mode', '1');
      const res = await fetch(`${serverUrl}/dispatch?${params}`, { method: 'POST', headers: apiHeaders() });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      setNewSessionName('');
      setNewSessionDir('');
      setDirEdited(false);
      setSessionError('');
      await loadSessions();
    } catch (e) { setSessionError('Error creating session: ' + e); }
    finally { setCreatingSession(false); }
  }

  async function fetchScreen() {
    try {
      const r = await fetch(`${serverUrl}/screen?session=${encodeURIComponent(currentSession)}&api_key=${encodeURIComponent(serverApiKey)}&start=0&count=2000`);
      const data = await r.json();
      setScreenLines((data.screen ?? '').split('\n'));
      if (terminalAtBottom.current) {
        setTimeout(() => terminalScrollRef.current?.scrollToEnd({ animated: false }), 50);
      }
    } catch {}
  }

  async function sendKey(key: string) {
    try {
      await fetch(`${serverUrl}/keypress?key=${key}&session=${encodeURIComponent(currentSession)}&api_key=${encodeURIComponent(serverApiKey)}`, {
        method: 'POST',
      });
      setTimeout(fetchScreen, 300);
    } catch {}
  }

  function toggleTerminal() {
    if (!terminalOpen) {
      terminalAtBottom.current = true;
      fetchScreen();
      screenInterval.current = setInterval(fetchScreen, 2000);
    } else {
      if (screenInterval.current) { clearInterval(screenInterval.current); screenInterval.current = null; }
    }
    setTerminalOpen(v => !v);
    setTimeout(() => messagesScrollRef.current?.scrollToEnd({ animated: false }), 50);
  }

  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);

  function cancelProcessing() {
    cancelledRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (soundRef.current) {
      soundRef.current.stopAsync().catch(() => {});
      soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    setStatus('idle');
    setError('');
  }

  const [audioLevel, setAudioLevel] = useState<number | null>(null);
  const meteringIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const calibRecordingRef = useRef<Audio.Recording | null>(null);
  const calibIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const levelBarWidth     = useRef(0);

  const thresholdPanResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      const x = e.nativeEvent.locationX;
      const db = Math.round(-60 + (x / levelBarWidth.current) * 60);
      const clamped = Math.max(-60, Math.min(0, db));
      setSpeechThreshold(clamped);
      speechThresholdRef.current = clamped;
    },
    onPanResponderMove: (e) => {
      const x = e.nativeEvent.locationX;
      const db = Math.round(-60 + (x / levelBarWidth.current) * 60);
      const clamped = Math.max(-60, Math.min(0, db));
      setSpeechThreshold(clamped);
      speechThresholdRef.current = clamped;
    },
    onPanResponderRelease: () => {
      saveSettings({ speechThreshold: speechThresholdRef.current });
    },
  })).current;

  const recordingRef   = useRef<Audio.Recording | null>(null);
  const soundRef       = useRef<Audio.Sound | null>(null);
  const vadActiveRef   = useRef(false);
  const speechStarted  = useRef(false);
  const silenceStart   = useRef<number | null>(null);
  const vadInterval    = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Calibration (mic level preview in Settings) ───────────────────────────
  async function startCalibration() {
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      calibRecordingRef.current = recording;
      calibIntervalRef.current = setInterval(async () => {
        if (!calibRecordingRef.current) return;
        const s = await calibRecordingRef.current.getStatusAsync();
        setAudioLevel((s as any).metering ?? null);
      }, 100);
    } catch {}
  }

  async function stopCalibration() {
    if (calibIntervalRef.current) { clearInterval(calibIntervalRef.current); calibIntervalRef.current = null; }
    if (calibRecordingRef.current) {
      try { await calibRecordingRef.current.stopAndUnloadAsync(); } catch {}
      calibRecordingRef.current = null;
    }
    setAudioLevel(null);
  }

  useEffect(() => {
    if (settingsOpen && secAudio) startCalibration();
    else stopCalibration();
  }, [settingsOpen, secAudio]);

  // ── TTS ────────────────────────────────────────────────────────────────────
  async function speak(text: string): Promise<void> {
    try {
      const resp = await fetch(`${serverUrl}/tts?api_key=${encodeURIComponent(serverApiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language, gender: voiceGender }),
      });
      if (!resp.ok) throw new Error(`TTS error: ${resp.status}`);
      const blob = await resp.blob();
      const base64: string = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res((reader.result as string).split(',')[1]);
        reader.onerror = rej;
        reader.readAsDataURL(blob);
      });
      if (cancelledRef.current) return;
      const localUri = FileSystem.cacheDirectory + 'tts_response.mp3';
      await FileSystem.writeAsStringAsync(localUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (cancelledRef.current) return;
      const { sound } = await Audio.Sound.createAsync({ uri: localUri }, { shouldPlay: true });
      soundRef.current = sound;
      return new Promise((resolve) => {
        sound.setOnPlaybackStatusUpdate((s) => {
          if (cancelledRef.current) { resolve(); return; }
          if (s.isLoaded && s.didJustFinish) {
            sound.unloadAsync();
            resolve();
          }
        });
      });
    } catch (e) {
      setError('TTS error: ' + e);
    }
  }

  // ── Send recording to STT → Claude → TTS ──────────────────────────────────
  async function sendRecording() {
    if (!recordingRef.current) return;
    cancelledRef.current = false;
    if (meteringIntervalRef.current) { clearInterval(meteringIntervalRef.current); meteringIntervalRef.current = null; }
    setAudioLevel(null);
    setStatus('processing');

    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      if (!uri) return;

      const formData = new FormData();
      formData.append('audio', { uri, name: 'voice.m4a', type: 'audio/m4a' } as any);

      const abort = new AbortController();
      abortControllerRef.current = abort;

      const sttRes = await fetch(`${serverUrl}/stt?language=${language}`, {
        method: 'POST',
        headers: apiHeaders(),
        body: formData,
        signal: abort.signal,
      });
      const { text } = await sttRes.json();
      if (!text) return;

      appendMessage({ role: 'user', text });

      lastScreenChangeRef.current = Date.now();
      const askRes = await fetch(`${serverUrl}/ask?session=${encodeURIComponent(currentSession)}&lock=${sessionLocking}`, {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text }),
        signal: abort.signal,
      });
      const { text: claudeText = 'No response' } = await askRes.json();
      appendMessage({ role: 'claude', text: claudeText });
      refreshSession();

      if (ttsEnabled) {
        setStatus('speaking');
        await speak(claudeText);
      }

    } catch (e: any) {
      if (e?.name !== 'AbortError') setError('Error: ' + e);
    } finally {
      if (vadActiveRef.current) startListening();
      else setStatus('idle');
    }
  }

  // ── Send typed text ───────────────────────────────────────────────────────
  async function sendTextContent(text: string) {
    if (!text || status === 'processing' || status === 'speaking') return;
    setMessages(prev => [...prev, { role: 'user', text }]);
    setStatus('processing');
    cancelledRef.current = false;
    try {
      const abort = new AbortController();
      abortControllerRef.current = abort;
      lastScreenChangeRef.current = Date.now();
      const askRes = await fetch(`${serverUrl}/ask?session=${encodeURIComponent(currentSession)}&lock=${sessionLocking}`, {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text }),
        signal: abort.signal,
      });
      const { text: claudeText = 'No response' } = await askRes.json();
      appendMessage({ role: 'claude', text: claudeText });
      refreshSession();
      if (ttsEnabled) {
        setStatus('speaking');
        await speak(claudeText);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError('Error: ' + e);
    } finally {
      setStatus('idle');
    }
  }

  async function sendText() {
    const text = textInput.trim();
    if (!text) return;
    setTextInput('');
    await sendTextContent(text);
  }

  // ── VAD ───────────────────────────────────────────────────────────────────
  async function startListening() {
    if (!vadActiveRef.current) return;
    setError('');
    try {
      const { recording } = await Audio.Recording.createAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      recordingRef.current = recording;
      speechStarted.current = false;
      silenceStart.current = null;
      setStatus('listening');

      vadInterval.current = setInterval(async () => {
        if (!recordingRef.current || !vadActiveRef.current) return;
        const s = await recordingRef.current.getStatusAsync();
        const db = (s as any).metering ?? -160;
        setAudioLevel(db);
        if (db > speechThresholdRef.current) {
          if (!speechStarted.current && hapticStyle !== 'none') {
            const style = hapticStyle === 'light' ? Haptics.ImpactFeedbackStyle.Light
                        : hapticStyle === 'heavy' ? Haptics.ImpactFeedbackStyle.Heavy
                        : Haptics.ImpactFeedbackStyle.Medium;
            Haptics.impactAsync(style);
          }
          speechStarted.current = true;
          silenceStart.current = null;
          setStatus('recording');
        } else if (speechStarted.current) {
          if (!silenceStart.current) {
            silenceStart.current = Date.now();
          } else if (Date.now() - silenceStart.current > silenceDurationRef.current) {
            clearInterval(vadInterval.current!);
            vadInterval.current = null;
            await sendRecording();
          }
        }
      }, 200);
    } catch (e) {
      setError('Microphone error: ' + e);
    }
  }

  async function toggleVad(value: boolean) {
    setVadMode(value);
    if (value) {
      await stopCalibration();
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });
      vadActiveRef.current = true;
      startListening();
    } else {
      vadActiveRef.current = false;
      if (vadInterval.current) { clearInterval(vadInterval.current); vadInterval.current = null; }
      if (recordingRef.current) { await recordingRef.current.stopAndUnloadAsync(); recordingRef.current = null; }
      setStatus('idle');
      if (settingsOpen && secAudio) startCalibration();
    }
  }

  // ── Manual recording ───────────────────────────────────────────────────────
  async function startRecording() {
    try {
      setError('');
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      recordingRef.current = recording;
      setStatus('recording');
      meteringIntervalRef.current = setInterval(async () => {
        if (!recordingRef.current) return;
        const s = await recordingRef.current.getStatusAsync();
        setAudioLevel((s as any).metering ?? null);
      }, 100);
    } catch (e) {
      setError('Microphone error: ' + e);
    }
  }

  async function stopAndSend() {
    if (!recordingRef.current) return;
    await sendRecording();
  }

  function handlePress() {
    if (vadMode) return;
    if (status === 'idle') startRecording();
    else if (status === 'recording') stopAndSend();
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  const buttonColor = {
    idle:       '#4A90E2',
    listening:  '#4AE27A',
    recording:  '#E24A4A',
    processing: '#888',
    speaking:   '#E2A84A',
  }[status];

  const buttonLabel = {
    idle:       '🎤 Tap to speak',
    listening:  '👂 Listening...',
    recording:  '🔴 Speaking...',
    processing: '⏳ Processing...',
    speaking:   '🔊 Speaking...',
  }[status];

  if (pinMode === 'loading') {
    return <View style={styles.pinScreen}><ActivityIndicator color="#4AE27A" size="large" /></View>;
  }

  if (pinMode === 'setup' || pinMode === 'enter') {
    const isSetup = pinMode === 'setup';
    return (
      <KeyboardAvoidingView style={styles.pinScreen} behavior="padding">
        <Text style={styles.pinTitle}>{isSetup ? 'Set password' : 'Enter password'}</Text>
        <Text style={styles.pinSubtitle}>{isSetup ? 'Protects access to the app and connection data' : 'Claude Wheel'}</Text>
        <View style={styles.pinInputRow}>
          <TextInput
            style={[styles.pinInput, { flex: 1, marginBottom: 0 }]}
            value={pinInput}
            onChangeText={(v) => { setPinInput(v); setPinError(''); }}
            placeholder={isSetup ? 'New password' : 'Password'}
            placeholderTextColor="#555"
            secureTextEntry={!pinVisible}
            autoFocus
          />
          <TouchableOpacity style={styles.pinEye} onPress={() => setPinVisible(v => !v)}>
            <Text style={styles.pinEyeText}>{pinVisible ? '🙈' : '👁'}</Text>
          </TouchableOpacity>
        </View>
        {isSetup && (
          <TextInput
            style={styles.pinInput}
            value={pinConfirm}
            onChangeText={(v) => { setPinConfirm(v); setPinError(''); }}
            placeholder="Repeat password"
            placeholderTextColor="#555"
            secureTextEntry={!pinVisible}
          />
        )}
        {pinError ? <Text style={styles.pinError}>{pinError}</Text> : null}
        <TouchableOpacity style={[styles.pinBtn, pinInput.length < 4 && { opacity: 0.4 }]} onPress={isSetup ? setupPin : verifyPin} disabled={pinInput.length < 4}>
          <Text style={styles.pinBtnText}>{isSetup ? 'Set' : 'Login'}</Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior="padding" onTouchStart={resetActivity}>
      {pinMode === 'unlocked' && <KeepAwake />}
      <View style={styles.header} onLayout={e => setHeaderH(e.nativeEvent.layout.height)}>
        <TouchableOpacity onPress={() => { loadSessions(); setNewSessionName(''); setNewSessionDir(''); setDirEdited(false); setSessionsOpen(true); }}>
          <Text style={styles.title}>Claude Wheel <Text style={styles.version}>v{APP_VERSION}</Text></Text>
          {currentSession
            ? <Text style={styles.session}>{currentSession} ▾</Text>
            : <Text style={styles.session}>tap to select session ▾</Text>
          }
        </TouchableOpacity>
        <Text style={styles.clockText}>{currentTime}</Text>
        <View style={styles.settingsBtnRow}>
          <TouchableOpacity style={styles.settingsBtn} onPress={() => { setTtsEnabled(v => { const next = !v; saveSettings({ ttsEnabled: next }); return next; }); }}>
            <Text style={styles.settingsBtnText}>{ttsEnabled ? '🔊' : '🔇'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.settingsBtn} onPress={() => setSettingsOpen(true)}>
            <View style={styles.settingsBtnRow}>
              <View style={[styles.onlineDot, {
                backgroundColor: serverOnline === null ? '#888' : serverOnline ? '#4AE27A' : '#E24A4A'
              }]} />
              <Text style={styles.settingsBtnText}>⚙️</Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* Settings Modal */}
      <Modal visible={settingsOpen} transparent animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView style={styles.modalSheet} onStartShouldSetResponder={() => true} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>Settings</Text>

            <TouchableOpacity style={styles.sectionHeader} onPress={() => setSecBehaviour(v => !v)}>
              <Text style={styles.sectionHeaderText}>General {secBehaviour ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {secBehaviour && <>
              <View style={styles.settingRow}>
                <Text style={[styles.settingLabel, { flex: 1 }]}>Request locking</Text>
                <Switch value={sessionLocking} onValueChange={v => { setSessionLocking(v); AsyncStorage.setItem(STORAGE_KEYS.sessionLocking, String(v)).catch(() => {}); }} thumbColor={sessionLocking ? '#4AE27A' : '#888'} />
              </View>
              <TouchableOpacity style={styles.settingRow} onPress={() => setHapticOnHangOpen(v => !v)}>
                <Text style={styles.settingLabel}>Haptic on hang</Text>
                <Text style={styles.settingLabel}>{HAPTIC_OPTIONS.find(o => o.value === hapticOnHang)?.label ?? 'Off'} {hapticOnHangOpen ? '▲' : '▼'}</Text>
              </TouchableOpacity>
              {hapticOnHangOpen && HAPTIC_OPTIONS.map(o => (
                <TouchableOpacity key={o.value} style={styles.langRow} onPress={() => {
                  setHapticOnHang(o.value);
                  setHapticOnHangOpen(false);
                  AsyncStorage.setItem(STORAGE_KEYS.hapticOnHang, o.value).catch(() => {});
                  if (o.value !== 'none') {
                    const style = o.value === 'light'  ? Haptics.ImpactFeedbackStyle.Light
                                : o.value === 'medium' ? Haptics.ImpactFeedbackStyle.Medium
                                :                        Haptics.ImpactFeedbackStyle.Heavy;
                    Haptics.impactAsync(style);
                  }
                }}>
                  <Text style={styles.langLabel}>{o.label}</Text>
                  {hapticOnHang === o.value && <Text style={styles.langCheck}>✓</Text>}
                </TouchableOpacity>
              ))}
              <View style={styles.settingRow}>
                <Text style={[styles.settingLabel, { flex: 1 }]}>Hang timeout (sec)</Text>
                <TextInput
                  style={[styles.input, { width: 60, textAlign: 'right' }]}
                  keyboardType="number-pad"
                  value={String(hangTimeout)}
                  onChangeText={t => {
                    const v = parseInt(t) || 0;
                    setHangTimeout(v);
                    AsyncStorage.setItem(STORAGE_KEYS.hangTimeout, String(v)).catch(() => {});
                  }}
                />
              </View>
              <View style={styles.settingRow}>
                <Text style={[styles.settingLabel, { flex: 1 }]}>Font size</Text>
                <TextInput
                  style={[styles.input, { width: 60, textAlign: 'right' }]}
                  keyboardType="number-pad"
                  value={fontSizeText}
                  onChangeText={setFontSizeText}
                  onBlur={() => {
                    const v = Math.min(40, Math.max(8, parseInt(fontSizeText) || 15));
                    setFontSize(v); setFontSizeText(String(v));
                    AsyncStorage.setItem(STORAGE_KEYS.fontSize, String(v)).catch(() => {});
                  }}
                />
              </View>
              <View style={styles.settingRow}>
                <Text style={[styles.settingLabel, { flex: 1 }]}>Terminal lines</Text>
                <TextInput
                  style={[styles.input, { width: 60, textAlign: 'right' }]}
                  keyboardType="number-pad"
                  value={terminalLinesText}
                  onChangeText={setTerminalLinesText}
                  onBlur={() => {
                    const v = parseInt(terminalLinesText) || 10;
                    setTerminalLines(v); setTerminalLinesText(String(v));
                    AsyncStorage.setItem(STORAGE_KEYS.terminalLines, String(v)).catch(() => {});
                  }}
                />
              </View>
              <Text style={styles.inputLabel}>Projects directory</Text>
              <TextInput
                style={styles.input}
                value={projectsDir}
                onChangeText={(v) => setProjectsDir(v.trimStart())}
                onEndEditing={() => { const trimmed = projectsDir.trim(); setProjectsDir(trimmed); saveSettings({ projectsDir: trimmed }); }}
                onBlur={() => { const trimmed = projectsDir.trim(); setProjectsDir(trimmed); saveSettings({ projectsDir: trimmed }); }}
                placeholder="/home/user/projects"
                placeholderTextColor="#555"
                autoCapitalize="none"
              />
            </>}

            <TouchableOpacity style={styles.sectionHeader} onPress={() => setSecAudio(v => !v)}>
              <Text style={styles.sectionHeaderText}>Audio {secAudio ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {secAudio && <>
              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>Text-to-speech</Text>
                <Switch value={ttsEnabled} onValueChange={(v) => { setTtsEnabled(v); saveSettings({ ttsEnabled: v }); }} thumbColor={ttsEnabled ? '#4AE27A' : '#888'} />
              </View>
              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>Voice gender</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity onPress={() => { setVoiceGender('female'); saveSettings({ voiceGender: 'female' }); }}
                    style={[styles.keyBtn, voiceGender === 'female' && { backgroundColor: '#4A90E2' }]}>
                    <Text style={styles.keyText}>♀</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { setVoiceGender('male'); saveSettings({ voiceGender: 'male' }); }}
                    style={[styles.keyBtn, voiceGender === 'male' && { backgroundColor: '#4A90E2' }]}>
                    <Text style={styles.keyText}>♂</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>VAD (auto-send)</Text>
                <Switch value={vadMode} onValueChange={toggleVad} thumbColor={vadMode ? '#4AE27A' : '#888'} />
              </View>
              <View style={styles.levelLabelRow}>
                <Text style={styles.inputLabel}>Noise threshold</Text>
                <Text style={styles.levelDbText}>
                  {audioLevel !== null ? `mic: ${audioLevel.toFixed(0)} dB  ·  ` : ''}threshold: {speechThreshold.toFixed(0)} dB
                </Text>
              </View>
              <View
                style={styles.levelBarBg}
                onLayout={e => { levelBarWidth.current = e.nativeEvent.layout.width; }}
                {...thresholdPanResponder.panHandlers}
              >
                {audioLevel !== null && (
                  <View style={[styles.levelBarFill, {
                    width: `${Math.max(0, Math.min(100, (audioLevel + 60) / 60 * 100))}%` as any,
                    backgroundColor: audioLevel > speechThresholdRef.current ? '#E24A4A' : '#4AE27A',
                  }]} />
                )}
                <View style={[styles.levelThresholdMark, {
                  left: `${Math.max(0, Math.min(100, (speechThresholdRef.current + 60) / 60 * 100))}%` as any,
                }]} />
              </View>
              <Text style={styles.inputLabel}>Silence before send (ms, default 2500)</Text>
              <TextInput
                style={styles.input}
                value={String(silenceDuration)}
                onChangeText={(v) => {
                  const n = parseInt(v);
                  if (!isNaN(n)) { setSilenceDuration(n); silenceDurationRef.current = n; }
                }}
                onEndEditing={() => saveSettings({ silenceDuration })}
                placeholder="2500"
                placeholderTextColor="#555"
                keyboardType="numeric"
              />
              <TouchableOpacity style={styles.settingRow} onPress={() => setHapticOpen(v => !v)}>
                <Text style={styles.settingLabel}>Haptic feedback</Text>
                <Text style={styles.settingLabel}>{HAPTIC_OPTIONS.find(o => o.value === hapticStyle)?.label} {hapticOpen ? '▲' : '▼'}</Text>
              </TouchableOpacity>
              {hapticOpen && HAPTIC_OPTIONS.map(o => (
                <TouchableOpacity key={o.value} style={styles.langRow} onPress={() => {
                  setHapticStyle(o.value); setHapticOpen(false); saveSettings({ hapticStyle: o.value });
                  if (o.value !== 'none') {
                    const style = o.value === 'light'  ? Haptics.ImpactFeedbackStyle.Light
                                : o.value === 'medium' ? Haptics.ImpactFeedbackStyle.Medium
                                :                        Haptics.ImpactFeedbackStyle.Heavy;
                    Haptics.impactAsync(style);
                  }
                }}>
                  <Text style={styles.langLabel}>{o.label}</Text>
                  {hapticStyle === o.value && <Text style={styles.langCheck}>✓</Text>}
                </TouchableOpacity>
              ))}
            </>}

            <TouchableOpacity style={styles.sectionHeader} onPress={() => setSecSecurity(v => !v)}>
              <Text style={styles.sectionHeaderText}>Security {secSecurity ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {secSecurity && <>
              <Text style={styles.label}>Lock after (min, 0 = never)</Text>
              <TextInput
                style={styles.input}
                value={String(lockTimeout)}
                onChangeText={v => {
                  const n = parseInt(v) || 0;
                  setLockTimeout(n);
                  saveSettings({ lockTimeout: n });
                }}
                keyboardType="numeric"
                placeholder="10"
                placeholderTextColor="#555"
              />
              <TouchableOpacity style={[styles.modalClose, { backgroundColor: '#1a1a3e', marginTop: 4 }]} onPress={() => { setChangePinOpen(true); setSettingsOpen(false); }}>
                <Text style={styles.modalCloseText}>🔑 Change password</Text>
              </TouchableOpacity>
            </>}

            <TouchableOpacity style={styles.sectionHeader} onPress={() => setSecConnection(v => !v)}>
              <Text style={styles.sectionHeaderText}>Connection {secConnection ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {secConnection && <>
              <Text style={styles.inputLabel}>Server URL</Text>
              <TextInput
                style={styles.input}
                value={serverUrl}
                onChangeText={setServerUrl}
                onEndEditing={() => saveSettings({ serverUrl })}
                placeholder="https://your-domain.duckdns.org/agent"
                placeholderTextColor="#555"
                autoCapitalize="none"
                keyboardType="url"
              />
              <Text style={styles.inputLabel}>Server API Key</Text>
              <TextInput
                style={styles.input}
                value={serverApiKey}
                onChangeText={setServerApiKey}
                onEndEditing={() => saveSettings({ serverApiKey })}
                placeholder="your-server-api-key"
                placeholderTextColor="#555"
                autoCapitalize="none"
              />
              <Text style={styles.inputLabel}>STT API Key</Text>
              <TextInput
                style={styles.input}
                value={groqApiKey}
                onChangeText={setGroqApiKey}
                onEndEditing={() => saveSettings({ groqApiKey })}
                placeholder="optional, overrides server key"
                placeholderTextColor="#555"
                autoCapitalize="none"
              />
            </>}

            <TouchableOpacity style={styles.sectionHeader} onPress={() => setSecLanguage(v => !v)}>
              <Text style={styles.sectionHeaderText}>Language — {LANGUAGES.find(l => l.code === language)?.label} {secLanguage ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {secLanguage && LANGUAGES.map(l => (
              <TouchableOpacity key={l.code} style={styles.langRow} onPress={() => { setLanguage(l.code); saveSettings({ language: l.code }); }}>
                <Text style={styles.langLabel}>{l.label}</Text>
                {language === l.code && <Text style={styles.langCheck}>✓</Text>}
              </TouchableOpacity>
            ))}

            <TouchableOpacity style={styles.modalClose} onPress={() => setSettingsOpen(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {/* Change PIN Modal */}
      <Modal visible={changePinOpen} transparent animationType="slide" onRequestClose={() => setChangePinOpen(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView style={styles.modalSheet} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>Change password</Text>
            <View style={styles.pinInputRow}>
              <TextInput
                style={[styles.pinInput, { flex: 1, marginBottom: 0 }]}
                value={currentPin}
                onChangeText={(v) => { setCurrentPin(v); setChangePinError(''); }}
                placeholder="Current password"
                placeholderTextColor="#555"
                secureTextEntry={!changePinVisible}
              />
              <TouchableOpacity style={styles.pinEye} onPress={() => setChangePinVisible(v => !v)}>
                <Text style={styles.pinEyeText}>{changePinVisible ? '🙈' : '👁'}</Text>
              </TouchableOpacity>
            </View>
            <View style={{ height: 12 }} />
            <TextInput
              style={styles.pinInput}
              value={newPin}
              onChangeText={(v) => { setNewPin(v); setChangePinError(''); }}
              placeholder="New password"
              placeholderTextColor="#555"
              secureTextEntry={!changePinVisible}
            />
            <TextInput
              style={styles.pinInput}
              value={newPinConfirm}
              onChangeText={(v) => { setNewPinConfirm(v); setChangePinError(''); }}
              placeholder="Repeat new password"
              placeholderTextColor="#555"
              secureTextEntry={!changePinVisible}
            />
            {changePinError ? <Text style={styles.pinError}>{changePinError}</Text> : null}
            <TouchableOpacity style={styles.pinBtn} onPress={changePin}>
              <Text style={styles.pinBtnText}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalClose, { backgroundColor: '#333', marginTop: 12 }]} onPress={() => { setChangePinOpen(false); setCurrentPin(''); setNewPin(''); setNewPinConfirm(''); setChangePinError(''); }}>
              <Text style={styles.modalCloseText}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {/* Sessions Modal */}
      <Modal visible={sessionsOpen} transparent animationType="slide" onRequestClose={() => setSessionsOpen(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView style={styles.modalSheet} onStartShouldSetResponder={() => true} keyboardShouldPersistTaps="handled">
            <TouchableOpacity style={styles.sectionHeader} onPress={() => setSessionsExpanded(v => !v)}>
              <Text style={styles.sectionHeaderText}>Claude sessions {sessionsExpanded ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {sessionsExpanded && sessionsList.map(s => (
              <View key={s.name} style={styles.sessionRow}>
                <TouchableOpacity style={{ flex: 1 }} onPress={() => switchSession(s.name)}>
                  <Text style={[styles.sessionName, s.name === currentSession && styles.sessionActive]}>
                    {s.name === currentSession ? '▶ ' : '   '}{s.name}
                  </Text>
                  <Text style={styles.sessionDir}>{s.running ? '🟢 running' : '⚪ stopped'}</Text>
                </TouchableOpacity>
                {s.name === currentSession ? (<>
                  {s.running && (
                    <TouchableOpacity onPress={() => stopSession(s.name)} style={styles.sessionCloseBtn}>
                      <Text style={styles.sessionStopText}>⏹</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity onPress={() => recreateSession(s.name)} style={styles.sessionCloseBtn}>
                    <Text style={styles.sessionRecreateText}>↻</Text>
                  </TouchableOpacity>
                </>) : (
                  <TouchableOpacity onPress={() => closeSession(s.name)} style={styles.sessionCloseBtn}>
                    <Text style={styles.sessionCloseText}>✕</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}

            <TouchableOpacity style={styles.sectionHeader} onPress={() => setShellSessionsExpanded(v => !v)}>
              <Text style={styles.sectionHeaderText}>Shell sessions {shellSessionsExpanded ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {shellSessionsExpanded && (
              shellSessionsList.length === 0
                ? <Text style={[styles.sessionDir, { paddingHorizontal: 16, paddingVertical: 8 }]}>No shell sessions</Text>
                : shellSessionsList.map(s => (
                  <View key={s.name} style={styles.sessionRow}>
                    <TouchableOpacity style={{ flex: 1 }}>
                      <Text style={styles.sessionName}>   {s.name}</Text>
                      <Text style={styles.sessionDir}>{s.running ? '🟢 running' : '⚪ stopped'}</Text>
                    </TouchableOpacity>
                  </View>
                ))
            )}

            <TouchableOpacity style={styles.sectionHeader} onPress={() => setNewSessionExpanded(v => !v)}>
              <Text style={styles.sectionHeaderText}>New session {newSessionExpanded ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {newSessionExpanded && <>
              <TextInput
                style={styles.input}
                value={newSessionName}
                onChangeText={(v) => {
                  setNewSessionName(v);
                  if (!dirEdited) setNewSessionDir(projectsDir ? `${projectsDir.trim()}/${v}` : '');
                }}
                placeholder="Session name"
                placeholderTextColor="#555"
                autoCapitalize="none"
              />
              <TextInput
                style={styles.input}
                value={newSessionDir}
                onChangeText={(v) => { setNewSessionDir(v); setDirEdited(true); }}
                placeholder="Directory"
                placeholderTextColor="#555"
                autoCapitalize="none"
              />
              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>Use template: conversation + lab</Text>
                <Switch value={projectMode} onValueChange={setProjectMode} thumbColor={projectMode ? '#4AE27A' : '#888'} />
              </View>
              {sessionError ? <Text style={styles.pinError}>{sessionError}</Text> : null}
              <TouchableOpacity style={styles.modalClose} onPress={createSession} disabled={creatingSession}>
                {creatingSession
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.modalCloseText}>+ Create</Text>
                }
              </TouchableOpacity>
            </>}

            <TouchableOpacity style={[styles.modalClose, { backgroundColor: '#333', marginTop: 16 }]} onPress={() => setSessionsOpen(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      <ScrollView ref={messagesScrollRef} style={styles.messages} contentContainerStyle={{ padding: 12 }} onScrollBeginDrag={Keyboard.dismiss} keyboardShouldPersistTaps="handled" onContentSizeChange={() => messagesScrollRef.current?.scrollToEnd({ animated: false })}>
        {messages.map((msg, i) => (
          <View key={i} style={[styles.bubble, msg.role === 'user' ? styles.userBubble : styles.claudeBubble]}>
            <Text style={[styles.bubbleText, { fontSize }]}>{msg.text}</Text>
            {msg.role === 'claude' && (
              <TouchableOpacity onPress={() => Clipboard.setStringAsync(msg.text)} style={styles.copyBtn}>
                <Text style={styles.copyBtnText}>⎘</Text>
              </TouchableOpacity>
            )}
            {msg.role === 'user' && (
              <TouchableOpacity onPress={() => sendTextContent(msg.text)} style={styles.copyBtn}>
                <Text style={styles.copyBtnText}>↺</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
      </ScrollView>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity style={[styles.terminalToggle, sessionHung && { backgroundColor: '#5a1a1a' }]} onPress={toggleTerminal} onLayout={e => setTerminalToggleH(e.nativeEvent.layout.height)}>
        <Text style={[styles.terminalToggleText, sessionHung && { color: '#E24A4A' }]}>{terminalOpen ? '▲ Terminal' : '▼ Terminal'}</Text>
      </TouchableOpacity>

      {terminalOpen && (
        <View style={styles.terminalBlock}>
          <ScrollView
            ref={terminalScrollRef}
            style={[styles.terminalScroll, { height: Math.min(
              terminalLines * (fontSize + 3),
              screenHeight - insets.top - insets.bottom - headerH - terminalToggleH - terminalKeysH - belowTerminalH - 24
            )}]}
            onScrollBeginDrag={() => { terminalAtBottom.current = false; }}
            onScrollEndDrag={({ nativeEvent: e }) => {
              terminalAtBottom.current = e.layoutMeasurement.height + e.contentOffset.y >= e.contentSize.height - 20;
            }}
            onMomentumScrollEnd={({ nativeEvent: e }) => {
              terminalAtBottom.current = e.layoutMeasurement.height + e.contentOffset.y >= e.contentSize.height - 20;
            }}
          >
            <Text style={[styles.terminalText, { fontSize }]}>{screenLines.join('\n')}</Text>
          </ScrollView>
          <View style={styles.terminalKeys} onLayout={e => setTerminalKeysH(e.nativeEvent.layout.height)}>
            <TouchableOpacity style={styles.keyBtn} onPress={() => sendKey('Escape')}>
              <Text style={styles.keyText}>Esc</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.keyBtn} onPress={() => sendKey('Up')}>
              <Text style={styles.keyText}>↑</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.keyBtn} onPress={() => sendKey('Down')}>
              <Text style={styles.keyText}>↓</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.keyBtn} onPress={() => sendKey('Enter')}>
              <Text style={styles.keyText}>↵</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View onLayout={e => setBelowTerminalH(e.nativeEvent.layout.height)}>
      <View style={styles.textInputRow}>
        <TextInput
          style={[styles.textInputField, { fontSize }]}
          value={textInput}
          onChangeText={setTextInput}
          placeholder="Type a message..."
          placeholderTextColor="#555"
          multiline
          maxLength={2000}
        />
        {status === 'processing' || status === 'speaking'
          ? <TouchableOpacity style={[styles.textSendBtn, { backgroundColor: '#8B3A3A' }]} onPress={cancelProcessing}>
              <Text style={styles.textSendBtnText}>✕</Text>
            </TouchableOpacity>
          : <TouchableOpacity
              style={[styles.textSendBtn, !textInput.trim() && { opacity: 0.4 }]}
              onPress={sendText}
              disabled={!textInput.trim()}
            >
              <Text style={styles.textSendBtnText}>↑</Text>
            </TouchableOpacity>
        }
      </View>

      {!keyboardVisible && !vadMode && (
        <View style={[styles.buttonRow, { marginBottom: insets.bottom + 1 }]}>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: buttonColor, flex: 1 }]}
            onPress={handlePress}
            disabled={status === 'processing' || status === 'speaking'}
          >
            {status === 'processing'
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>{buttonLabel}</Text>
            }
          </TouchableOpacity>
        </View>
      )}

      {!keyboardVisible && vadMode && (
        <View style={[styles.vadRow, { marginBottom: insets.bottom + 1 }]}>
          <View style={[styles.vadIndicator, { backgroundColor: buttonColor, flex: 1 }]}>
            {status === 'processing'
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>{buttonLabel}</Text>
            }
          </View>
        </View>
      )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#1a1a2e', paddingTop: 60 },
  header:             { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, marginBottom: 12 },
  title:              { color: '#fff', fontSize: 22, fontWeight: 'bold' },
  version:            { color: '#555', fontSize: 13, fontWeight: 'normal' },
  session:            { color: '#4AE27A', fontSize: 18, marginTop: 2 },
  settingsBtn:        { padding: 8 },
  settingsBtnRow:     { flexDirection: 'row', alignItems: 'center', gap: 6 },
  settingsBtnText:    { fontSize: 24 },
  onlineDot:          { width: 10, height: 10, borderRadius: 5 },
  modalOverlay:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet:         { backgroundColor: '#1a1a2e', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 24, maxHeight: '85%' },
  modalTitle:         { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 20 },
  label:              { color: '#aaa', fontSize: 13, marginBottom: 6, marginTop: 8 },
  sectionHeader:      { marginBottom: 4, marginTop: 12, borderBottomWidth: 1, borderBottomColor: '#2a2a4e', paddingBottom: 8 },
  sectionHeaderText:  { color: '#4AE27A', fontSize: 22, fontWeight: 'bold', letterSpacing: 1 },
  inputLabel:         { color: '#aaa', fontSize: 13, marginBottom: 4 },
  input:              { backgroundColor: '#2a2a4e', color: '#fff', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 },
  settingRow:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  settingLabel:       { color: '#fff', fontSize: 16 },
  modalClose:         { backgroundColor: '#2a2a4e', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 8, marginBottom: 24 },
  modalCloseText:     { color: '#fff', fontSize: 16 },
  sessionRow:         { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#2a2a4e' },
  sessionName:        { color: '#fff', fontSize: 16 },
  sessionActive:      { color: '#4AE27A', fontWeight: 'bold' },
  sessionDir:         { color: '#888', fontSize: 12, marginTop: 2 },
  sessionCloseBtn:      { padding: 8 },
  sessionCloseText:     { color: '#8B3A3A', fontSize: 18 },
  sessionRecreateText:  { color: '#4A90E2', fontSize: 22 },
  sessionStopText:      { color: '#E2A84A', fontSize: 18 },
  langRow:            { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#2a2a4e' },
  langLabel:          { color: '#fff', fontSize: 15 },
  langCheck:          { color: '#4AE27A', fontSize: 18, fontWeight: 'bold' },
  messages:           { flex: 1 },
  bubble:             { borderRadius: 12, padding: 10, marginBottom: 8, maxWidth: '80%' },
  copyBtn:            { alignSelf: 'flex-end', opacity: 0.5 },
  copyBtnText:        { color: '#fff', fontSize: 18 },
  userBubble:         { backgroundColor: '#4A90E2', alignSelf: 'flex-end' },
  claudeBubble:       { backgroundColor: '#2a2a4e', alignSelf: 'flex-start' },
  bubbleText:         { color: '#fff', fontSize: 15 },
  levelContainer:     { flexDirection: 'row', alignItems: 'center', marginHorizontal: 20, marginBottom: 8, gap: 10 },
  levelLabelRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  levelDbText:        { color: '#aaa', fontSize: 12 },
  levelBarBg:         { height: 36, backgroundColor: '#2a2a4e', borderRadius: 8, overflow: 'hidden', position: 'relative', marginBottom: 12 },
  levelBarFill:       { height: '100%', borderRadius: 8 },
  levelThresholdMark: { position: 'absolute', top: 0, width: 3, height: '100%', backgroundColor: '#fff', opacity: 0.9 },
  levelText:          { color: '#aaa', fontSize: 12, width: 48, textAlign: 'right' },
  clockText:          { color: '#888', fontSize: 16, fontVariant: ['tabular-nums'] },
  pinScreen:          { flex: 1, backgroundColor: '#0f0f1a', alignItems: 'center', justifyContent: 'center', padding: 32 },
  pinTitle:           { color: '#4AE27A', fontSize: 24, fontWeight: 'bold', marginBottom: 8 },
  pinSubtitle:        { color: '#888', fontSize: 14, marginBottom: 32, textAlign: 'center' },
  pinInput:           { width: '100%', backgroundColor: '#1a1a2e', color: '#fff', borderRadius: 10, padding: 14, fontSize: 16, marginBottom: 12, borderWidth: 1, borderColor: '#2a2a4e' },
  pinError:           { color: '#E24A4A', fontSize: 14, marginBottom: 12 },
  pinBtn:             { width: '100%', backgroundColor: '#4A90E2', borderRadius: 10, padding: 16, alignItems: 'center', marginTop: 4 },
  pinBtnText:         { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  pinInputRow:        { width: '100%', flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  pinEye:             { padding: 10, marginLeft: 8 },
  pinEyeText:         { fontSize: 20 },
  error:              { color: '#E24A4A', textAlign: 'center', margin: 8 },
  buttonRow:          { flexDirection: 'row', alignItems: 'center', marginHorizontal: 20, marginTop: 20 },
  button:             { padding: 20, borderRadius: 50, alignItems: 'center' },
  cancelBtn:          { marginRight: 16, backgroundColor: '#8B3A3A', width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cancelText:         { color: '#ccc', fontSize: 16, fontWeight: 'bold' },
  vadRow:             { flexDirection: 'row', alignItems: 'center', marginHorizontal: 20, marginTop: 20, gap: 12 },
  vadIndicator:       { padding: 16, borderRadius: 16, alignItems: 'center' },
  buttonText:         { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  textInputRow:       { flexDirection: 'row', alignItems: 'center', marginHorizontal: 20, marginBottom: 8, gap: 8 },
  textInputField:     { flex: 1, backgroundColor: '#2a2a4e', color: '#fff', borderRadius: 16, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 120 },
  textSendBtn:        { backgroundColor: '#4A90E2', width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  textSendBtnText:    { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  terminalToggle:     { marginHorizontal: 20, marginBottom: 4, paddingVertical: 6, alignItems: 'center', backgroundColor: '#2a2a4e', borderRadius: 8 },
  terminalToggleText: { color: '#aaa', fontSize: 13 },
  terminalBlock:      { marginHorizontal: 12, marginBottom: 8, backgroundColor: '#0d0d1a', borderRadius: 8 },
  terminalScroll:     { padding: 8 },
  terminalText:       { color: '#4AE27A', fontSize: 11, fontFamily: 'monospace' },
  terminalKeys:       { flexDirection: 'row', justifyContent: 'center', gap: 16, padding: 8 },
  keyBtn:             { backgroundColor: '#2a2a4e', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8 },
  keyText:            { color: '#fff', fontSize: 20 },
});
