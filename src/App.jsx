import { useState, useEffect, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

// ─── SUPABASE LITE CLIENT ────────────────────────────────────────────────────
function createSupabase(url, key) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  const q = (table) => ({
    _table: table,
    _filters: [],
    _order: null,
    _limit: null,
    eq(col, val) { this._filters.push(`${col}=eq.${val}`); return this; },
    gte(col, val) { this._filters.push(`${col}=gte.${val}`); return this; },
    lte(col, val) { this._filters.push(`${col}=lte.${val}`); return this; },
    order(col, { ascending = true } = {}) { this._order = `${col}.${ascending ? "asc" : "desc"}`; return this; },
    limit(n) { this._limit = n; return this; },
    async select(cols = "*") {
      let url2 = `${url}/rest/v1/${this._table}?select=${cols}`;
      if (this._filters.length) url2 += "&" + this._filters.join("&");
      if (this._order) url2 += `&order=${this._order}`;
      if (this._limit) url2 += `&limit=${this._limit}`;
      const r = await fetch(url2, { headers });
      if (!r.ok) throw new Error(await r.text());
      return { data: await r.json(), error: null };
    },
    async insert(data) {
      const r = await fetch(`${url}/rest/v1/${this._table}`, {
        method: "POST", headers,
        body: JSON.stringify(Array.isArray(data) ? data : [data]),
      });
      if (!r.ok) throw new Error(await r.text());
      return { data: await r.json(), error: null };
    },
    async upsert(data) {
      const r = await fetch(`${url}/rest/v1/${this._table}`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=representation,resolution=merge-duplicates" },
        body: JSON.stringify(Array.isArray(data) ? data : [data]),
      });
      if (!r.ok) throw new Error(await r.text());
      return { data: await r.json(), error: null };
    },
    async update(data) {
      let url2 = `${url}/rest/v1/${this._table}?`;
      if (this._filters.length) url2 += this._filters.join("&");
      const r = await fetch(url2, {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error(await r.text());
      return { data: await r.json(), error: null };
    },
    async delete() {
      let url2 = `${url}/rest/v1/${this._table}?`;
      if (this._filters.length) url2 += this._filters.join("&");
      const r = await fetch(url2, { method: "DELETE", headers });
      if (!r.ok) throw new Error(await r.text());
      return { data: null, error: null };
    },
  });
  return { from: (table) => q(table) };
}

// ─── SQL SCHEMA ──────────────────────────────────────────────────────────────
const SCHEMA_SQL = `
-- 1. Drop old tables (if migrating)
drop table if exists workouts cascade;
drop table if exists exercise_goals cascade;
drop table if exists nutrition_logs cascade;
drop table if exists coach_memory cascade;

-- 2. New schema
create table exercises (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  muscle_group text,
  goal text,
  notes text,
  created_at timestamptz default now()
);
create table workout_logs (
  id uuid primary key default gen_random_uuid(),
  exercise_id uuid references exercises(id) on delete cascade,
  weight_kg numeric,
  sets integer,
  reps integer,
  notes text,
  logged_at timestamptz default now()
);
create table weight_logs (
  id uuid primary key default gen_random_uuid(),
  weight_kg numeric not null,
  logged_at timestamptz default now()
);
create table chat_history (
  id uuid primary key default gen_random_uuid(),
  role text not null,
  content text not null,
  logged_at timestamptz default now()
);
create index on workout_logs(exercise_id);
create index on workout_logs(logged_at desc);
create index on weight_logs(logged_at desc);
grant select, insert, update, delete on exercises to anon;
grant select, insert, update, delete on workout_logs to anon;
grant select, insert, update, delete on weight_logs to anon;
grant select, insert, update, delete on chat_history to anon;
`.trim();

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const today = () => new Date().toLocaleDateString("sv"); // "YYYY-MM-DD" local time
const msAgo = (days) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(0, 0, 0, 0); return d; };
const fmtDate = (iso) => { const d = new Date(iso); return `${d.getDate()}.${d.getMonth() + 1}.`; };
const fmtDayFull = (isoDate) => {
  const d = new Date(isoDate + "T12:00:00");
  const dayNames = ["Nedjelja", "Ponedjeljak", "Utorak", "Srijeda", "Četvrtak", "Petak", "Subota"];
  return `${dayNames[d.getDay()]}, ${d.getDate()}. ${d.getMonth() + 1}.`;
};
const epley1RM = (weight, reps) => weight && reps ? (weight * (1 + reps / 30)).toFixed(1) : null;
const parseGoalWeight = (str) => { const m = str?.match(/(\d+(?:[.,]\d+)?)/); return m ? parseFloat(m[1].replace(",", ".")) : null; };

// ─── AI TOOLS DEFINITION ─────────────────────────────────────────────────────
const AI_TOOLS = [
  {
    name: "save_workout",
    description: "Spremi workout log. Pozovi kad korisnik spominje trening, vježbu, serije, reps ili kilažu na vježbi. weight_kg je opcionalan za bodyweight vježbe.",
    input_schema: {
      type: "object",
      properties: {
        exercise_name: { type: "string", description: "Naziv vježbe — poveži s postojećom iz biblioteke ako postoji, inače kreiraj novu" },
        weight_kg: { type: "number", description: "Težina u kg — opcionalno za bodyweight" },
        sets: { type: "integer", description: "Broj serija" },
        reps: { type: "integer", description: "Broj ponavljanja" },
        notes: { type: "string", description: "Kratka napomena, opcionalno" },
      },
      required: ["exercise_name", "sets", "reps"],
    },
  },
  {
    name: "save_weight",
    description: "Spremi tjelesnu masu korisnika. Pozovi kad korisnik spominje svoju kilažu, vaganje ili tjelesnu težinu.",
    input_schema: {
      type: "object",
      properties: { weight_kg: { type: "number", description: "Tjelesna masa u kg" } },
      required: ["weight_kg"],
    },
  },
];

