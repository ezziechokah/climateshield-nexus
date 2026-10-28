import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, CloudRain, CloudSun, Droplets, Leaf, LogOut, MapPin, Menu, Plus, RefreshCw, ShieldAlert, ThermometerSun, Wifi, WifiOff } from "lucide-react";
import "./style.css";

type User = { id: string; email: string; name: string; role: string; language: string };
type Farm = { id: string; name: string; county: string; locality: string; latitude: number | null; longitude: number | null; crop: string; irrigation: string };
type Risk = { riskType: string; level: string; explanation: string; inputValue: number | null; unit: string; method: string };
type Recommendation = { riskType: string; title: string; action: string; why: string; limitation: string };
type Assessment = { id: string; farmId: string; farm: Farm; period: string; climate: { precipitationNext7DaysMm: number | null; maximumTemperatureC: number | null }; risks: Risk[]; recommendations: Recommendation[]; provenance: { source: string; simulated: boolean; retrievedAt: string; freshness: string; attribution: string }; uncertainty: string[]; assessedAt: string };
type EvaluationSummary = { farmers: number; farms: number; assessments: number; feedback: Array<{ understandable: number; useful: number; acted_on: number }>; note: string };
const API = "/api";
const cacheKey = (userId: string) => `climateshield-cache-v1:${userId}`;
const feedbackQueueKey = (userId: string) => `climateshield-pending-feedback:${userId}`;
const farmQueueKey = (userId: string) => `climateshield-pending-farms:${userId}`;

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState("");
  const [csrfToken, setCsrfToken] = useState("");
  const [farms, setFarms] = useState<Farm[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [message, setMessage] = useState("");
  const [showFarmForm, setShowFarmForm] = useState(false);
  const [authMode, setAuthMode] = useState<"register" | "login">("register");
  const [recoveryToken, setRecoveryToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
  const [recoveryRequested, setRecoveryRequested] = useState(false);
  const [selectedAssessment, setSelectedAssessment] = useState<Assessment | null>(null);
  const [language, setLanguage] = useState<"en" | "sw">("en");
  const [ussdText, setUssdText] = useState("");
  const [ussdReply, setUssdReply] = useState("");
  const [ussdSession, setUssdSession] = useState(() => crypto.randomUUID());
  const [smsCommand, setSmsCommand] = useState("HELP");
  const [smsReply, setSmsReply] = useState("");
  const [evaluation, setEvaluation] = useState<EvaluationSummary | null>(null);
  const [syncSummary, setSyncSummary] = useState({ pending: 0, failed: 0 });

  useEffect(() => {
    localStorage.removeItem("climateshield-token");
    localStorage.removeItem("climateshield-user");
    localStorage.removeItem("climateshield-cache-v1");
    localStorage.removeItem("climateshield-pending-feedback");
    localStorage.removeItem("climateshield-pending-farms");
    const onlineHandler = () => setOnline(true);
    const offlineHandler = () => setOnline(false);
    window.addEventListener("online", onlineHandler);
    window.addEventListener("offline", offlineHandler);
    return () => { window.removeEventListener("online", onlineHandler); window.removeEventListener("offline", offlineHandler); };
  }, []);

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const mutation = init.method && init.method !== "GET";
    const authBootstrap = path === "/auth/login" || path === "/auth/register";
    const response = await fetch(`${API}${path}`, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(mutation ? { "Idempotency-Key": crypto.randomUUID() } : {}), ...(csrfToken && mutation ? { "X-CSRF-Token": csrfToken } : {}), ...(authBootstrap ? { "X-Client-Channel": "web" } : {}), ...(token && token !== "cookie-session" ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? `Request failed (${response.status})`);
    return response.status === 204 ? undefined as T : response.json();
  }

  useEffect(() => {
    let active = true;
    void request<{ user: User; csrfToken: string | null }>("/auth/session").then((session) => {
      if (!active || !session.csrfToken) return;
      setUser(session.user); setToken("cookie-session"); setCsrfToken(session.csrfToken);
    }).catch(() => {
      if (active) { setUser(null); setToken(""); setCsrfToken(""); }
    });
    return () => { active = false; };
  }, []);

  async function refresh() {
    if (!token) return;
    try {
      await syncPendingFarms();
      const [farmResult, assessmentResult] = await Promise.all([request<{ farms: Farm[] }>("/farms"), request<{ assessments: Assessment[] }>("/assessments")]);
      setFarms(farmResult.farms);
      setAssessments(assessmentResult.assessments);
      localStorage.setItem(cacheKey(user!.id), JSON.stringify({ farms: farmResult.farms, assessments: assessmentResult.assessments, syncedAt: new Date().toISOString() }));
      setMessage("");
      await syncPendingFeedback();
    } catch (error) {
      const cached = user ? JSON.parse(localStorage.getItem(cacheKey(user.id)) ?? "null") : null;
      const expired = error instanceof Error && error.message.includes("401");
      if (cached && !expired) { setFarms(cached.farms); setAssessments(cached.assessments); }
      if (expired && user) {
        localStorage.removeItem(cacheKey(user.id));
        setFarms([]); setAssessments([]); setUser(null); setToken(""); setCsrfToken("");
        setMessage("Your session expired. Unsynced changes are preserved on this device. Sign in again to sync them.");
      }
      setMessage(error instanceof Error ? `${error.message} Showing saved information when available.` : "Unable to refresh data.");
    }
  }

  async function syncPendingFeedback() {
    if (!user) return;
    const key = feedbackQueueKey(user.id);
    const operations = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<Record<string, unknown> & { syncState?: string }>;
    for (let index = 0; index < operations.length; index++) {
      const item = operations[index];
      if (item.syncState === "SYNCED" || item.syncState === "FAILED" || item.syncState === "CONFLICT") continue;
      item.syncState = "SYNCING";
      localStorage.setItem(key, JSON.stringify(operations));
      try { await request("/feedback", { method: "POST", headers: { "Idempotency-Key": String(item.idempotencyKey) }, body: JSON.stringify(item) }); item.syncState = "SYNCED"; item.syncError = ""; }
      catch (error) {
        const status = error instanceof Error ? Number(error.message.match(/\((\d+)\)$/)?.[1]) : 0;
        item.syncState = status === 409 ? "CONFLICT" : [400, 401, 403, 404].includes(status) ? "FAILED" : "PENDING";
        item.syncError = status ? `HTTP ${status}` : "NETWORK";
      }
    }
    localStorage.setItem(key, JSON.stringify(operations));
    updateSyncSummary();
  }

  async function syncPendingFarms() {
    if (!user) return;
    const key = farmQueueKey(user.id);
    const operations = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{ idempotencyKey: string; payload: Record<string, unknown>; syncState?: string; syncError?: string }>;
    for (let index = 0; index < operations.length; index++) {
      const item = operations[index];
      if (item.syncState === "SYNCED" || item.syncState === "FAILED" || item.syncState === "CONFLICT") continue;
      item.syncState = "SYNCING";
      localStorage.setItem(key, JSON.stringify(operations));
      try { await request("/farms", { method: "POST", headers: { "Idempotency-Key": item.idempotencyKey }, body: JSON.stringify(item.payload) }); item.syncState = "SYNCED"; item.syncError = ""; }
      catch (error) {
        const status = error instanceof Error ? Number(error.message.match(/\((\d+)\)$/)?.[1]) : 0;
        item.syncState = status === 409 ? "CONFLICT" : [400, 401, 403, 404].includes(status) ? "FAILED" : "PENDING";
        item.syncError = status ? `HTTP ${status}` : "NETWORK";
        continue;
      }
      item.syncState = "SYNCED"; item.syncError = "";
    }
    localStorage.setItem(key, JSON.stringify(operations));
    updateSyncSummary();
  }

  function updateSyncSummary() {
    if (!user) return;
    const farmOps = JSON.parse(localStorage.getItem(farmQueueKey(user.id)) ?? "[]") as Array<{ syncState?: string }>;
    const feedbackOps = JSON.parse(localStorage.getItem(feedbackQueueKey(user.id)) ?? "[]") as Array<{ syncState?: string }>;
    const operations = [...farmOps, ...feedbackOps];
    setSyncSummary({ pending: operations.filter((operation) => !operation.syncState || operation.syncState === "PENDING" || operation.syncState === "SYNCING").length,
      failed: operations.filter((operation) => operation.syncState === "FAILED" || operation.syncState === "CONFLICT").length });
  }

  async function retryFailedOperations() {
    if (!user) return;
    for (const key of [farmQueueKey(user.id), feedbackQueueKey(user.id)]) {
      const operations = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{ syncState?: string; syncError?: string }>;
      for (const operation of operations) if (operation.syncState === "FAILED" || operation.syncState === "CONFLICT") { operation.syncState = "PENDING"; operation.syncError = ""; }
      localStorage.setItem(key, JSON.stringify(operations));
    }
    updateSyncSummary();
    await refresh();
  }

  useEffect(() => { void refresh(); }, [token, online]);
  useEffect(() => { updateSyncSummary(); }, [user]);

  async function authenticate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    try {
      const path = authMode === "register" ? "/auth/register" : "/auth/login";
      const result = await request<{ token?: string; csrfToken?: string; user: User }>(path, { method: "POST", body: JSON.stringify(data) });
      setToken(result.token ?? "cookie-session"); setUser(result.user); setCsrfToken(result.csrfToken ?? "");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to authenticate."); }
    finally { setBusy(false); }
  }

  async function requestRecovery(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      await request("/auth/recovery/request", { method: "POST", body: JSON.stringify({ email: formData.get("email") }) });
      setRecoveryRequested(true);
      setMessage("If the account exists, recovery instructions will be sent through the configured channel.");
    } catch { setMessage("If the account exists, recovery instructions will be sent through the configured channel."); }
  }

  async function completeRecovery(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") ?? "");
    const confirmation = String(formData.get("confirmation") ?? "");
    if (password !== confirmation) { setMessage("Passwords do not match."); return; }
    try {
      await request("/auth/recovery/complete", { method: "POST", body: JSON.stringify({ token: recoveryToken, password }) });
      setRecoveryToken("");
      window.history.replaceState({}, "", window.location.pathname);
      setAuthMode("login");
      setMessage("Password updated. Sign in with your new password.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Recovery token is invalid or expired."); }
  }

  async function createFarm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const latitude = data.latitude ? Number(data.latitude) : null;
    const longitude = data.longitude ? Number(data.longitude) : null;
    const payload = { ...data, latitude, longitude, locationSource: "manual", plantingDate: data.plantingDate || null };
    if (!navigator.onLine) {
      const key = farmQueueKey(user!.id);
      const pending = JSON.parse(localStorage.getItem(key) ?? "[]");
      localStorage.setItem(key, JSON.stringify([...pending, { idempotencyKey: crypto.randomUUID(), payload, syncState: "PENDING" }]));
      updateSyncSummary();
      setShowFarmForm(false); setMessage("Farm saved on this device. It will sync when you're online."); return;
    }
    setBusy(true);
    try {
      await request("/farms", { method: "POST", body: JSON.stringify(payload) });
      setShowFarmForm(false); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save farm."); }
    finally { setBusy(false); }
  }

  async function useGps() {
    if (!navigator.geolocation) { setMessage("Location is not available in this browser."); return; }
    navigator.geolocation.getCurrentPosition((position) => {
      const form = document.querySelector<HTMLFormElement>("#farm-form");
      if (!form) return;
      (form.elements.namedItem("latitude") as HTMLInputElement).value = String(position.coords.latitude);
      (form.elements.namedItem("longitude") as HTMLInputElement).value = String(position.coords.longitude);
      setMessage("Coordinates filled from this device. Review before saving.");
    }, () => setMessage("Location permission was denied or unavailable. You can enter coordinates manually."), { enableHighAccuracy: false, timeout: 10000 });
  }

  async function assess(farm: Farm, source: "demo-synthetic" | "open-meteo") {
    setBusy(true);
    try {
      const result = await request<Assessment>(`/farms/${farm.id}/assess`, { method: "POST", body: JSON.stringify({ source, latitude: farm.latitude, longitude: farm.longitude }) });
      const next = [result, ...assessments]; setAssessments(next); setSelectedAssessment(result);
      localStorage.setItem(cacheKey(user!.id), JSON.stringify({ farms, assessments: next, syncedAt: new Date().toISOString() }));
      setMessage("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Assessment failed."); }
    finally { setBusy(false); }
  }

  async function submitFeedback(assessment: Assessment, useful: boolean) {
    const payload = { idempotencyKey: crypto.randomUUID(), assessmentId: assessment.id, understandable: true, useful, actedOn: false, comment: "" };
    if (!navigator.onLine) {
      const key = feedbackQueueKey(user!.id);
      const pending = JSON.parse(localStorage.getItem(key) ?? "[]");
      localStorage.setItem(key, JSON.stringify([...pending, { ...payload, syncState: "PENDING" }]));
      updateSyncSummary();
      setMessage("Feedback saved on this device and will sync when online."); return;
    }
    try { await request("/feedback", { method: "POST", body: JSON.stringify(payload) }); setMessage("Feedback recorded. Thank you."); }
    catch { setMessage("Feedback could not be sent."); }
  }

  async function simulateUssd() {
    try {
      const result = await request<{ response: string; completed: boolean }>("/simulation/ussd", { method: "POST", body: JSON.stringify({ sessionId: ussdSession, text: ussdText }) });
      setUssdReply(result.response);
      setUssdText("");
      if (result.completed) { setUssdSession(crypto.randomUUID()); await refresh(); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "USSD simulator unavailable."); }
  }

  async function simulateSms() {
    try {
      const result = await request<{ status: string; message: string }>("/simulation/sms", { method: "POST", body: JSON.stringify({ action: "inbound", message: smsCommand, phone: user ? undefined : "+254700000001" }) });
      setSmsReply(`${result.status}: ${result.message}`);
    } catch (error) { setSmsReply(error instanceof Error ? error.message : "SMS simulator unavailable."); }
  }

  async function loadEvaluation() {
    try { setEvaluation(await request<EvaluationSummary>("/evaluation/summary")); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Evaluation access denied."); }
  }

  async function exportEvaluation() {
    try {
      const response = await fetch(`${API}/evaluation/export.csv`, { credentials: "include" });
      if (!response.ok) throw new Error("Evaluation export is unavailable for this account.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = "climateshield-evaluation.csv"; link.click(); URL.revokeObjectURL(url);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Export failed."); }
  }

  async function logout() {
    if (user && !window.confirm("Sign out and remove this account's cached farm data and unsynced changes from this browser?")) return;
    try { await request("/auth/logout", { method: "POST" }); }
    catch {
      setMessage("Sign out needs a connection so the server can revoke this session. Your local data has been kept.");
      return;
    }
    if (user) {
      localStorage.removeItem(cacheKey(user.id));
      localStorage.removeItem(feedbackQueueKey(user.id));
      localStorage.removeItem(farmQueueKey(user.id));
    }
    setToken(""); setUser(null); setCsrfToken("");
  }

  const latest = selectedAssessment ?? assessments[0] ?? null;
  const latestCached = user ? JSON.parse(localStorage.getItem(cacheKey(user.id)) ?? "null")?.syncedAt as string | undefined : undefined;

  if (recoveryToken) return <main className="auth-shell"><div className="auth-art"><div className="brand"><div className="brand-mark"><Leaf size={19} /></div><span>CLIMATESHIELD <b>NEXUS</b></span></div><div className="auth-art-copy"><span className="eyebrow">ACCOUNT RECOVERY</span><h1>Set a new<br /><i>password.</i></h1><p>This one-time recovery link expires shortly after it was requested.</p></div><div className="terrain-lines" /></div><section className="auth-panel"><div className="auth-panel-top"><span>SECURE ACCOUNT RECOVERY</span></div><div className="auth-content"><span className="eyebrow">NEW CREDENTIAL</span><h2>Choose a password</h2><form className="form-stack" onSubmit={(event) => void completeRecovery(event)}><label>New password<input name="password" type="password" required minLength={10} autoComplete="new-password" /></label><label>Confirm password<input name="confirmation" type="password" required minLength={10} autoComplete="new-password" /></label><button className="button primary wide">Update password</button></form>{message && <p className="notice error">{message}</p>}</div><div className="auth-footer">CLIMATESHIELD NEXUS <span>ONE-TIME LINK</span></div></section></main>;

  if (!user || !token) return <main className="auth-shell">
    <div className="auth-art"><div className="brand"><div className="brand-mark"><Leaf size={19} /></div><span>CLIMATESHIELD <b>NEXUS</b></span></div><div className="auth-art-copy"><span className="eyebrow">FARM CLIMATE DESK / KENYA</span><h1>Better decisions<br />start with <i>what's<br />changing.</i></h1><p>Climate information made practical for the farm, and honest about what it cannot tell you.</p><div className="weather-stamp"><CloudSun size={21} /><span>LOCAL DEMO READY</span></div></div><div className="terrain-lines" /></div>
    <section className="auth-panel"><div className="auth-panel-top"><span>FARMER ACCESS</span><div className="lang-switch"><button onClick={() => setLanguage("en")} className={language === "en" ? "active" : ""}>EN</button><button onClick={() => setLanguage("sw")} className={language === "sw" ? "active" : ""}>SW</button></div></div><div className="auth-content"><span className="eyebrow">{authMode === "register" ? "GET STARTED" : "WELCOME BACK"}</span><h2>{authMode === "register" ? "Create your account" : "Sign in to your farm"}</h2><p className="muted">Your farm information stays under your account.</p><form onSubmit={authenticate} className="form-stack">{authMode === "register" && <label>Full name<input name="name" required minLength={2} placeholder="e.g. Wanjiku Kamau" /></label>}<label>Email address<input name="email" type="email" required placeholder="you@example.com" /></label>{authMode === "register" && <label>Phone number<input name="phone" required pattern="\+[1-9][0-9]{7,14}" placeholder="+2547..." /><small>Use international format, including country code.</small></label>}<label>Password<input name="password" type="password" required minLength={authMode === "register" ? 10 : 1} placeholder={authMode === "register" ? "At least 10 characters" : "Your password"} /></label>{authMode === "register" && <input type="hidden" name="language" value={language} />}<button className="button primary wide" disabled={busy}>{busy ? "Please wait..." : authMode === "register" ? "Create account" : "Sign in"}</button></form>{authMode === "login" && <button className="button text" type="button" onClick={() => setRecoveryRequested(true)}>Forgot password?</button>}{recoveryRequested && <form className="form-stack" onSubmit={(event) => void requestRecovery(event)}><label>Account email<input name="email" type="email" required placeholder="you@example.com" /></label><button className="button secondary" type="submit">Request recovery link</button><button className="button text" type="button" onClick={() => setRecoveryRequested(false)}>Back to sign in</button></form>}{message && <p className="notice error">{message}</p>}<p className="auth-toggle">{authMode === "register" ? "Already registered?" : "New to ClimateShield?"} <button onClick={() => { setMessage(""); setAuthMode(authMode === "register" ? "login" : "register"); }}>{authMode === "register" ? "Sign in" : "Create an account"}</button></p><p className="privacy-note"><ShieldAlert size={14} /> Demonstration service. Climate thresholds and guidance are not locally validated.</p></div><div className="auth-footer">CLIMATESHIELD NEXUS <span>DECISION SUPPORT, NOT A GUARANTEE</span></div></section>
  </main>;

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><Leaf size={19} /></div><span>CLIMATESHIELD <b>NEXUS</b></span></div><div className="sidebar-label">WORKSPACE</div><button className="nav-item active"><Activity size={17} /> Overview</button><button className="nav-item" onClick={() => setShowFarmForm(true)}><MapPin size={17} /> Farms</button><button className="nav-item" onClick={() => document.getElementById("assessment-history")?.scrollIntoView({ behavior: "smooth" })}><CloudSun size={17} /> Assessments</button><div className="sidebar-bottom"><div className="help-card"><span className="mini-label">DATA STATUS</span><p>{online ? "Connected" : "Offline mode"}</p><small>{latestCached ? `Saved ${new Date(latestCached).toLocaleString()}` : "No synchronized data yet"}</small></div><button className="nav-item" onClick={logout}><LogOut size={17} /> Sign out</button><div className="profile"><div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div><div><b>{user.name}</b><small>{user.role.toLowerCase().replace("_", " ")}</small></div><Menu size={16} /></div></div></aside>
    <main className="main-area"><header className="topbar"><div className="crumb">NEXUS <span>/</span> FARM OVERVIEW</div><div className="topbar-right"><span className={`connection ${online ? "online" : "offline"}`}>{online ? <Wifi size={14} /> : <WifiOff size={14} />}{online ? "ONLINE" : "OFFLINE"}</span><button className="icon-button" title="Refresh saved information" onClick={() => void refresh()}><RefreshCw size={17} /></button><div className="avatar small">{user.name.slice(0, 1).toUpperCase()}</div></div></header>
      <div className="page-content"><div className="welcome-row"><div><span className="eyebrow">TUESDAY, 27 OCTOBER 2026 <span className="dot-sep">/</span> KENYA</span><h1>Good day, {user.name.split(" ")[0]}.</h1><p>Here's the climate picture for your farms.</p></div><button className="button primary" onClick={() => setShowFarmForm(true)}><Plus size={17} /> Add farm</button></div>
      {!online && <div className="offline-banner"><WifiOff size={17} /><span><b>You're offline.</b> Showing the last saved information on this device. New assessments need a connection.</span></div>}
      {(syncSummary.pending > 0 || syncSummary.failed > 0) && <div className={`sync-summary ${syncSummary.failed ? "sync-failed" : ""}`} role="status"><span>{syncSummary.failed ? `${syncSummary.failed} changes need attention` : `${syncSummary.pending} changes pending sync`}</span>{syncSummary.failed > 0 && online && <button className="button secondary" onClick={() => void retryFailedOperations()}>Retry failed changes</button>}</div>}
      {message && <div className="notice"><span>{message}</span><button onClick={() => setMessage("")}>Dismiss</button></div>}
      <div className="status-ribbon"><div className="status-icon"><ShieldAlert size={17} /></div><div><b>{latest?.provenance?.simulated ? "DEMONSTRATION DATA" : latest ? "PROVIDER DATA" : "READY FOR YOUR FIRST FARM"}</b><span>{latest ? `${latest.provenance.source.replaceAll("_", " ")} · ${latest.provenance.attribution}` : "Add a farm, then choose a climate source to generate an assessment."}</span></div><span className="ribbon-right">{latest ? `UPDATED ${new Date(latest.assessedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "NO ASSESSMENT"}</span></div>
      {user.role === "ADMIN" && <section className="admin-panel"><div><span className="eyebrow">RESTRICTED VIEW</span><h2>Evaluation records</h2></div><div className="admin-actions"><button className="button secondary" onClick={() => void loadEvaluation()}>Load summary</button><button className="button text" onClick={() => void exportEvaluation()}>Export feedback CSV</button></div>{evaluation && <><div className="admin-metrics"><span><b>{evaluation.farmers}</b> FARMERS</span><span><b>{evaluation.farms}</b> FARMS</span><span><b>{evaluation.assessments}</b> ASSESSMENTS</span><span><b>{evaluation.feedback.length}</b> FEEDBACK</span></div><small>{evaluation.note}</small></>}</section>}
      <div className="section-heading"><div><span className="eyebrow">YOUR LAND</span><h2>Farm locations</h2></div><span className="count-label">{farms.length} {farms.length === 1 ? "FARM" : "FARMS"}</span></div>
      {farms.length === 0 ? <div className="empty-state"><div className="empty-icon"><MapPin size={22} /></div><div><b>No farms registered yet</b><p>Add a farm using a county, locality, or optional coordinates. GPS permission is only requested when you choose it.</p></div><button className="button secondary" onClick={() => setShowFarmForm(true)}>Add first farm <Plus size={15} /></button></div> : <div className="farm-grid">{farms.map((farm) => <article className="farm-card" key={farm.id}><div className="farm-card-top"><div className="crop-symbol"><Leaf size={18} /></div><span className="crop-tag">{farm.crop}</span></div><h3>{farm.name}</h3><div className="location-line"><MapPin size={14} /> {farm.locality}, {farm.county}</div><div className="farm-meta"><span>{farm.latitude != null && farm.longitude != null ? `${farm.latitude.toFixed(3)}, ${farm.longitude.toFixed(3)}` : "Locality-level location"}</span><span>IRRIGATION: {farm.irrigation}</span></div><div className="farm-actions"><button className="button text" disabled={busy || !online} onClick={() => void assess(farm, "open-meteo")}><CloudSun size={15} /> Live forecast</button><button className="button secondary" disabled={busy || !online} onClick={() => void assess(farm, "demo-synthetic")}>Demo assessment</button></div></article>)}</div>}
      {latest && <><div className="section-heading assessment-heading"><div><span className="eyebrow">RISK SCREENING <span className="dot-sep">/</span> {latest.period.toUpperCase()}</span><h2>Climate assessment</h2></div><span className={`source-pill ${latest.provenance.simulated ? "demo" : "live"}`}>{latest.provenance.simulated ? "SIMULATED" : "LIVE SOURCE"}</span></div><div className="metrics-grid">{latest.risks.map((risk) => {const Icon = risk.riskType === "DRY_SPELL" ? Droplets : risk.riskType === "HEAVY_RAIN" ? CloudRain : ThermometerSun;return <article className="metric" key={risk.riskType}><div className="metric-top"><span>{risk.riskType.replaceAll("_", " ")}</span><Icon size={18} /></div><div className="metric-value">{risk.level === "INSUFFICIENT_DATA" ? "--" : risk.level}<i className={`risk-dot ${risk.level.toLowerCase()}`} /></div><p>{risk.explanation}</p><small>{risk.method}</small></article>;})}</div><div className="section-heading recommendation-heading"><div><span className="eyebrow">RULE-BASED GUIDANCE</span><h2>Actions to consider</h2></div><span className="count-label">{latest.recommendations.length} SUGGESTIONS</span></div>{latest.recommendations.length ? <div className="recommendation-list">{latest.recommendations.map((item) => <article className="recommendation" key={item.riskType}><div className="recommendation-mark"><Leaf size={17} /></div><div className="recommendation-copy"><div className="recommendation-title"><h3>{item.title}</h3><span>{item.riskType.replaceAll("_", " ")}</span></div><p>{item.action}</p><small><b>Why:</b> {item.why} {item.limitation}</small></div><div className="feedback-buttons"><button title="Helpful" onClick={() => void submitFeedback(latest, true)}>Useful</button><button title="Not helpful" onClick={() => void submitFeedback(latest, false)}>Not useful</button></div></article>)}</div> : <div className="empty-state compact"><p>No elevated screening bands or there is insufficient data. Continue monitoring official local advice.</p></div>}<div className="uncertainty-note"><ShieldAlert size={16} /><span><b>Limitations</b> {latest.uncertainty.join(" ")} For crop-specific guidance, consult a qualified agricultural extension officer.</span></div></>}
      <div className="section-heading history-heading" id="assessment-history"><div><span className="eyebrow">BASIC PHONE CHANNEL</span><h2>USSD and SMS simulator</h2></div><span className="source-pill demo">LOCAL SIMULATOR</span></div><div className="channel-grid"><section className="channel-panel"><b>USSD registration</b><p>Advance the provider-independent menu one reply at a time. Completion creates a local demo farmer and farm record.</p><div className="ussd-screen">{ussdReply || "Welcome to ClimateShield Nexus\n1. English\n2. Kiswahili"}</div><div className="channel-controls"><input aria-label="USSD reply" value={ussdText} onChange={(event) => setUssdText(event.target.value)} placeholder="Reply with a menu choice" /><button className="button secondary" onClick={() => void simulateUssd()}>Send reply</button><button className="icon-button" title="Restart USSD session" onClick={() => { setUssdSession(crypto.randomUUID()); setUssdReply(""); }}><RefreshCw size={15} /></button></div></section><section className="channel-panel"><b>Inbound SMS command</b><p>Test HELP, INFO, or STOP processing. This records a simulator event; it does not contact a mobile network.</p><div className="channel-controls"><select aria-label="SMS command" value={smsCommand} onChange={(event) => setSmsCommand(event.target.value)}><option>HELP</option><option>INFO</option><option>STOP</option></select><button className="button secondary" onClick={() => void simulateSms()}>Process command</button></div>{smsReply && <div className="channel-result">{smsReply}</div>}</section></div>
      <div className="section-heading history-heading" id="assessment-history"><div><span className="eyebrow">SAVED RECORDS</span><h2>Assessment history</h2></div><span className="count-label">{assessments.length} RECORDS</span></div>{assessments.length ? <div className="history-table"><div className="table-head"><span>FARM</span><span>DATE</span><span>DATA SOURCE</span><span>SCREENING</span><span /></div>{assessments.map((assessment) => <button className="table-row" key={assessment.id} onClick={() => setSelectedAssessment(assessment)}><span><b>{assessment.farm.name}</b><small>{assessment.farm.locality}, {assessment.farm.county}</small></span><span>{new Date(assessment.assessedAt).toLocaleDateString()}</span><span className={assessment.provenance.simulated ? "table-sim" : "table-live"}>{assessment.provenance.simulated ? "DEMO" : "OPEN-METEO"}</span><span>{assessment.risks.filter((risk) => ["MODERATE", "HIGH"].includes(risk.level)).length} elevated</span><span>›</span></button>)}</div> : <div className="empty-state compact"><p>Your climate assessments will appear here. Select live forecast when you have coordinates and a connection, or demo assessment to explore the workflow.</p></div>}
      <footer className="page-footer"><span>CLIMATESHIELD NEXUS <b>0.1 / LOCAL DEMO</b></span><span>Decision support only · Not a weather warning service</span></footer>
      </div>
    </main>
    {showFarmForm && <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setShowFarmForm(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="farm-modal-title"><div className="modal-head"><div><span className="eyebrow">FARM REGISTRY</span><h2 id="farm-modal-title">Add a farm</h2></div><button className="icon-button" aria-label="Close" onClick={() => setShowFarmForm(false)}>×</button></div><form id="farm-form" className="form-grid" onSubmit={createFarm}><label className="span-2">Farm name<input name="name" required placeholder="Home farm" /></label><label>County<input name="county" required placeholder="e.g. Nakuru" /></label><label>Locality<input name="locality" required placeholder="Town or locality" /></label><label>Crop<input name="crop" required placeholder="e.g. Maize" /></label><label>Planting date<input name="plantingDate" type="date" /></label><label>Irrigation<select name="irrigation"><option value="unknown">Unknown</option><option value="none">None</option><option value="limited">Limited</option><option value="available">Available</option></select></label><div className="span-2 coordinate-row"><label>Latitude<input name="latitude" type="number" step="any" min="-4.8" max="5.2" placeholder="Optional" /></label><label>Longitude<input name="longitude" type="number" step="any" min="33.8" max="42.2" placeholder="Optional" /></label><button type="button" className="button secondary gps-button" onClick={() => void useGps()}><MapPin size={14} /> Use GPS</button></div><p className="form-help span-2">Coordinates are optional. Kenya bounds are checked by the API. GPS is requested only when you tap the button.</p><button className="button primary span-2" disabled={busy}>Save farm</button></form></section></div>}
  </div>;
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<React.StrictMode><App /></React.StrictMode>);