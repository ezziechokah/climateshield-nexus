import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import * as Location from "expo-location";
import NetInfo from "@react-native-community/netinfo";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
type User = { id: string; name: string; email: string; role: string; language: string };
type Farm = { id: string; name: string; county: string; locality: string; latitude: number | null; longitude: number | null; crop: string; irrigation: string };
type Assessment = { id: string; farmId: string; farm: Farm; risks: Array<{ riskType: string; level: string; explanation: string; method: string }>; recommendations: Array<{ title: string; action: string; limitation: string }>; provenance: { source: string; simulated: boolean; retrievedAt: string }; uncertainty: string[]; assessedAt: string };
const colors = { forest: "#163b35", paper: "#f2f4ee", lime: "#d9ed86", ink: "#182622", muted: "#74817a", line: "#dce2da", white: "#fff", amber: "#9b6b20" };

export default function Home() {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [farms, setFarms] = useState<Farm[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [register, setRegister] = useState(true);
  const [form, setForm] = useState({ name: "", email: "", phone: "+254", password: "" });
  const [farmForm, setFarmForm] = useState({ name: "", county: "", locality: "", crop: "Maize", latitude: "", longitude: "" });
  const [addFarm, setAddFarm] = useState(false);
  const [db, setDb] = useState<SQLite.SQLiteDatabase | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      const database = await SQLite.openDatabaseAsync("climateshield.db");
      await database.execAsync("CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, payload TEXT NOT NULL, saved_at TEXT NOT NULL)");
      await database.execAsync("CREATE TABLE IF NOT EXISTS pending_ops (idempotency_key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'PENDING', last_error TEXT, created_at TEXT NOT NULL)");
      const pendingColumns = await database.getAllAsync<{ name: string }>("PRAGMA table_info(pending_ops)");
      if (!pendingColumns.some((column) => column.name === "state")) await database.execAsync("ALTER TABLE pending_ops ADD COLUMN state TEXT NOT NULL DEFAULT 'PENDING'");
      if (!pendingColumns.some((column) => column.name === "last_error")) await database.execAsync("ALTER TABLE pending_ops ADD COLUMN last_error TEXT");
      const saved = await SecureStore.getItemAsync("session-token");
      const savedUser = await SecureStore.getItemAsync("session-user");
      const restoredUser = savedUser ? JSON.parse(savedUser) as User : null;
      const cachedOwner = await SecureStore.getItemAsync("cache-owner");
          if (cachedOwner && (!restoredUser || cachedOwner !== restoredUser.id)) {
        await database.execAsync("DELETE FROM snapshots; DELETE FROM pending_ops;");
      }
          if (restoredUser) await SecureStore.setItemAsync("cache-owner", restoredUser.id);
      const pending = await database.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM pending_ops WHERE state != 'SYNCED'");
      const failed = await database.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM pending_ops WHERE state IN ('FAILED','CONFLICT')");
      const cachedRows = await database.getAllAsync<{ payload: string }>("SELECT payload FROM snapshots ORDER BY saved_at DESC");
      if (active) {
        setDb(database);
        setPendingCount(Number(pending?.count ?? 0));
        setFailedCount(Number(failed?.count ?? 0));
        const cachedAssessments: Assessment[] = [];
        for (const row of cachedRows) {
          const value = JSON.parse(row.payload) as Assessment | { farms: Farm[] };
          if ("farms" in value && Array.isArray(value.farms)) setFarms(value.farms);
          else if ("farmId" in value) cachedAssessments.push(value);
        }
        if (cachedAssessments.length) setAssessments(cachedAssessments);
      }
      if (saved && restoredUser && active) { setToken(saved); setUser(restoredUser); }
    })();
    const unsubscribe = NetInfo.addEventListener((state) => setOnline(Boolean(state.isConnected)));
    return () => { active = false; unsubscribe(); };
  }, []);

  async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const mutation = method !== "GET";
    const response = await fetch(`${API_URL}${path}`, { method, headers: { "Content-Type": "application/json", ...(mutation ? { "Idempotency-Key": crypto.randomUUID() } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error((await response.json()).message ?? `Request failed (${response.status})`);
    return response.status === 204 ? undefined as T : response.json();
  }

  async function refresh() {
    if (!token || !db || !online) return;
    try {
      await syncPendingOperations();
      const [farmData, assessmentData] = await Promise.all([api<{ farms: Farm[] }>("/farms"), api<{ assessments: Assessment[] }>("/assessments")]);
      setFarms(farmData.farms); setAssessments(assessmentData.assessments);
      const snapshots = [...assessmentData.assessments, { id: "farms", farms: farmData.farms }];
      for (const snapshot of snapshots) await db.runAsync("INSERT OR REPLACE INTO snapshots (id,payload,saved_at) VALUES (?,?,?)", snapshot.id, JSON.stringify(snapshot), new Date().toISOString());
    } catch (error) { Alert.alert("Sync unavailable", error instanceof Error ? error.message : "Using saved information where available."); }
  }

  async function syncPendingOperations() {
    if (!db || !online) return;
    const pending = await db.getAllAsync<{ idempotency_key: string; kind: string; payload: string; state: string }>("SELECT idempotency_key,kind,payload,state FROM pending_ops WHERE state IN ('PENDING','SYNCING') ORDER BY created_at ASC");
    for (const operation of pending) {
      try {
        if (operation.kind !== "farm-create") continue;
        await db.runAsync("UPDATE pending_ops SET state='SYNCING',last_error=NULL WHERE idempotency_key=?", operation.idempotency_key);
        const response = await fetch(`${API_URL}/farms`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": operation.idempotency_key }, body: operation.payload });
        if (!response.ok) {
          const state = response.status === 409 ? "CONFLICT" : [400, 401, 403, 404].includes(response.status) ? "FAILED" : "PENDING";
          await db.runAsync("UPDATE pending_ops SET state=?,last_error=? WHERE idempotency_key=?", state, `HTTP ${response.status}`, operation.idempotency_key);
          if (response.status === 401) { setToken(""); setUser(null); Alert.alert("Session expired", "Your saved changes are retained. Sign in again to resume synchronization."); }
          Alert.alert(state === "CONFLICT" ? "Sync conflict" : "Sync needs attention", `A saved farm operation is ${state}. Review connectivity and account access before retrying.`, [
            { text: "Later", style: "cancel" },
            { text: "Retry", onPress: () => void retryFailedSafely() },
          ]);
          break;
        }
        await db.runAsync("UPDATE pending_ops SET state='SYNCED',last_error=NULL WHERE idempotency_key = ?", operation.idempotency_key);
      } catch {
        await db.runAsync("UPDATE pending_ops SET state='PENDING',last_error='Network unavailable' WHERE idempotency_key=?", operation.idempotency_key);
        break;
      }
    }
    const count = await db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM pending_ops WHERE state != 'SYNCED'");
    const failed = await db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM pending_ops WHERE state IN ('FAILED','CONFLICT')");
    setPendingCount(Number(count?.count ?? 0));
    setFailedCount(Number(failed?.count ?? 0));
  }

  async function retryFailedOperations() {
    await db?.runAsync("UPDATE pending_ops SET state='PENDING',last_error=NULL WHERE state IN ('FAILED','CONFLICT')");
    const count = await db?.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM pending_ops WHERE state != 'SYNCED'");
    setPendingCount(Number(count?.count ?? 0)); setFailedCount(0);
    await syncPendingOperations();
  }

  async function retryFailedSafely() {
    if (!db) return;
    const reset = async () => {
      await db.runAsync("UPDATE pending_ops SET state='PENDING',last_error=NULL WHERE state IN ('FAILED','CONFLICT')");
      await retryFailedOperations();
    };
    if (!online) { Alert.alert("Offline", "Reconnect before retrying failed changes."); return; }
    Alert.alert("Retry saved changes", "The app will resend failed operations using their original idempotency keys.", [
      { text: "Cancel", style: "cancel" },
      { text: "Retry", onPress: () => void reset() },
    ]);
  }

  useEffect(() => {
    if (token) void SecureStore.setItemAsync("session-token", token);
    else void SecureStore.deleteItemAsync("session-token");
    if (user) void SecureStore.setItemAsync("session-user", JSON.stringify(user));
    else void SecureStore.deleteItemAsync("session-user");
    if (user) void SecureStore.setItemAsync("cache-owner", user.id);
  }, [token, user]);
  useEffect(() => { void refresh(); }, [token, online, db]);
  useEffect(() => {
    if (failedCount > 0 && online) Alert.alert("Saved changes need attention", `${failedCount} operation(s) failed or conflicted. Retry after reviewing connectivity and account access?`, [
      { text: "Later", style: "cancel" },
      { text: "Retry", onPress: () => void retryFailedSafely() },
    ]);
  }, [failedCount, online]);

  async function submitAuth() {
    setBusy(true);
    try {
      const endpoint = register ? "/auth/register" : "/auth/login";
      const body = register ? { ...form, language: "en" } : { email: form.email, password: form.password };
      const result = await api<{ token: string; user: User }>(endpoint, "POST", body);
      const cachedOwner = await SecureStore.getItemAsync("cache-owner");
      if (cachedOwner && cachedOwner !== result.user.id) {
        await db?.execAsync("DELETE FROM snapshots; DELETE FROM pending_ops;");
        setFarms([]); setAssessments([]); setPendingCount(0);
        setFailedCount(0);
      }
      await db?.runAsync("UPDATE pending_ops SET state='PENDING',last_error=NULL WHERE state='FAILED' AND last_error='HTTP 401'");
      setUser(result.user); setToken(result.token); await SecureStore.setItemAsync("session-token", result.token); await SecureStore.setItemAsync("session-user", JSON.stringify(result.user));
    } catch (error) { Alert.alert("Account", error instanceof Error ? error.message : "Unable to sign in."); }
    finally { setBusy(false); }
  }

  async function saveFarm() {
    setBusy(true);
    try {
      const body = { ...farmForm, latitude: farmForm.latitude ? Number(farmForm.latitude) : null, longitude: farmForm.longitude ? Number(farmForm.longitude) : null, locationSource: "manual", irrigation: "unknown" };
      if (!online) {
        const key = crypto.randomUUID();
        await db?.runAsync("INSERT INTO pending_ops (idempotency_key,kind,payload,state,created_at) VALUES (?,?,?,'PENDING',?)", key, "farm-create", JSON.stringify(body), new Date().toISOString());
        const count = await db?.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM pending_ops WHERE state != 'SYNCED'");
        setPendingCount(Number(count?.count ?? 0)); setAddFarm(false);
        Alert.alert("Saved on this device", "This farm is PENDING and will sync when your device reconnects.");
        return;
      }
      await api("/farms", "POST", body); setAddFarm(false); setFarmForm({ name: "", county: "", locality: "", crop: "Maize", latitude: "", longitude: "" }); await refresh();
    } catch (error) { Alert.alert("Farm", error instanceof Error ? error.message : "Unable to save farm."); }
    finally { setBusy(false); }
  }

  async function useGps() {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) { Alert.alert("Location permission", "Permission denied. Enter county and locality or coordinates manually."); return; }
    try {
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setFarmForm((current) => ({ ...current, latitude: String(location.coords.latitude), longitude: String(location.coords.longitude) }));
    } catch { Alert.alert("Location unavailable", "Enter the coordinates manually instead."); }
  }

  async function runAssessment(farm: Farm, source: "demo-synthetic" | "open-meteo") {
    setBusy(true);
    try {
      const assessment = await api<Assessment>(`/farms/${farm.id}/assess`, "POST", { source, latitude: farm.latitude, longitude: farm.longitude });
      setAssessments((current) => [assessment, ...current]);
      await db?.runAsync("INSERT OR REPLACE INTO snapshots (id,payload,saved_at) VALUES (?,?,?)", assessment.id, JSON.stringify(assessment), new Date().toISOString());
    } catch (error) { Alert.alert("Assessment", error instanceof Error ? error.message : "Unable to generate assessment."); }
    finally { setBusy(false); }
  }

  function signOut() {
    const clearLocal = async () => {
      await SecureStore.deleteItemAsync("session-token");
      await SecureStore.deleteItemAsync("session-user");
      await SecureStore.deleteItemAsync("cache-owner");
      await db?.execAsync("DELETE FROM snapshots; DELETE FROM pending_ops;");
      setFarms([]); setAssessments([]); setPendingCount(0); setToken(""); setUser(null);
    };
    if (pendingCount) {
      Alert.alert("Pending changes", "Signing out will remove unsynced farm changes from this device.", [
        { text: "Stay signed in", style: "cancel" },
        { text: "Discard and sign out", style: "destructive", onPress: () => void clearLocal() },
      ]);
    } else void clearLocal();
  }

  if (!token || !user) return <ScrollView contentContainerStyle={styles.auth}><Text style={styles.brand}>CLIMATESHIELD <Text style={{ color: colors.lime }}>NEXUS</Text></Text><Text style={styles.eyebrow}>FARM CLIMATE DESK / KENYA</Text><Text style={styles.hero}>Farming decisions, informed by climate.</Text><Text style={styles.body}>Decision support only. No forecast or agricultural outcome is guaranteed.</Text>{register && <Field label="Full name" value={form.name} onChangeText={(name) => setForm({ ...form, name })} /> }<Field label="Email" value={form.email} onChangeText={(email) => setForm({ ...form, email })} keyboardType="email-address" autoCapitalize="none" />{register && <Field label="Phone in international format" value={form.phone} onChangeText={(phone) => setForm({ ...form, phone })} keyboardType="phone-pad" />}<Field label="Password (10+ characters)" value={form.password} onChangeText={(password) => setForm({ ...form, password })} secureTextEntry /> <Action title={busy ? "Please wait..." : register ? "Create account" : "Sign in"} onPress={() => void submitAuth()} disabled={busy} /><Pressable onPress={() => setRegister(!register)}><Text style={styles.toggle}>{register ? "Already registered? Sign in" : "Create a farmer account"}</Text></Pressable></ScrollView>;

  return <ScrollView style={styles.screen} contentContainerStyle={styles.content}><View style={styles.header}><Text style={styles.brand}>CLIMATESHIELD <Text style={{ color: colors.lime }}>NEXUS</Text></Text><Text style={styles.eyebrow}>{!online ? "OFFLINE" : failedCount ? `${failedCount} FAILED` : pendingCount ? `${pendingCount} PENDING` : "ONLINE · SYNCED"}</Text></View><Text style={styles.eyebrow}>FARM CLIMATE DESK / KENYA</Text><Text style={styles.title}>Habari, {user.name.split(" ")[0]}.</Text><Text style={styles.body}>Your farms and climate information.</Text>{!online && <View style={styles.banner}><Text style={styles.bannerText}>Offline mode. New assessments need a connection; saved records remain on this device.</Text></View>}<View style={styles.sectionHeader}><Text style={styles.sectionTitle}>My farms</Text><Pressable onPress={() => setAddFarm(!addFarm)}><Text style={styles.link}>{addFarm ? "Cancel" : "+ Add farm"}</Text></Pressable></View>{addFarm && <View style={styles.formCard}><Field label="Farm name" value={farmForm.name} onChangeText={(name) => setFarmForm({ ...farmForm, name })} /><Field label="County" value={farmForm.county} onChangeText={(county) => setFarmForm({ ...farmForm, county })} /><Field label="Locality" value={farmForm.locality} onChangeText={(locality) => setFarmForm({ ...farmForm, locality })} /><Field label="Crop" value={farmForm.crop} onChangeText={(crop) => setFarmForm({ ...farmForm, crop })} /><View style={styles.inline}><Field label="Latitude (optional)" value={farmForm.latitude} onChangeText={(latitude) => setFarmForm({ ...farmForm, latitude })} keyboardType="decimal-pad" /><Field label="Longitude (optional)" value={farmForm.longitude} onChangeText={(longitude) => setFarmForm({ ...farmForm, longitude })} keyboardType="decimal-pad" /></View><Action title="Use current GPS" onPress={() => void useGps()} secondary /><Action title="Save farm" onPress={() => void saveFarm()} disabled={busy} /></View>}{farms.map((farm) => <View style={styles.card} key={farm.id}><Text style={styles.crop}>{farm.crop.toUpperCase()}</Text><Text style={styles.cardTitle}>{farm.name}</Text><Text style={styles.body}>{farm.locality}, {farm.county}</Text><Text style={styles.muted}>{farm.latitude ? `${farm.latitude}, ${farm.longitude}` : "Locality location · no coordinates"}</Text><View style={styles.inline}><Action title="Live forecast" onPress={() => void runAssessment(farm, "open-meteo")} secondary disabled={!online || busy || !farm.latitude} /><Action title="Demo assessment" onPress={() => void runAssessment(farm, "demo-synthetic")} disabled={!online || busy} /></View></View>)}{farms.length === 0 && <View style={styles.card}><Text style={styles.cardTitle}>No farm registered</Text><Text style={styles.body}>Add a farm with a manual locality or optional GPS coordinates.</Text></View>}<View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Assessments</Text><Pressable onPress={() => void refresh()}><Text style={styles.link}>Refresh</Text></Pressable></View>{assessments.map((assessment) => <View style={styles.card} key={assessment.id}><Text style={styles.demo}>{assessment.provenance.simulated ? "SIMULATED INPUT · NOT A FORECAST" : "OPEN-METEO PROVIDER DATA"}</Text><Text style={styles.cardTitle}>{assessment.farm.name}</Text>{assessment.risks.map((risk) => <View style={styles.riskRow} key={risk.riskType}><Text style={styles.riskTitle}>{risk.riskType.replaceAll("_", " ")} · {risk.level}</Text><Text style={styles.body}>{risk.explanation}</Text><Text style={styles.muted}>{risk.method}</Text></View>)}{assessment.recommendations.map((item) => <View style={styles.recommendation} key={item.title}><Text style={styles.riskTitle}>{item.title}</Text><Text style={styles.body}>{item.action}</Text><Text style={styles.muted}>{item.limitation}</Text></View>)}<Text style={styles.muted}>Limitations: {assessment.uncertainty.join(" ")}</Text></View>)}<Pressable style={styles.signout} onPress={signOut}><Text style={styles.link}>Sign out</Text></Pressable></ScrollView>;
}

function Field(props: { label: string; value: string; onChangeText: (value: string) => void; secureTextEntry?: boolean; keyboardType?: "default" | "email-address" | "phone-pad" | "decimal-pad"; autoCapitalize?: "none" | "sentences" }) {
  return <View style={styles.field}><Text style={styles.label}>{props.label}</Text><TextInput style={styles.input} value={props.value} onChangeText={props.onChangeText} secureTextEntry={props.secureTextEntry} keyboardType={props.keyboardType ?? "default"} autoCapitalize={props.autoCapitalize} placeholderTextColor="#a2aaa3" /></View>;
}

function Action({ title, onPress, secondary, disabled }: { title: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <Pressable onPress={onPress} disabled={disabled} style={[styles.button, secondary && styles.secondary, disabled && styles.disabled]}><Text style={[styles.buttonText, secondary && styles.secondaryText]}>{title}</Text></Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper }, content: { padding: 20, paddingTop: 58, paddingBottom: 42 }, auth: { flexGrow: 1, justifyContent: "center", padding: 25, paddingTop: 70, backgroundColor: colors.forest },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: colors.forest, marginHorizontal: -20, marginTop: -58, paddingHorizontal: 20, paddingVertical: 16, marginBottom: 28 }, brand: { color: colors.white, fontSize: 12, fontWeight: "700", letterSpacing: 1 }, eyebrow: { color: colors.muted, fontSize: 10, fontWeight: "600", letterSpacing: 1, marginBottom: 8 }, hero: { color: colors.white, fontSize: 35, fontWeight: "600", lineHeight: 41, marginVertical: 12, maxWidth: 330 }, title: { color: colors.ink, fontSize: 31, fontWeight: "600", marginBottom: 4 }, body: { color: colors.muted, fontSize: 13, lineHeight: 19 }, muted: { color: "#8a958c", fontSize: 10, lineHeight: 15, marginTop: 7 }, field: { marginTop: 12, flex: 1 }, label: { color: "#59675f", fontSize: 11, fontWeight: "600", marginBottom: 6 }, input: { height: 43, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, paddingHorizontal: 11, color: colors.ink, borderRadius: 2, fontSize: 14 }, button: { minHeight: 42, borderRadius: 2, backgroundColor: colors.forest, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, marginTop: 12 }, buttonText: { color: colors.white, fontSize: 12, fontWeight: "700" }, secondary: { backgroundColor: "#e8eee1", borderWidth: 1, borderColor: "#d6e0d2" }, secondaryText: { color: colors.forest }, disabled: { opacity: 0.5 }, toggle: { textAlign: "center", color: colors.lime, marginTop: 19, fontSize: 12 }, banner: { backgroundColor: "#f5eddb", borderWidth: 1, borderColor: "#ead8b4", padding: 11, marginTop: 17 }, bannerText: { color: colors.amber, fontSize: 11, lineHeight: 16 }, sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 27, marginBottom: 10 }, sectionTitle: { color: colors.ink, fontSize: 21, fontWeight: "600" }, link: { color: "#3e684c", fontSize: 12, fontWeight: "700" }, card: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, padding: 15, marginTop: 9 }, formCard: { backgroundColor: "#fff", padding: 14, borderWidth: 1, borderColor: colors.line }, crop: { color: "#69836a", fontSize: 9, fontWeight: "700", letterSpacing: 1 }, cardTitle: { color: colors.ink, fontSize: 17, fontWeight: "600", marginTop: 7, marginBottom: 4 }, inline: { flexDirection: "row", gap: 8 }, demo: { alignSelf: "flex-start", color: colors.amber, backgroundColor: "#f9edda", fontSize: 9, fontWeight: "700", paddingHorizontal: 7, paddingVertical: 5 }, riskRow: { borderTopWidth: 1, borderColor: "#edf0ea", paddingVertical: 10, marginTop: 9 }, riskTitle: { color: colors.ink, fontSize: 12, fontWeight: "700", marginBottom: 4 }, recommendation: { backgroundColor: "#f3f6ef", padding: 10, marginTop: 8 }, signout: { alignSelf: "center", padding: 20 },
});