// ─── SETUP SCREEN ────────────────────────────────────────────────────────────
function SetupScreen({ onSave }) {
  const [sbUrl, setSbUrl] = useState("");
  const [sbKey, setSbKey] = useState("");
  const [aiKey, setAiKey] = useState("");
  const [tab, setTab] = useState("keys");

  return (
    <div style={styles.setupWrap}>
      <div style={styles.setupCard}>
        <div style={styles.setupLogo}>💪</div>
        <h1 style={styles.setupTitle}>FitCoach AI</h1>
        <p style={styles.setupSub}>Tvoj osobni AI trener</p>

        <div style={styles.tabRow}>
          {["keys", "schema"].map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{ ...styles.tabBtn, ...(tab === t ? styles.tabBtnActive : {}) }}>
              {t === "keys" ? "🔑 API Ključevi" : "🗄️ SQL Schema"}
            </button>
          ))}
        </div>

        {tab === "keys" ? (
          <div style={styles.fields}>
            <label style={styles.label}>Supabase URL</label>
            <input style={styles.input} placeholder="https://xxxx.supabase.co"
              value={sbUrl} onChange={e => setSbUrl(e.target.value)} />
            <label style={styles.label}>Supabase Anon Key</label>
            <input style={styles.input} placeholder="eyJ..."
              value={sbKey} onChange={e => setSbKey(e.target.value)} />
            <label style={styles.label}>Anthropic API Key</label>
            <input style={styles.input} type="password" placeholder="sk-ant-..."
              value={aiKey} onChange={e => setAiKey(e.target.value)} />
            <button style={styles.saveBtn}
              onClick={() => sbUrl && sbKey && aiKey && onSave(sbUrl.trim(), sbKey.trim(), aiKey.trim())}>
              Pokreni App →
            </button>
            <p style={styles.hint}>Ključevi se čuvaju samo u ovom browseru (localStorage)</p>
          </div>
        ) : (
          <div style={styles.fields}>
            <p style={styles.schemaNote}>Kopiraj i pokreni ovo u <b>Supabase → SQL Editor</b>:</p>
            <pre style={styles.schemaPre}>{SCHEMA_SQL}</pre>
            <button style={styles.copyBtn} onClick={() => navigator.clipboard.writeText(SCHEMA_SQL)}>
              📋 Kopiraj SQL
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  const [creds, setCreds] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("fitcoach_creds") || "null");
      if (saved?.sbUrl && saved?.sbKey && saved?.aiKey) return saved;
    } catch {}
    // Fall back to Vercel env vars (set in Vercel project settings)
    const envCreds = {
      sbUrl: import.meta.env.VITE_SB_URL,
      sbKey: import.meta.env.VITE_SB_KEY,
      aiKey: import.meta.env.VITE_AI_KEY,
    };
    if (envCreds.sbUrl && envCreds.sbKey && envCreds.aiKey) {
      localStorage.setItem("fitcoach_creds", JSON.stringify(envCreds));
      return envCreds;
    }
    return null;
  });
  const [tab, setTab] = useState("chat");
  const [sb, setSb] = useState(null);

  // data
  const [exercises, setExercises] = useState([]);
  const [workoutLogs, setWorkoutLogs] = useState([]);
  const [weights, setWeights] = useState([]);
  const [messages, setMessages] = useState([]);

  // ui state
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveMsg, setSaveMsg] = useState("");

  // napredak
  const [selectedExercise, setSelectedExercise] = useState(null);
  const [napredakRange, setNapredakRange] = useState(30);
  const [showExForm, setShowExForm] = useState(false);
  const [editingExercise, setEditingExercise] = useState(null); // exercise being edited
  const [dnevnikModal, setDnevnikModal] = useState(null); // { name, logs }
  const [dayModal, setDayModal] = useState(null); // { date, logs }
  const [editLogModal, setEditLogModal] = useState(null); // { log } — edit existing workout_log
  const [addToDaySession, setAddToDaySession] = useState(null); // session_id | "new" | null

  // forms
  const [exForm, setExForm] = useState({ name: "", muscle_group: "Ostalo", baseline: "", goal: "", notes: "" });
  const [logForm, setLogForm] = useState({ exercise_id: "", weight_kg: "", sets: "", reps: "", notes: "" });
  const [wtForm, setWtForm] = useState({ weight_kg: "" });
  const [sessionQueue, setSessionQueue] = useState([]); // pending exercises before saving
  const [editLogForm, setEditLogForm] = useState({ exercise_id: "", weight_kg: "", sets: "", reps: "", notes: "" });

  const chatEndRef = useRef(null);
  const logKgRef = useRef(null);
  const logSetiRef = useRef(null);
  const logRepsRef = useRef(null);

  useEffect(() => {
    if (creds) setSb(createSupabase(creds.sbUrl, creds.sbKey));
  }, [creds]);

  useEffect(() => {
    if (!sb) return;
    loadAll();
  }, [sb]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Scroll to bottom when switching to chat tab
  useEffect(() => {
    if (tab === "chat") {
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "instant" }), 50);
    }
  }, [tab]);

  const flash = (msg) => { setSaveMsg(msg); setTimeout(() => setSaveMsg(""), 2500); };

  // ── loadAll ────────────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    if (!sb) return;
    try {
      const [ex, wl, wt, ch] = await Promise.all([
        sb.from("exercises").order("name", { ascending: true }).select(),
        sb.from("workout_logs").order("logged_at", { ascending: false }).limit(100).select("*,exercises(id,name,muscle_group,goal)"),
        sb.from("weight_logs").order("logged_at", { ascending: false }).limit(60).select(),
        sb.from("chat_history").order("logged_at", { ascending: true }).limit(50).select(),
      ]);
      setExercises(ex.data || []);
      setWorkoutLogs(wl.data || []);
      setWeights(wt.data || []);
      if (ch.data?.length) {
        setMessages(ch.data.map(r => ({ role: r.role, content: r.content })));
      } else {
        setMessages([{ role: "assistant", content: "Bok! Ja sam tvoj AI fitness coach. 💪\n\nDodaj vježbe u biblioteku (tab Vježbe), pa mi reci što si trenirao." }]);
      }
    } catch (e) {
      setError("Greška pri učitavanju: " + e.message);
    } finally {
      setDataLoading(false);
    }
  }, [sb]);

  // ── buildContext ───────────────────────────────────────────────────────────
  const buildContext = useCallback(() => {
    const exSummary = exercises.map(e =>
      `${e.name}${e.muscle_group ? ` [${e.muscle_group}]` : ""}${e.baseline ? ` | Početak: ${e.baseline}` : ""}${e.goal ? ` | Cilj: ${e.goal}` : ""}`
    ).join("\n");

    const logSummary = workoutLogs.slice(0, 20).map(l =>
      `${l.logged_at?.split("T")[0]} | ${l.exercises?.name || "?"} | ${l.weight_kg ? l.weight_kg + "kg" : "bodyweight"} | ${l.sets}×${l.reps}${l.notes ? " | " + l.notes : ""}`
    ).join("\n");

    const wtSummary = weights.slice(0, 10).map(w =>
      `${w.logged_at?.split("T")[0]} | ${w.weight_kg}kg`
    ).join("\n");

    const progressSummary = exercises.map(e => {
      const logs = workoutLogs
        .filter(l => l.exercise_id === e.id)
        .sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at));
      if (logs.length === 0) return `${e.name}: nema logova`;
      const first = logs[0];
      const last = logs[logs.length - 1];
      const diff = last.weight_kg && first.weight_kg
        ? ` (${(last.weight_kg - first.weight_kg) >= 0 ? "+" : ""}${(last.weight_kg - first.weight_kg).toFixed(1)}kg)`
        : "";
      return `${e.name}: početak ${first.weight_kg || "BW"}kg ${first.sets}×${first.reps} → zadnji ${last.weight_kg || "BW"}kg ${last.sets}×${last.reps}${diff}`;
    }).join("\n");

    const dayNames = ["Nedjelja", "Ponedjeljak", "Utorak", "Srijeda", "Četvrtak", "Petak", "Subota"];
    const now = new Date();

    return `Ti si AI fitness coach specijaliziran za snažni trening i breaking (bboying). Govoriš kratko, direktno, motivirajuće. Hrvatski jezik.
Fokus: snaga, napredak na vježbama, podrška za powermovse.
Ne odgovaraj na pitanja koja nisu vezana uz trening, kilažu ili oporavak.

VJEŽBE KORISNIKA:
${exSummary || "nema još — predloži korisniku da doda vježbe u biblioteku (tab Vježbe)"}

ZADNJIH 20 TRENINGA:
${logSummary || "nema podataka"}

KILAZA:
${wtSummary || "nema podataka"}

NAPREDAK PO VJEŽBAMA:
${progressSummary || "nema podataka"}

Danas je: ${now.toISOString().split("T")[0]} (${dayNames[now.getDay()]})

PRAVILA:
- Kad korisnik logira trening → pohvali i usporedi s prošlim logom
- Ako nema prethodnog loga → postavi kao baseline
- Ako kilaza pada → komentiraj i predloži akciju
- Uvijek znaš gdje je korisnik u odnosu na cilj
- Ako nema vježbi u biblioteci → predloži dodavanje`;
  }, [exercises, workoutLogs, weights]);

  // ── sendMessage with tool-use loop ────────────────────────────────────────
  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");

    const newMessages = [...messages, { role: "user", content: userMsg }];
    setMessages(newMessages);
    setLoading(true);

    if (sb) {
      await sb.from("chat_history").insert({ role: "user", content: userMsg, logged_at: new Date().toISOString() });
    }

    try {
      let apiMessages = newMessages.slice(-50).map(m => ({ role: m.role, content: m.content }));
      let finalReply = "";
      let currentExercises = exercises; // local copy for tool loop

      // Tool-use loop (max 3 iterations to avoid infinite loops)
      for (let iter = 0; iter < 3; iter++) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": creds.aiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            system: buildContext(),
            tools: AI_TOOLS,
            tool_choice: { type: "auto" },
            messages: apiMessages,
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`);

        // Grab any text block
        const textBlock = data.content?.find(b => b.type === "text");
        if (textBlock?.text) finalReply = textBlock.text;

        // No tool calls → done
        if (data.stop_reason !== "tool_use") break;

        // Process each tool call
        const toolUseBlocks = data.content.filter(b => b.type === "tool_use");
        const toolResults = [];

        for (const tc of toolUseBlocks) {
          let result = "ok";
          try {
            if (tc.name === "save_workout") {
              const { exercise_name, weight_kg, sets, reps, notes } = tc.input;

              // Find exercise (case-insensitive) in local copy
              let ex = currentExercises.find(e =>
                e.name.toLowerCase() === exercise_name.toLowerCase()
              );

              // Not found → insert new exercise, refresh
              if (!ex) {
                await sb.from("exercises").insert({ name: exercise_name });
                const updated = await sb.from("exercises").order("name").select();
                currentExercises = updated.data || [];
                setExercises(currentExercises);
                ex = currentExercises.find(e =>
                  e.name.toLowerCase() === exercise_name.toLowerCase()
                );
              }

              if (ex) {
                await sb.from("workout_logs").insert({
                  exercise_id: ex.id,
                  weight_kg: weight_kg ?? null,
                  sets: sets ?? null,
                  reps: reps ?? null,
                  notes: notes ?? null,
                  logged_at: new Date().toISOString(),
                });
                result = `Saved: ${exercise_name}${weight_kg ? " " + weight_kg + "kg" : ""} ${sets}×${reps}`;
              } else {
                result = "Error: could not find or create exercise";
              }

            } else if (tc.name === "save_weight") {
              const todayStr = today();
              const alreadyLogged = weights.some(w =>
                new Date(w.logged_at).toLocaleDateString("sv") === todayStr
              );
              if (!alreadyLogged) {
                await sb.from("weight_logs").insert({
                  weight_kg: tc.input.weight_kg,
                  logged_at: new Date().toISOString(),
                });
                result = `Saved weight: ${tc.input.weight_kg}kg`;
              } else {
                result = "Weight already logged today — skipped";
              }
            }
          } catch (e) {
            result = "Error: " + e.message;
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: result,
          });
        }

        // Continue loop with tool results
        apiMessages = [
          ...apiMessages,
          { role: "assistant", content: data.content },
          { role: "user", content: toolResults },
        ];

        // Refresh all data after saves
        await loadAll();
      }

      if (!finalReply) finalReply = "✓";

      const updatedMessages = [...newMessages, { role: "assistant", content: finalReply }];
      setMessages(updatedMessages);

      if (sb) {
        await sb.from("chat_history").insert({
          role: "assistant", content: finalReply, logged_at: new Date().toISOString()
        });
      }

    } catch (e) {
      setMessages([...newMessages, { role: "assistant", content: "⚠️ Greška: " + e.message }]);
    } finally {
      setLoading(false);
    }
  };

  // ── Exercise handlers ──────────────────────────────────────────────────────
  const saveExercise = async () => {
    if (!sb || !exForm.name.trim()) return;
    const data = {
      name: exForm.name.trim(),
      muscle_group: exForm.muscle_group || null,
      baseline: exForm.baseline.trim() || null,
      goal: exForm.goal.trim() || null,
      notes: exForm.notes.trim() || null,
    };
    try {
      if (editingExercise) {
        await sb.from("exercises").eq("id", editingExercise.id).update(data);
        setEditingExercise(null);
        flash("✓ Vježba ažurirana");
      } else {
        await sb.from("exercises").insert(data);
        flash("✓ Vježba dodana");
      }
      setExForm({ name: "", muscle_group: "Ostalo", baseline: "", goal: "", notes: "" });
      setShowExForm(false);
      await loadAll();
    } catch (e) {
      setError("Greška: " + e.message);
    }
  };

  const deleteExercise = async (id) => {
    if (!sb || !confirm("Obriši vježbu i sve logove?")) return;
    await sb.from("exercises").eq("id", id).delete();
    if (selectedExercise?.id === id) setSelectedExercise(null);
    await loadAll();
  };

  // ── Queue: dodaj vježbu u pending listu ───────────────────────────────────
  const addToQueue = () => {
    if (!logForm.exercise_id || !logForm.sets || !logForm.reps) return;
    const ex = exercises.find(e => e.id === logForm.exercise_id);
    setSessionQueue(q => [...q, {
      exercise_id: logForm.exercise_id,
      exercise_name: ex?.name || "?",
      weight_kg: parseFloat(logForm.weight_kg) || null,
      sets: parseInt(logForm.sets),
      reps: parseInt(logForm.reps),
      notes: logForm.notes.trim() || null,
    }]);
    setLogForm({ exercise_id: logForm.exercise_id, weight_kg: "", sets: "", reps: "", notes: "" });
  };

  // ── Queue: spremi cijeli trening odjednom ─────────────────────────────────
  const saveSession = async () => {
    if (!sb) return;
    // Dodaj trenutnu formu u queue ako je popunjena
    let finalQueue = [...sessionQueue];
    if (logForm.exercise_id && logForm.sets && logForm.reps) {
      const ex = exercises.find(e => e.id === logForm.exercise_id);
      finalQueue = [...finalQueue, {
        exercise_id: logForm.exercise_id,
        exercise_name: ex?.name || "?",
        weight_kg: parseFloat(logForm.weight_kg) || null,
        sets: parseInt(logForm.sets),
        reps: parseInt(logForm.reps),
        notes: logForm.notes.trim() || null,
      }];
    }
    if (finalQueue.length === 0) return;
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await Promise.all(finalQueue.map(ex =>
        sb.from("workout_logs").insert({
          exercise_id: ex.exercise_id,
          weight_kg: ex.weight_kg,
          sets: ex.sets,
          reps: ex.reps,
          notes: ex.notes,
          session_id: sessionId,
          logged_at: now,
        })
      ));
      setSessionQueue([]);
      setLogForm({ exercise_id: "", weight_kg: "", sets: "", reps: "", notes: "" });
      flash(`✓ ${finalQueue.length} vježbi spremljeno`);
      await loadAll();
    } catch (e) {
      setError("Greška: " + e.message);
    }
  };

  // ── Dodaj vježbu u postojeći dan ──────────────────────────────────────────
  const addToDay = async (date, sessionId) => {
    if (!sb || !logForm.exercise_id || !logForm.sets || !logForm.reps) return;
    const sid = (!sessionId || sessionId === "new") ? crypto.randomUUID() : sessionId;
    try {
      await sb.from("workout_logs").insert({
        exercise_id: logForm.exercise_id,
        weight_kg: parseFloat(logForm.weight_kg) || null,
        sets: parseInt(logForm.sets),
        reps: parseInt(logForm.reps),
        notes: logForm.notes.trim() || null,
        session_id: sid,
        logged_at: date + "T12:00:00.000Z",
      });
      // Keep form open for same session, just reset fields
      setLogForm({ exercise_id: "", weight_kg: "", sets: "", reps: "", notes: "" });
      setAddToDaySession(sid); // stay on same session
      // Fetch fresh logs directly (avoids stale closure)
      const fresh = await sb.from("workout_logs")
        .order("logged_at", { ascending: true })
        .select("*, exercises(name, muscle_group, goal)");
      const updated = (fresh.data || []).filter(l => new Date(l.logged_at).toLocaleDateString("sv") === date);
      setDayModal(d => d ? { ...d, logs: updated } : null);
      await loadAll();
    } catch (e) {
      setError("Greška: " + e.message);
    }
  };

  // ── Edit postojećeg log unosa ──────────────────────────────────────────────
  const updateLog = async () => {
    if (!sb || !editLogModal) return;
    try {
      await sb.from("workout_logs").eq("id", editLogModal.log.id).update({
        exercise_id: editLogForm.exercise_id,
        weight_kg: parseFloat(editLogForm.weight_kg) || null,
        sets: parseInt(editLogForm.sets),
        reps: parseInt(editLogForm.reps),
        notes: editLogForm.notes.trim() || null,
      });
      setEditLogModal(null);
      flash("✓ Log ažuriran");
      await loadAll();
    } catch (e) {
      setError("Greška: " + e.message);
    }
  };

  // ── Obriši log unos ───────────────────────────────────────────────────────
  const deleteLog = async (id) => {
    if (!sb) return;
    await sb.from("workout_logs").eq("id", id).delete();
    await loadAll();
  };

  // ── Weight log handler ─────────────────────────────────────────────────────
  const logWeight = async () => {
    if (!sb || !wtForm.weight_kg) return;
    try {
      await sb.from("weight_logs").insert({
        weight_kg: parseFloat(wtForm.weight_kg),
        logged_at: new Date().toISOString(),
      });
      setWtForm({ weight_kg: "" });
      flash("✓ Kilaza spremljena");
      await loadAll();
    } catch (e) {
      setError("Greška: " + e.message);
    }
  };

  // ── Derived stats ──────────────────────────────────────────────────────────
  const latestWeight = weights[0]?.weight_kg;
  const refWeight = weights.find(w => new Date(w.logged_at) < msAgo(5))?.weight_kg;
  const weightDiff = latestWeight && refWeight ? (latestWeight - refWeight).toFixed(1) : null;

  const weekAgo = msAgo(7);
  const weekLogs = workoutLogs.filter(l => new Date(l.logged_at) >= weekAgo);
  const weekDays = new Set(weekLogs.map(l => l.logged_at?.split("T")[0])).size;

  const lastLogDate = workoutLogs[0]?.logged_at;
  const daysSinceLast = lastLogDate
    ? Math.floor((new Date() - new Date(lastLogDate)) / 86400000)
    : null;
  const lastTrainLabel = daysSinceLast === null ? "—" : daysSinceLast === 0 ? "Danas" : `${daysSinceLast}d`;

  // ── Setup screen ───────────────────────────────────────────────────────────
  if (!creds) return <SetupScreen onSave={(sbUrl, sbKey, aiKey) => {
    const c = { sbUrl, sbKey, aiKey };
    localStorage.setItem("fitcoach_creds", JSON.stringify(c));
    setCreds(c);
  }} />;

  // ── Napredak exercise data ─────────────────────────────────────────────────
  const exLogs = selectedExercise
    ? workoutLogs
        .filter(l => l.exercise_id === selectedExercise.id)
        .sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at))
    : [];
  const firstLog = exLogs[0];
  const lastExLog = exLogs[exLogs.length - 1];
  const prLog = exLogs.reduce((best, l) =>
    (!best || (l.weight_kg || 0) > (best.weight_kg || 0)) ? l : best, null);
  const goalWeight = selectedExercise ? parseGoalWeight(selectedExercise.goal) : null;
  const progressPct = goalWeight && firstLog?.weight_kg && lastExLog?.weight_kg
    ? Math.min(100, Math.max(0, Math.round(
        ((lastExLog.weight_kg - firstLog.weight_kg) / (goalWeight - firstLog.weight_kg)) * 100
      )))
    : 0;
  const oneRM = lastExLog ? epley1RM(lastExLog.weight_kg, lastExLog.reps) : null;

  const exChartData = exLogs.map(l => ({
    date: fmtDate(l.logged_at),
    kg: l.weight_kg,
    reps: l.reps,
    fullDate: l.logged_at?.split("T")[0],
  }));

  // Weight trend
  const weightCutoff = napredakRange === "all" ? new Date(0) : msAgo(napredakRange);
  const wtChartData = weights
    .filter(w => new Date(w.logged_at) >= weightCutoff)
    .sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at))
    .map(w => ({ date: fmtDate(w.logged_at), kg: w.weight_kg }));

  const lastLogForSelected = logForm.exercise_id
    ? workoutLogs.find(l => l.exercise_id === logForm.exercise_id)
    : null;

  // Workouts grouped by local date (last 21 days)
  const workoutsByDay = workoutLogs
    .filter(l => new Date(l.logged_at) >= msAgo(21))
    .reduce((acc, l) => {
      const date = new Date(l.logged_at).toLocaleDateString("sv"); // local YYYY-MM-DD
      if (!acc[date]) acc[date] = [];
      acc[date].push(l);
      return acc;
    }, {});
  const sortedDays = Object.keys(workoutsByDay).sort((a, b) => b > a ? 1 : -1);

  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div style={styles.app}>

      {/* HEADER */}
      <div style={styles.header}>
        <span style={styles.headerLogo}>💪</span>
        <span style={styles.headerTitle}>FitCoach AI</span>
        <button style={styles.resetBtn} onClick={() => {
          if (confirm("Odjavi se?")) { localStorage.removeItem("fitcoach_creds"); setCreds(null); }
        }}>⚙️</button>
      </div>

      {/* ERROR BANNER */}
      {error && (
        <div style={styles.errorBanner} onClick={() => setError(null)}>
          ⚠️ {error} <span style={{ opacity: 0.7 }}>✕</span>
        </div>
      )}

      {/* STATS BAR */}
      <div style={styles.statsBar}>
        <div style={styles.stat}>
          <span style={styles.statVal}>{latestWeight ? `${latestWeight}kg` : "—"}</span>
          <span style={styles.statLbl}>Kilaza</span>
          {weightDiff !== null && (
            <span style={{ ...styles.statDiff, color: Number(weightDiff) > 0 ? C.red : C.green }}>
              {Number(weightDiff) > 0 ? "▲" : "▼"}{Math.abs(weightDiff)}
            </span>
          )}
        </div>
        <div style={styles.statDiv} />
        <div style={styles.stat}>
          <span style={styles.statVal}>{weekDays || "—"}</span>
          <span style={styles.statLbl}>Treninga/tjedan</span>
        </div>
        <div style={styles.statDiv} />
        <div style={styles.stat}>
          <span style={styles.statVal}>{lastTrainLabel}</span>
          <span style={styles.statLbl}>Zadnji trening</span>
        </div>
      </div>

      {/* CONTENT */}
      <div style={styles.content}>

        {/* ── TAB: COACH ──────────────────────────────────────────────────── */}
        {tab === "chat" && (
          <div style={styles.chatWrap}>
            <div style={styles.chatMessages}>
              {dataLoading && (
                <div style={styles.skeletonWrap}>
                  {[1, 2, 3].map(i => <div key={i} style={{ ...styles.skeleton, width: i % 2 === 0 ? "60%" : "80%", alignSelf: i % 2 === 0 ? "flex-end" : "flex-start" }} />)}
                </div>
              )}
              {!dataLoading && messages.map((m, i) => (
                <div key={i} style={{ ...styles.msg, ...(m.role === "user" ? styles.msgUser : styles.msgAssistant) }}>
                  {m.role === "assistant" && <span style={styles.msgAvatar}>🤖</span>}
                  <div style={{ ...styles.msgBubble, ...(m.role === "user" ? styles.bubbleUser : styles.bubbleAssistant) }}>
                    {m.content.split("\n").map((line, j, arr) => {
                      const html = line
                        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                        .replace(/\*(.+?)\*/g, "<em>$1</em>");
                      return (
                        <span key={j}>
                          <span dangerouslySetInnerHTML={{ __html: html }} />
                          {j < arr.length - 1 && <br />}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
              {loading && (
                <div style={styles.msg}>
                  <span style={styles.msgAvatar}>🤖</span>
                  <div style={styles.bubbleAssistant}>
                    <span style={styles.typing}>● ● ●</span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div style={styles.chatInput}>
              <input
                style={styles.chatField}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
                placeholder="Bench 100kg 4x8, kilaza 82kg..."
                disabled={loading}
              />
              <button style={styles.sendBtn} onClick={sendMessage} disabled={loading}>
                {loading ? "⏳" : "→"}
              </button>
            </div>
          </div>
        )}

        {/* ── TAB: VJEŽBE ─────────────────────────────────────────────────── */}
        {tab === "vjezbe" && (
          <div style={styles.scrollWrap}>
            {saveMsg && <div style={styles.saveToast}>{saveMsg}</div>}

            {/* Add exercise — collapsible */}
            <button
              style={{ ...styles.addExBtn, ...(showExForm ? styles.addExBtnActive : {}) }}
              onClick={() => setShowExForm(v => !v)}
            >
              <span>{showExForm ? "✕ Zatvori" : "＋ Nova vježba"}</span>
            </button>

            {showExForm && (
              <div style={styles.card}>
                <input style={styles.fi} placeholder="Naziv vježbe (npr. Bench Press)" value={exForm.name}
                  onChange={e => setExForm({ ...exForm, name: e.target.value })} />
                <select style={styles.fi} value={exForm.muscle_group}
                  onChange={e => setExForm({ ...exForm, muscle_group: e.target.value })}>
                  {["Prsa", "Leđa", "Noge", "Ramena", "Ruke", "Core", "Ostalo"].map(g => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
                <input style={styles.fi} placeholder="Početno stanje (npr. 60kg 4×6)" value={exForm.baseline}
                  onChange={e => setExForm({ ...exForm, baseline: e.target.value })} />
                <input style={styles.fi} placeholder="Cilj (npr. 120kg 4×8)" value={exForm.goal}
                  onChange={e => setExForm({ ...exForm, goal: e.target.value })} />
                <input style={styles.fi} placeholder="Napomena (opcionalno)" value={exForm.notes}
                  onChange={e => setExForm({ ...exForm, notes: e.target.value })} />
                <button style={styles.logBtn} onClick={saveExercise}>
                  {editingExercise ? "Spremi izmjene" : "Dodaj u biblioteku"}
                </button>
                {editingExercise && (
                  <button style={{ ...styles.logBtn, background: C.border, marginTop: 6 }} onClick={() => {
                    setEditingExercise(null);
                    setExForm({ name: "", muscle_group: "Ostalo", baseline: "", goal: "", notes: "" });
                    setShowExForm(false);
                  }}>Odustani</button>
                )}
              </div>
            )}

            {/* Exercise library */}
            {exercises.length > 0 && (
              <div style={styles.card}>
                <h3 style={styles.cardTitle}>📚 Biblioteka vježbi</h3>
                {exercises.map(ex => {
                  const lastLog = workoutLogs.find(l => l.exercise_id === ex.id);
                  return (
                    <div key={ex.id} style={styles.exRow}>
                      <div style={styles.exLeft} onClick={() => { setSelectedExercise(ex); setTab("napredak"); }}>
                        <span style={styles.exName}>{ex.name}</span>
                        {ex.muscle_group && <span style={styles.exGroup}>{ex.muscle_group}</span>}
                        {ex.goal && <span style={styles.exGoal}>🎯 {ex.goal}</span>}
                        {lastLog && (
                          <span style={styles.exLast}>
                            Zadnji: {lastLog.weight_kg ? lastLog.weight_kg + "kg " : "BW "}
                            {lastLog.sets}×{lastLog.reps} — {fmtDate(lastLog.logged_at)}
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button style={styles.deleteBtn} onClick={() => {
                          setEditingExercise(ex);
                          setExForm({ name: ex.name, muscle_group: ex.muscle_group || "Ostalo", baseline: ex.baseline || "", goal: ex.goal || "", notes: ex.notes || "" });
                          setShowExForm(true);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}>✏️</button>
                        <button style={styles.deleteBtn} onClick={() => deleteExercise(ex.id)}>✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {exercises.length === 0 && !dataLoading && (
              <p style={styles.empty}>Nema vježbi. Dodaj prvu gore. ☝️</p>
            )}

            {/* Weight log */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>⚖️ Kilaza</h3>
              {latestWeight && (
                <p style={styles.lastLogHint}>Zadnja: {latestWeight}kg ({fmtDate(weights[0]?.logged_at)})</p>
              )}
              <div style={styles.row2}>
                <input style={{ ...styles.fi, marginBottom: 0 }} placeholder="kg" type="number" step="0.1"
                  value={wtForm.weight_kg} onChange={e => setWtForm({ weight_kg: e.target.value })} />
                <button style={{ ...styles.logBtn, width: "auto", padding: "9px 20px" }} onClick={logWeight}>
                  Spremi
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB: DNEVNIK ────────────────────────────────────────────────── */}
        {tab === "dnevnik" && (
          <div style={styles.scrollWrap}>
            <button style={styles.addExBtn} onClick={() => {
              const todayDate = today();
              const todayLogs = workoutLogs.filter(l => new Date(l.logged_at).toLocaleDateString("sv") === todayDate);
              setDayModal({ date: todayDate, logs: todayLogs });
              setAddToDaySession(null);
            }}>
              ＋ Novi unos
            </button>
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>📅 Dnevnik treninga</h3>
              {sortedDays.length === 0 && (
                <p style={styles.empty}>Nema treninga zadnjih 21 dan.</p>
              )}
              {sortedDays.map(date => {
                // Grupiraj po session_id unutar dana
                const dayLogs = workoutsByDay[date];
                const sessionMap = {};
                dayLogs.forEach(l => {
                  const key = l.session_id || `solo-${l.id}`;
                  if (!sessionMap[key]) sessionMap[key] = [];
                  sessionMap[key].push(l);
                });
                const sessions = Object.values(sessionMap);
                return (
                <div key={date} style={styles.sessionBlock}>
                  <div
                    style={{ ...styles.sessionHeader, cursor: "pointer" }}
                    onClick={() => setDayModal({ date, logs: dayLogs })}
                  >
                    <span style={styles.sessionDate}>{fmtDayFull(date)}</span>
                    <span style={styles.sessionCount}>{dayLogs.length} vježbi ›</span>
                  </div>
                  {sessions.map((sLogs, si) => (
                    <div key={si} style={{ marginBottom: si < sessions.length - 1 ? 8 : 0 }}>
                      {sessions.length > 1 && (
                        <span style={styles.sessionLabel}>Trening {si + 1}</span>
                      )}
                      {sLogs.map((l, i) => (
                        <div key={i} style={styles.sessionRow}>
                          <span
                            style={{ ...styles.sessionEx, cursor: "pointer", textDecorationLine: "underline", textDecorationColor: C.border }}
                            onClick={() => {
                              const name = l.exercises?.name;
                              const ex = exercises.find(e => e.name === name);
                              if (!ex) return;
                              const logs = workoutLogs
                                .filter(wl => wl.exercise_id === ex.id)
                                .sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at));
                              setDnevnikModal({ name, logs });
                            }}
                          >
                            {l.exercises?.name || "?"}
                          </span>
                          <span style={styles.sessionResult}>
                            {l.weight_kg ? l.weight_kg + "kg " : "BW "}{l.sets}×{l.reps}
                            {l.notes ? <span style={styles.sessionNote}> · {l.notes}</span> : null}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              );
            })}
            </div>
          </div>
        )}

        {/* ── TAB: NAPREDAK ───────────────────────────────────────────────── */}
        {tab === "napredak" && (
          <div style={styles.scrollWrap}>

            {/* Exercise progress */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>💪 Napredak po vježbi</h3>
              <select style={styles.fi} value={selectedExercise?.id || ""}
                onChange={e => {
                  const ex = exercises.find(x => x.id === e.target.value);
                  setSelectedExercise(ex || null);
                }}>
                <option value="">— odaberi vježbu —</option>
                {exercises.map(ex => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
              </select>

              {selectedExercise && (
                <>
                  {/* Header */}
                  <div style={styles.progressHeader}>
                    <span style={styles.progressTitle}>{selectedExercise.name}</span>
                    {goalWeight && exLogs.length > 0 && <span style={styles.progressPct}>{progressPct}% do cilja</span>}
                  </div>

                  {/* Progress bar — samo ako ima logova i cilj */}
                  {goalWeight && exLogs.length > 0 && (
                    <div style={styles.progressBarBg}>
                      <div style={{ ...styles.progressBarFill, width: `${progressPct}%` }} />
                    </div>
                  )}

                  {/* Stats row — uvijek vidljivo */}
                  <div style={styles.statsRow}>
                    <div style={styles.statBox}>
                      <span style={styles.statBoxLbl}>Početak</span>
                      <span style={styles.statBoxVal}>
                        {selectedExercise.baseline ||
                          (firstLog ? (firstLog.weight_kg ? firstLog.weight_kg + "kg " : "BW ") + firstLog.sets + "×" + firstLog.reps : "—")}
                      </span>
                    </div>
                    <div style={styles.statBox}>
                      <span style={styles.statBoxLbl}>Zadnji</span>
                      <span style={styles.statBoxVal}>
                        {lastExLog
                          ? (lastExLog.weight_kg ? lastExLog.weight_kg + "kg " : "BW ") + lastExLog.sets + "×" + lastExLog.reps
                          : "—"}
                      </span>
                    </div>
                    <div style={styles.statBox}>
                      <span style={styles.statBoxLbl}>Cilj</span>
                      <span style={{ ...styles.statBoxVal, color: C.accent }}>
                        {selectedExercise.goal || "—"}
                      </span>
                    </div>
                    {oneRM && (
                      <div style={styles.statBox}>
                        <span style={styles.statBoxLbl}>Est. 1RM</span>
                        <span style={styles.statBoxVal}>{oneRM}kg</span>
                      </div>
                    )}
                  </div>

                  {/* Chart — samo ako ima 2+ logova */}
                  {exChartData.length > 1 && (
                    <div style={{ marginTop: 12 }}>
                      <ResponsiveContainer width="100%" height={160}>
                        <LineChart data={exChartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                          <XAxis dataKey="date" tick={{ fill: C.sub, fontSize: 10 }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fill: C.sub, fontSize: 10 }} axisLine={false} tickLine={false} />
                          <Tooltip
                            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
                            labelStyle={{ color: C.sub }}
                            itemStyle={{ color: C.text }}
                          />
                          {firstLog?.weight_kg && (
                            <ReferenceLine y={firstLog.weight_kg} stroke={C.sub} strokeDasharray="4 2"
                              label={{ value: "Baseline", fill: C.sub, fontSize: 9, position: "right" }} />
                          )}
                          {goalWeight && (
                            <ReferenceLine y={goalWeight} stroke={C.green} strokeDasharray="4 2"
                              label={{ value: "Cilj", fill: C.green, fontSize: 9, position: "right" }} />
                          )}
                          <Line type="monotone" dataKey="kg" stroke={C.accent} strokeWidth={2}
                            dot={{ fill: C.accent, r: 3 }} activeDot={{ r: 5 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  {/* Log history */}
                  {exLogs.length > 0 ? (
                    <div style={{ marginTop: 12 }}>
                      <p style={styles.sectionLabel}>Historija logova</p>
                      {[...exLogs].reverse().map((l, i) => {
                        const localDate = new Date(l.logged_at).toLocaleDateString("sv");
                        const dayLogs = workoutLogs.filter(wl =>
                          new Date(wl.logged_at).toLocaleDateString("sv") === localDate
                        );
                        return (
                        <div key={i} style={styles.histRow}>
                          <span
                            style={{ ...styles.histDate, cursor: "pointer", textDecorationLine: "underline", textDecorationColor: C.border }}
                            onClick={() => setDayModal({ date: localDate, logs: dayLogs })}
                          >
                            {fmtDayFull(l.logged_at?.split("T")[0])}
                          </span>
                          <span style={styles.histWeight}>
                            {l.weight_kg ? l.weight_kg + "kg" : "BW"} {l.sets}×{l.reps}
                          </span>
                          {l.notes && <span style={styles.histNote}>{l.notes}</span>}
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p style={{ ...styles.empty, marginTop: 12 }}>Još nema logova — idi na Vježbe i logiraj trening!</p>
                  )}
                </>
              )}
            </div>

            {/* Weight trend */}
            <div style={styles.card}>
              <div style={styles.cardHeader}>
                <h3 style={styles.cardTitle}>⚖️ Trend kilaze</h3>
                <div style={styles.rangeToggle}>
                  {[30, 60, "all"].map(r => (
                    <button key={r} onClick={() => setNapredakRange(r)}
                      style={{ ...styles.rangeBtn, ...(napredakRange === r ? styles.rangeBtnActive : {}) }}>
                      {r === "all" ? "Sve" : r + "d"}
                    </button>
                  ))}
                </div>
              </div>

              {wtChartData.length > 1 ? (
                <>
                  <ResponsiveContainer width="100%" height={160}>
                    <LineChart data={wtChartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                      <XAxis dataKey="date" tick={{ fill: C.sub, fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: C.sub, fontSize: 10 }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
                      <Tooltip
                        contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
                        labelStyle={{ color: C.sub }}
                        itemStyle={{ color: C.text }}
                      />
                      <Line type="monotone" dataKey="kg" stroke={C.accent} strokeWidth={2}
                        dot={{ fill: C.accent, r: 3 }} activeDot={{ r: 5 }} />
                    </LineChart>
                  </ResponsiveContainer>

                  {latestWeight && wtChartData[0]?.kg && (
                    <p style={styles.weightSummary}>
                      Trenutno: <strong style={{ color: C.text }}>{latestWeight}kg</strong>
                      {" | "}
                      Promjena: <strong style={{ color: Number(latestWeight) - wtChartData[0].kg > 0 ? C.red : C.green }}>
                        {(Number(latestWeight) - wtChartData[0].kg) >= 0 ? "+" : ""}
                        {(Number(latestWeight) - wtChartData[0].kg).toFixed(1)}kg
                      </strong>
                    </p>
                  )}
                </>
              ) : (
                <p style={styles.empty}>Nema dovoljno podataka o kilazi.</p>
              )}
            </div>

          </div>
        )}

      </div>

      {/* DNEVNIK MODAL */}
      {dnevnikModal && (
        <div style={styles.modalOverlay} onClick={() => setDnevnikModal(null)}>
          <div style={styles.modalSheet} onClick={e => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>{dnevnikModal.name}</span>
              <button style={styles.modalClose} onClick={() => setDnevnikModal(null)}>✕</button>
            </div>
            {dnevnikModal.logs.length === 0 ? (
              <p style={styles.empty}>Nema logova za ovu vježbu.</p>
            ) : (
              dnevnikModal.logs.map((l, i) => (
                <div key={i} style={styles.modalRow}>
                  <span style={styles.modalDate}>{fmtDayFull(l.logged_at.split("T")[0])}</span>
                  <span style={styles.modalResult}>
                    {l.weight_kg ? l.weight_kg + "kg " : "BW "}{l.sets}×{l.reps}
                    {l.notes ? <span style={styles.sessionNote}> · {l.notes}</span> : null}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* DAY MODAL */}
      {dayModal && (
        <div style={styles.modalOverlay} onClick={() => { setDayModal(null); setAddToDaySession(null); }}>
          <div style={styles.modalSheet} onClick={e => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>{fmtDayFull(dayModal.date)}</span>
              <button style={styles.modalClose} onClick={() => { setDayModal(null); setAddToDaySession(null); }}>✕</button>
            </div>
            {(() => {
              const sessionMap = {};
              const sessionOrder = [];
              dayModal.logs.forEach(l => {
                const key = l.session_id || `solo-${l.id}`;
                if (!sessionMap[key]) { sessionMap[key] = []; sessionOrder.push(key); }
                sessionMap[key].push(l);
              });

              const addForm = (sid) => (
                <div style={{ marginTop: 10, padding: "10px 12px", background: C.surface, borderRadius: 10, border: `1px solid ${C.border}` }}>
                  <select style={{ ...styles.fi, marginBottom: 6 }} value={logForm.exercise_id}
                    onChange={e => setLogForm({ ...logForm, exercise_id: e.target.value })}>
                    <option value="">— odaberi vježbu —</option>
                    {exercises.map(ex => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
                  </select>
                  <div style={styles.row3}>
                    <input ref={logKgRef} style={styles.fi} placeholder="kg" type="number" step="0.5"
                      value={logForm.weight_kg} onChange={e => setLogForm({ ...logForm, weight_kg: e.target.value })}
                      onKeyDown={e => e.key === "Enter" && logSetiRef.current?.focus()} />
                    <input ref={logSetiRef} style={styles.fi} placeholder="Seti" type="number"
                      value={logForm.sets} onChange={e => setLogForm({ ...logForm, sets: e.target.value })}
                      onKeyDown={e => e.key === "Enter" && logRepsRef.current?.focus()} />
                    <input ref={logRepsRef} style={styles.fi} placeholder="Reps" type="number"
                      value={logForm.reps} onChange={e => setLogForm({ ...logForm, reps: e.target.value })}
                      onKeyDown={e => e.key === "Enter" && addToDay(dayModal.date, sid)} />
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <button style={{ ...styles.logBtn, flex: 1 }}
                      onClick={() => addToDay(dayModal.date, sid)}
                      disabled={!logForm.exercise_id || !logForm.sets || !logForm.reps}>Spremi</button>
                    <button style={{ ...styles.logBtn, flex: 1, background: C.border }}
                      onClick={() => { setAddToDaySession(null); setLogForm({ exercise_id: "", weight_kg: "", sets: "", reps: "", notes: "" }); }}>Odustani</button>
                  </div>
                </div>
              );

              return sessionOrder.length === 0
                ? (
                  <>
                    {addToDaySession === "new"
                      ? addForm("new")
                      : <p style={styles.empty}>Nema logova za taj dan.</p>
                    }
                    {addToDaySession === null && (
                      <button style={{ ...styles.addExBtn, marginTop: 8 }}
                        onClick={() => { setAddToDaySession("new"); setLogForm({ exercise_id: "", weight_kg: "", sets: "", reps: "", notes: "" }); }}>
                        ＋ Novi trening ovaj dan
                      </button>
                    )}
                  </>
                )
                : (
                  <>
                    {sessionOrder.map((sid, si) => {
                      const sLogs = sessionMap[sid];
                      return (
                        <div key={sid} style={{ marginBottom: 12, background: C.card, borderRadius: 12, padding: "10px 12px", border: `1px solid #3a3a50` }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.sub, textTransform: "uppercase" }}>
                              Trening {si + 1}
                            </span>
                            <span style={{ fontSize: 11, color: C.sub }}>{sLogs.length} {sLogs.length === 1 ? "vježba" : "vježbe"}</span>
                          </div>
                          {sLogs.map((l, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 6, marginBottom: i < sLogs.length - 1 ? 6 : 0, borderBottom: i < sLogs.length - 1 ? `1px solid ${C.border}` : "none" }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <span style={{ fontSize: 14, fontWeight: 600, color: C.text, display: "block" }}>{l.exercises?.name || "?"}</span>
                                {l.notes && <span style={{ fontSize: 11, color: C.sub }}>{l.notes}</span>}
                              </div>
                              <span style={{ fontSize: 13, color: C.accent, fontWeight: 700, whiteSpace: "nowrap" }}>
                                {l.weight_kg ? l.weight_kg + "kg" : "BW"} {l.sets}×{l.reps}
                              </span>
                              <button style={{ ...styles.deleteBtn, fontSize: 13 }} onClick={() => {
                                setEditLogModal({ log: l });
                                setEditLogForm({ exercise_id: l.exercise_id, weight_kg: l.weight_kg || "", sets: l.sets || "", reps: l.reps || "", notes: l.notes || "" });
                              }}>✏️</button>
                              <button style={{ ...styles.deleteBtn, fontSize: 13 }} onClick={async () => {
                                await deleteLog(l.id);
                                setDayModal(d => ({ ...d, logs: d.logs.filter(x => x.id !== l.id) }));
                              }}>✕</button>
                            </div>
                          ))}
                          {addToDaySession === sid
                            ? addForm(sid)
                            : addToDaySession === null && (
                              <button style={{ ...styles.addExBtn, marginTop: 8, fontSize: 12, padding: "6px 10px" }}
                                onClick={() => { setAddToDaySession(sid); setLogForm({ exercise_id: "", weight_kg: "", sets: "", reps: "", notes: "" }); }}>
                                ＋ Dodaj vježbu
                              </button>
                            )
                          }
                        </div>
                      );
                    })}
                    {/* Novi trening */}
                    {addToDaySession === "new"
                      ? addForm("new")
                      : addToDaySession === null && (
                        <button style={{ ...styles.addExBtn, marginTop: 4, width: "100%", textAlign: "center" }}
                          onClick={() => { setAddToDaySession("new"); setLogForm({ exercise_id: "", weight_kg: "", sets: "", reps: "", notes: "" }); }}>
                          ＋ Novi trening ovaj dan
                        </button>
                      )
                    }
                  </>
                );
            })()}
          </div>
        </div>
      )}

      {/* EDIT LOG MODAL */}
      {editLogModal && (
        <div style={styles.modalOverlay} onClick={() => setEditLogModal(null)}>
          <div style={styles.modalSheet} onClick={e => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>Uredi log</span>
              <button style={styles.modalClose} onClick={() => setEditLogModal(null)}>✕</button>
            </div>
            <select style={styles.fi} value={editLogForm.exercise_id}
              onChange={e => setEditLogForm({ ...editLogForm, exercise_id: e.target.value })}>
              {exercises.map(ex => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
            </select>
            <div style={styles.row3}>
              <input style={styles.fi} placeholder="kg" type="number" step="0.5" value={editLogForm.weight_kg}
                onChange={e => setEditLogForm({ ...editLogForm, weight_kg: e.target.value })} />
              <input style={styles.fi} placeholder="Seti" type="number" value={editLogForm.sets}
                onChange={e => setEditLogForm({ ...editLogForm, sets: e.target.value })} />
              <input style={styles.fi} placeholder="Reps" type="number" value={editLogForm.reps}
                onChange={e => setEditLogForm({ ...editLogForm, reps: e.target.value })} />
            </div>
            <input style={styles.fi} placeholder="Napomena" value={editLogForm.notes}
              onChange={e => setEditLogForm({ ...editLogForm, notes: e.target.value })} />
            <button style={styles.logBtn} onClick={updateLog}>Spremi izmjene</button>
          </div>
        </div>
      )}

      {/* TAB NAV */}
      <div style={styles.tabNav}>
        {[
          { id: "chat", icon: "💬", label: "Coach" },
          { id: "vjezbe", icon: "🏋️", label: "Vježbe" },
          { id: "dnevnik", icon: "📅", label: "Dnevnik" },
          { id: "napredak", icon: "📈", label: "Napredak" },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ ...styles.navBtn, ...(tab === t.id ? styles.navBtnActive : {}) }}>
            <span style={styles.navIcon}>{t.icon}</span>
            <span style={{ ...styles.navLabel, ...(tab === t.id ? { color: C.accent } : {}) }}>{t.label}</span>
          </button>
        ))}
      </div>

    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
const C = {
  bg: "#0a0a0f",
  surface: "#13131a",
  card: "#1a1a24",
  border: "#2a2a38",
  accent: "#f97316",
  text: "#f1f0ed",
  sub: "#8884a0",
  green: "#22c55e",
  red: "#ef4444",
};

const styles = {
  // SETUP
  setupWrap: { minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "'DM Sans', sans-serif" },
  setupCard: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 20, padding: "32px 24px", width: "100%", maxWidth: 420 },
  setupLogo: { fontSize: 48, textAlign: "center", display: "block", marginBottom: 8 },
  setupTitle: { color: C.text, fontSize: 28, fontWeight: 800, textAlign: "center", margin: "0 0 4px" },
  setupSub: { color: C.sub, textAlign: "center", margin: "0 0 24px", fontSize: 15 },
  tabRow: { display: "flex", gap: 8, marginBottom: 20 },
  tabBtn: { flex: 1, padding: "8px 12px", borderRadius: 10, border: `1px solid ${C.border}`, background: "transparent", color: C.sub, cursor: "pointer", fontSize: 13, fontWeight: 600 },
  tabBtnActive: { background: C.accent, border: `1px solid ${C.accent}`, color: "#fff" },
  fields: { display: "flex", flexDirection: "column", gap: 10 },
  label: { color: C.sub, fontSize: 12, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" },
  input: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 14px", color: C.text, fontSize: 15, outline: "none", fontFamily: "inherit" },
  saveBtn: { background: C.accent, color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontSize: 16, fontWeight: 700, cursor: "pointer", marginTop: 8 },
  hint: { color: C.sub, fontSize: 12, textAlign: "center", margin: 0 },
  schemaNote: { color: C.sub, fontSize: 13, margin: 0 },
  schemaPre: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, fontSize: 10, color: "#a0e0b0", overflowX: "auto", whiteSpace: "pre-wrap", margin: 0, maxHeight: 300, overflowY: "auto" },
  copyBtn: { background: C.card, border: `1px solid ${C.border}`, color: C.text, borderRadius: 10, padding: "10px", cursor: "pointer", fontFamily: "inherit" },

  // APP SHELL
  app: { height: "100dvh", background: C.bg, fontFamily: "'DM Sans', 'Segoe UI', sans-serif", display: "flex", flexDirection: "column", maxWidth: 480, margin: "0 auto", overflow: "hidden" },
  header: { display: "flex", alignItems: "center", gap: 10, padding: "14px 16px 10px", borderBottom: `1px solid ${C.border}`, flexShrink: 0 },
  headerLogo: { fontSize: 22 },
  headerTitle: { color: C.text, fontWeight: 800, fontSize: 18, flex: 1 },
  resetBtn: { background: "none", border: "none", cursor: "pointer", fontSize: 18, opacity: 0.6 },

  errorBanner: { background: "#7f1d1d", color: "#fca5a5", padding: "8px 16px", fontSize: 13, cursor: "pointer", flexShrink: 0, display: "flex", justifyContent: "space-between" },

  statsBar: { display: "flex", alignItems: "center", padding: "10px 16px", background: C.surface, borderBottom: `1px solid ${C.border}`, flexShrink: 0 },
  stat: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, position: "relative" },
  statVal: { color: C.text, fontWeight: 800, fontSize: 17 },
  statLbl: { color: C.sub, fontSize: 10 },
  statDiff: { fontSize: 10, fontWeight: 700, position: "absolute", top: 0, right: 4 },
  statDiv: { width: 1, height: 30, background: C.border },

  content: { flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 },

  tabNav: { display: "flex", borderTop: `1px solid ${C.border}`, background: C.surface, flexShrink: 0, paddingBottom: "env(safe-area-inset-bottom)" },
  navBtn: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "8px 0 6px", background: "none", border: "none", cursor: "pointer", borderTop: "2px solid transparent" },
  navBtnActive: { borderTop: `2px solid ${C.accent}` },
  navIcon: { fontSize: 16 },
  navLabel: { color: C.sub, fontSize: 10, fontWeight: 600 },

  // CHAT
  chatWrap: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  chatMessages: { flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 },
  msg: { display: "flex", alignItems: "flex-end", gap: 6 },
  msgUser: { flexDirection: "row-reverse" },
  msgAssistant: { flexDirection: "row" },
  msgAvatar: { fontSize: 18, flexShrink: 0, marginBottom: 2 },
  msgBubble: { maxWidth: "80%", padding: "10px 14px", borderRadius: 16, fontSize: 14, lineHeight: 1.5 },
  bubbleUser: { background: C.accent, color: "#fff", borderBottomRightRadius: 4 },
  bubbleAssistant: { background: C.card, color: C.text, border: `1px solid ${C.border}`, borderBottomLeftRadius: 4 },
  typing: { color: C.sub, letterSpacing: 4 },
  chatInput: { display: "flex", gap: 8, padding: "10px 14px", borderTop: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 },
  chatField: { flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "10px 14px", color: C.text, fontSize: 14, outline: "none", fontFamily: "inherit" },
  sendBtn: { background: C.accent, color: "#fff", border: "none", borderRadius: 12, width: 44, fontSize: 18, cursor: "pointer", fontWeight: 700, flexShrink: 0 },
  skeletonWrap: { display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" },
  skeleton: { height: 40, background: C.card, borderRadius: 12, animation: "none", opacity: 0.5 },

  // COMMON SCROLL WRAP
  scrollWrap: { overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 },
  card: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 16 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: 700, margin: "0 0 12px" },
  cardHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  fi: { width: "100%", boxSizing: "border-box", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "9px 12px", color: C.text, fontSize: 14, outline: "none", fontFamily: "inherit", marginBottom: 8 },
  row2: { display: "flex", gap: 8, alignItems: "center" },
  row3: { display: "flex", gap: 6 },
  logBtn: { width: "100%", background: C.accent, color: "#fff", border: "none", borderRadius: 10, padding: "11px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" },
  saveToast: { background: C.green, color: "#fff", padding: "8px 14px", borderRadius: 10, textAlign: "center", fontWeight: 700, fontSize: 14 },
  empty: { color: C.sub, textAlign: "center", padding: "20px 0", fontSize: 14 },

  // EXERCISE LIBRARY
  exRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${C.border}` },
  exLeft: { display: "flex", flexDirection: "column", gap: 3, flex: 1, cursor: "pointer" },
  exName: { color: C.text, fontSize: 15, fontWeight: 700 },
  exGroup: { color: C.sub, fontSize: 12 },
  exGoal: { color: C.accent, fontSize: 12, fontWeight: 600 },
  exLast: { color: C.sub, fontSize: 11 },
  deleteBtn: { background: "none", border: "none", color: C.sub, cursor: "pointer", fontSize: 16, padding: "0 0 0 10px", flexShrink: 0 },
  lastLogHint: { color: C.sub, fontSize: 12, margin: "-2px 0 8px", padding: "6px 10px", background: C.surface, borderRadius: 8, border: `1px solid ${C.border}` },

  // NAPREDAK
  progressHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  progressTitle: { color: C.text, fontSize: 15, fontWeight: 700 },
  progressPct: { color: C.accent, fontSize: 14, fontWeight: 700 },
  progressBarBg: { height: 6, background: C.border, borderRadius: 3, marginBottom: 12, overflow: "hidden" },
  progressBarFill: { height: "100%", background: C.accent, borderRadius: 3, transition: "width 0.3s ease" },
  statsRow: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 },
  statBox: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 70 },
  statBoxLbl: { color: C.sub, fontSize: 10, fontWeight: 600, textTransform: "uppercase" },
  statBoxVal: { color: C.text, fontSize: 13, fontWeight: 700 },
  sectionLabel: { color: C.sub, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" },
  histRow: { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: `1px solid ${C.border}` },
  histDate: { color: C.sub, fontSize: 12, minWidth: 72 },
  histWeight: { color: C.text, fontSize: 13, fontWeight: 600, flex: 1 },
  histNote: { color: C.sub, fontSize: 11, fontStyle: "italic" },
  rangeToggle: { display: "flex", gap: 4 },
  rangeBtn: { background: "none", border: `1px solid ${C.border}`, color: C.sub, borderRadius: 6, padding: "4px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  rangeBtnActive: { background: C.accent, border: `1px solid ${C.accent}`, color: "#fff" },
  weightSummary: { color: C.sub, fontSize: 13, margin: "8px 0 0", textAlign: "center" },

  // MODAL
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 60 },
  modalSheet: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 20, width: "100%", maxWidth: 480, maxHeight: "65vh", overflowY: "auto", padding: "20px 16px 24px" },
  modalHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  modalTitle: { color: C.text, fontSize: 17, fontWeight: 800 },
  modalClose: { background: "none", border: "none", color: C.sub, fontSize: 18, cursor: "pointer", padding: 4 },
  modalRow: { display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${C.border}` },
  modalDate: { color: C.sub, fontSize: 13 },
  modalResult: { color: C.text, fontSize: 14, fontWeight: 700 },

  // SESSION QUEUE
  queueList: { background: C.surface, borderRadius: 10, padding: "8px 10px", marginBottom: 10, display: "flex", flexDirection: "column", gap: 4 },
  queueRow: { display: "flex", alignItems: "center", gap: 8 },
  queueEx: { color: C.sub, fontSize: 13, flex: 1 },
  queueResult: { color: C.text, fontSize: 13, fontWeight: 700 },

  // ADD EXERCISE BUTTON
  addExBtn: { width: "100%", background: C.surface, border: `1px dashed ${C.border}`, borderRadius: 12, padding: "12px", color: C.sub, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textAlign: "center", transition: "border-color 0.15s" },
  addExBtnActive: { borderColor: C.accent, color: C.accent, borderStyle: "solid" },

  // DNEVNIK
  sessionBlock: { marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${C.border}` },
  sessionHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  sessionDate: { color: C.text, fontSize: 13, fontWeight: 700 },
  sessionCount: { color: C.sub, fontSize: 11, background: C.surface, padding: "2px 8px", borderRadius: 6 },
  sessionLabel: { display: "block", color: C.sub, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, marginTop: 6 },
  sessionRow: { display: "flex", alignItems: "baseline", justifyContent: "space-between", paddingLeft: 8, marginBottom: 4 },
  sessionEx: { color: C.sub, fontSize: 13, flex: 1 },
  sessionResult: { color: C.text, fontSize: 13, fontWeight: 600 },
  sessionNote: { color: C.sub, fontSize: 11, fontWeight: 400, fontStyle: "italic" },
};
