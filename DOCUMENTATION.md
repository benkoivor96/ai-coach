# FitCoach AI — Kompletna Dokumentacija

> Zadnje ažuriranje: 2026-05-30  
> Verzija app-a: 0.1.0

---

## 1. App Overview

FitCoach AI je personalizirani AI fitness coach koji radi kao web aplikacija optimizirana za mobitel. Namijenjena je jednom korisniku — nema višekorisničke arhitekture, nema registracije.

**Što app radi:**
- Korisnik razgovara s AI coachom slobodnim tekstom (npr. "danas sam radio bench 100kg 4x8")
- App automatski parsira te poruke i sprema strukturirane podatke u bazu (treninzi, kilaza, kalorije)
- Coach ima uvid u zadnjih 30 dana podataka i daje preporuke na temelju trendova u skladu s ciljevima, ako ih ima
- Svaki tjedan može se generirati izvještaj koji uspoređuje ovaj i prošli tjedan
- App pamti ključne činjenice o korisniku (sport, ciljevi, protokoli) u posebnoj memorijskoj tablici

**Filozofija:**
Minimalan friction. Umjesto popunjavanja formi, korisnik piše prirodnim jezikom. App parsira što može automatski, a AI pita za ostatak. Sve ostaje u bazi i dostupno je coachu u svakoj sljedećoj sesiji.

**Ciljani korisnik:** Ivor Benko (ja) — b-boy koji trenira breaking + snažni trening, prati kilažu jednom tjedno, želi pratiti napredak na specifičnim vježbama i prilagodbu prehrane prema kretanju kilaze. Želi pratit progres i optimizirat prema tome.

---

## 2. Tech Stack & Architecture

### Frontend
- **React 18** — UI framework, single-page app
- **Vite 5** — build tool i dev server
- **Čisti inline stilovi** — nema CSS frameworka (Tailwind, Bootstrap), sve je JavaScript objects u `styles` konstanti na dnu fajla
- **Google Fonts (DM Sans)** — učitava se iz `index.html`

### Backend / Database
- **Supabase** — PostgreSQL baza u cloudu, koristi se isključivo kroz REST API
- Nema custom backenda. App direktno zove Supabase REST API iz browsera.

### AI
- **Anthropic Claude API** — model `claude-sonnet-4-5`
- Direktni pozivi iz browsera (nije preporučeno za produkciju, ali funkcionira za osobnu upotrebu)
- Header `anthropic-dangerous-direct-browser-access: true` omogućuje browser-side pozive

### Auth
- **Nema pravog auth sustava.** API ključevi se čuvaju u `localStorage` browsera.
- Nema korisničkih računa, nema JWT tokenova, nema sesija.

### Hosting
- Lokalno: `http://localhost:5173` (Vite dev server)
- Za produkciju: Vercel ili Netlify (nije još deployano)

### Arhitektura — dijagram

```
Browser (React app)
    │
    ├── localStorage
    │     └── fitcoach_creds { sbUrl, sbKey, aiKey }
    │
    ├── Supabase REST API (https://[project].supabase.co/rest/v1/)
    │     ├── GET  /workouts
    │     ├── GET  /weight_logs
    │     ├── GET  /nutrition_logs
    │     ├── GET  /chat_history
    │     ├── GET  /exercise_goals
    │     ├── GET  /coach_memory
    │     └── POST (insert/upsert/delete za sve tablice)
    │
    └── Anthropic API (https://api.anthropic.com/v1/messages)
          ├── Chat poruke (model: claude-sonnet-4-5, max_tokens: 1000)
          ├── Weekly report (max_tokens: 800)
          ├── Exercise ekstrakcija (max_tokens: 600)
          └── Memory ekstrakcija (max_tokens: 800)
```

### Data Flow — slanje chat poruke

```
1. Korisnik upiše poruku i pritisne Enter / →
2. Poruka se doda u lokalni messages state
3. POST /chat_history (spremi user poruku)
4. trySaveFromMessage() — regex parsing:
     - Ako regex hvata workout format → POST /workouts
     - Ako regex hvata kilažu (i danas još nema) → POST /weight_logs
     - Ako regex hvata kalorije → POST /nutrition_logs
     - loadAll() osvježi sve podatke
5. POST api.anthropic.com/v1/messages:
     - system prompt: buildContext() (vidi sekciju 5)
     - messages: zadnjih 50 poruka
6. AI odgovor se doda u messages state
7. POST /chat_history (spremi assistant odgovor)
8. Provjera: treba li pokrenuti extractExercisesFromChat()?
     - Da ako: goals.length === 0 ILI poruka sadrži plan keywords
     - Ako da: async poziv bez čekanja (background)
9. setLoading(false)
```

---

## 3. Database Schema

Sve tablice su u Supabase PostgreSQL bazi, schema `public`. Nema foreign keyeva, nema relacija između tablica — svaka je nezavisna.

### Tablica: `workouts`
| Kolona | Tip | Opis |
|--------|-----|------|
| id | uuid PK | auto-generiran |
| exercise | text NOT NULL | naziv vježbe |
| weight_kg | numeric | težina u kg (može biti null za vježbe bez utega) |
| sets | integer | broj serija |
| reps | integer | broj ponavljanja |
| notes | text | opcionalna napomena |
| logged_at | timestamptz | default now() |

**Čita se:** `loadAll()` — zadnjih 50 zapisa od 30 dana unazad, sortirano od novijeg  
**Piše se:** `logWorkout()` (forma u Unos tabu) + `trySaveFromMessage()` (regex parsing iz chata)  
**Format koji regex hvata:** `"vježba Xkg AxB"` npr. `"bench 100kg 4x8"`

### Tablica: `weight_logs`
| Kolona | Tip | Opis |
|--------|-----|------|
| id | uuid PK | auto-generiran |
| weight_kg | numeric NOT NULL | tjelesna masa |
| logged_at | timestamptz | default now() |

**Čita se:** `loadAll()` — zadnjih 30 zapisa, sortirano od novijeg  
**Piše se:** `logWeight()` (forma) + `trySaveFromMessage()` (regex, s provjerom duplicata za isti dan)  
**Zaštita:** `trySaveFromMessage()` ne sprema ako postoji zapis za današnji dan

### Tablica: `nutrition_logs`
| Kolona | Tip | Opis |
|--------|-----|------|
| id | uuid PK | auto-generiran |
| calories | integer | ukupne kalorije |
| protein_g | numeric | proteini u gramima |
| carbs_g | numeric | ugljikohidrati u gramima |
| fat_g | numeric | masti u gramima |
| notes | text | originalna poruka (max 100 znakova) |
| logged_at | timestamptz | default now() |

**Čita se:** `loadAll()` — zadnjih 30 zapisa  
**Piše se:** `logNutrition()` (forma) + `trySaveFromMessage()` (regex)  
**Napomena:** Nema zaštite od duplicata za isti dan — može se logirati više obroka

### Tablica: `chat_history`
| Kolona | Tip | Opis |
|--------|-----|------|
| id | uuid PK | auto-generiran |
| role | text NOT NULL | "user" ili "assistant" |
| content | text NOT NULL | tekst poruke |
| logged_at | timestamptz | default now() |

**Čita se:** `loadAll()` — zadnjih 50 zapisa, sortirano od starijeg (ascending)  
**Piše se:** `sendMessage()` — svaka user i assistant poruka  
**Koristi se za:** perzistenciju razgovora između sesija

### Tablica: `exercise_goals`
| Kolona | Tip | Opis |
|--------|-----|------|
| id | uuid PK | auto-generiran |
| exercise | text NOT NULL | naziv vježbe |
| training_day | text | dan u tjednu (hr: Ponedjeljak...) |
| current_level | text | BASELINE razina (set jednom, ne mijenja se) |
| goal | text | ciljana razina |
| notes | text | napomena (mišićna grupa, važnost) |
| updated_at | timestamptz | default now() |

**Čita se:** `loadAll()` — svi zapisi, sortirano po `training_day`  
**Piše se:** `saveGoal()` (ručna forma u Plan tabu) + `extractExercisesFromChat()` (background AI ekstrakcija)  
**Nema unique constrainta** na exercise+training_day — duplikati su mogući ako ekstrakcija ne filtrira dobro

### Tablica: `coach_memory`
| Kolona | Tip | Opis |
|--------|-----|------|
| id | uuid PK | auto-generiran |
| key | text NOT NULL UNIQUE | snake_case ključ (npr. sport, kilaza_baseline) |
| value | text NOT NULL | vrijednost |
| updated_at | timestamptz | default now() |

**Čita se:** `loadAll()` — svi zapisi, sortirano po `key`  
**Piše se:** `extractMemory()` (ručno triggerirano) — koristi upsert (merge po key)  
**Koristi se za:** dugotrajna memorija o korisniku koja uvijek ide u system prompt

### Permissions
Sve tablice koriste Supabase `anon` key (legacy JWT format). RLS nije enablean. Pristup je otvoren svima tko ima anon key:
```sql
grant select, insert, update, delete on all tables in schema public to anon;
-- Ili per-tablica:
grant select, insert, update, delete on exercise_goals to anon;
grant select, insert, update, delete on coach_memory to anon;
```

---

## 4. Authentication & User Management

**Nema autentifikacije.** App je dizajniran za jednog korisnika.

### Kako funkcionira:
1. Pri prvom pokretanju prikazuje se `SetupScreen`
2. Korisnik unosi tri ključa: Supabase URL, Supabase anon key, Anthropic API key
3. Pritiskom "Pokreni App →" ključevi se spremaju u `localStorage` kao JSON:
   ```js
   localStorage.setItem("fitcoach_creds", JSON.stringify({ sbUrl, sbKey, aiKey }))
   ```
4. Pri svakom učitavanju app čita ključeve iz localStorage:
   ```js
   const [creds, setCreds] = useState(() => {
     try { return JSON.parse(localStorage.getItem("fitcoach_creds") || "null"); }
     catch { return null; }
   });
   ```
5. Ako `creds === null` → prikaže `SetupScreen`
6. Ako `creds` postoji → inicijalizira Supabase client i učita podatke

### Odjava:
Gumb ⚙️ u headeru → `confirm("Odjavi se?")` → `localStorage.removeItem("fitcoach_creds")` → `setCreds(null)`

### Sigurnosne napomene:
- API ključevi su vidljivi u localStorage (DevTools → Application → Local Storage)
- Anthropic API key je vidljiv u network requestovima (DevTools → Network)
- Supabase anon key je "public" po dizajnu ali bez RLS-a daje puni pristup bazi
- Prihvatljivo za osobnu upotrebu na osobnom uređaju, NIJE prihvatljivo za produkciju s više korisnika

---

## 5. AI Coach — Full Breakdown

### Model
`claude-sonnet-4-5` — Anthropic API, direktni browser pozivi

### System Prompt (buildContext funkcija)

System prompt se gradi dynamički pri svakom pozivu i sadrži:

```
Ti si AI fitness coach specijaliziran za breaking (bboying) i snažni trening. 
Govoriš kratko, direktno, motivirajuće. Hrvatski jezik.
Fokus: snaga, prevencija ozljeda, podrška za powermovse i footwork.
Ne odgovaraj na pitanja koja nisu vezana uz trening, prehranu, kilažu ili oporavak.

MEMORIJA (ključne činjenice o korisniku):
[key: value za svaki red u coach_memory]

PODACI KORISNIKA (zadnjih 30 dana):

TRENINZI:
[datum | vježba | kg | setsxreps | napomena — zadnjih 20 workouts]

KILAZA:
[datum | kg — zadnjih 10 weight_logs]

PREHRANA:
[datum | kcal | P:xg C:xg F:xg — zadnjih 10 nutrition_logs]

PLAN TRENINGA I CILJEVI:
[dan | vježba | Trenutno: X | Cilj: Y — svi exercise_goals]

Danas je: YYYY-MM-DD (Dan u tjednu)

[AKO goals.length === 0:]
⚠️ ONBOARDING: Korisnik nema postavljenih vježbi u planu!
- Pitaj koje dane trenira i koje vježbe radi
- Za svaku vježbu pitaj: koliko trenutno može (reps/kg) i koji mu je cilj
- Pitaj jednu po jednu stvar, ne sve odjednom

PRAVILA:
- current_level u planu = POČETNA BAZNA LINIJA (ne mijenja se)
- Kad korisnik kaže da je poboljšao vježbu → pohvali, izračunaj razliku od baseline
- Ako kilaza pada → povećaj kalorije za 200-300
- Ako kilaza raste previše → smanji kalorije za 150-200
- Weekly report: usporedi workouts ovog tjedna s prošlim
```

### Što se šalje API-ju po pozivu

```js
{
  model: "claude-sonnet-4-5",
  max_tokens: 1000,
  system: buildContext(),        // dinamički system prompt
  messages: newMessages.slice(-50)  // zadnjih 50 poruka iz state-a
}
```

**Napomena:** `messages` state se učitava iz `chat_history` tablice (zadnjih 50 zapisa) ali se rebuild-a u memoriji, ne šalje se direktno iz baze.

### Kako AI parsira user input (trySaveFromMessage)

Ovo je **regex-based parsing** koji se izvršava **prije** API poziva, na svakoj user poruci:

**Workout regex:**
```js
/([a-zA-ZčćšđžČĆŠĐŽ\s]+?)\s+(\d+(?:[.,]\d+)?)\s*kg.*?(\d+)\s*[xX×]\s*(\d+)/i
```
Hvata: "bench 100kg 4x8", "čučnjevi 80kg 3x6", "mrtvo dizanje 60 kg 4×8"  
Ne hvata: vježbe bez kilaže (zgibovi, trbuh), prirodni tekst ("napravio sam 5 zgibova")

**Weight regex (tri pattern-a):**
```js
/(?:kilaz[au]?|vagao|težin[au]?|waga|imam|trenutno)\s*[:\-]?\s*(\d+(?:[.,]\d+)?)\s*kg/i
/(\d+(?:[.,]\d+)?)\s*kg\s*trenutno/i
/^(\d{2,3}(?:[.,]\d+)?)\s*kg?\s*$/i  // samo broj+kg u poruci
```
Hvata: "imam 82kg", "kilaza 82", "82.5kg", "82kg trenutno"  
Ne hvata: "digao sam 5kg" (jer 5 nije u range 10-999 za tijelo)  
**Zaštita duplicata:** Provjerava `weights.some(w => w.logged_at?.startsWith(today()))` — ne sprema ako je danas već uneseno

**Nutrition regex:**
```js
/(?:kalorij[ae]?|kcal|jeo|unos)\s*[:\-]?\s*(\d{3,5})/i
```
Hvata: "jeo sam 2500 kcal", "kalorije: 2000", "unos 1800"  
Dodatno parsira proteine, carbse, masti iz iste poruke ako postoje.

### Automatska ekstrakcija vježbi (extractExercisesFromChat)

Poseban AI poziv koji se triggerira u pozadini (ne blokira UI) kada:
- `goals.length === 0` (nema plana) — uvijek
- ILI poruka sadrži ključne riječi: `["ponedjeljak","utorak","srijeda","četvrtak","petak","subota","trening","vježb","planim","radit","radi","zgib","dizanj","trbuh","ramen","eksten"]`

Poziv analizira zadnjih 20 poruka i vraća JSON array vježbi. Sprema samo vježbe koje još ne postoje u `goals` (usporedba po lowercase imenu).

### Memory ekstrakcija (extractMemory)

Manualno triggeriran poziv (gumb u Memory tabu). Analizira zadnjih 30 poruka i upserta key-value parove u `coach_memory`. Koristi `upsert` pa ažurira postojeće.

### Conversation history management

- Baza čuva zadnjih 50 poruka (`limit(50)` u loadAll)
- API dobiva zadnjih 50 poruka (`newMessages.slice(-50)`)
- Starije poruke se ne brišu iz baze automatski — akumuliraju se
- Nema summarizacije starih poruka
- **Problem:** Nakon 50+ poruka, starije se više ne šalju AI-ju ali ostaju u bazi

---

## 6. Svaka Feature — Tehnički + UI

### 6.1 Setup Screen

**Što korisnik vidi:** Centered card s logom, naslovom "FitCoach AI", dva taba (API Ključevi / SQL Schema)

**API Ključevi tab:**
- Input: Supabase URL
- Input: Supabase Anon Key
- Input: Anthropic API Key (type="password", maskiran)
- Button "Pokreni App →" — aktivan samo ako sva tri polja imaju vrijednost
- Hint: "Ključevi se čuvaju samo u ovom browseru (localStorage)"

**SQL Schema tab:**
- Prikazuje `SCHEMA_SQL` konstantu kao `<pre>` block
- Button "📋 Kopiraj SQL" — `navigator.clipboard.writeText(SCHEMA_SQL)`

**Background:** Sprema u localStorage, inicijalizira Supabase client, poziva `loadAll()`

**Edge case:** Ako korisnik unese pogrešan Supabase URL ili key, `loadAll()` će failati tiho (console.error). Nema error handling na UI-ju.

---

### 6.2 Header

Uvijek vidljiv. Sadrži:
- 💪 emoji + "FitCoach AI" tekst
- ⚙️ gumb desno → odjava s potvrdom

---

### 6.3 Stats Bar

Ispod headera, uvijek vidljiv. Tri statistike u redu:

| Stat | Izvor | Logika |
|------|-------|--------|
| Kilaza | `weights[0].weight_kg` | Zadnji unos |
| kcal danas | `nutrition.find(n => n.logged_at?.startsWith(today()))` | Danas logiran unos |
| Vježbi danas | `workouts.filter(w => w.logged_at?.startsWith(today())).length` | Broj workouts zapisa danas |

**Razlika kilaze:** Izračunava se između `weights[0]` i `weights[1]`. Prikazuje ▲ crveno ili ▼ zeleno ovisno o promjeni.

---

### 6.4 Tab Navigation

**Pozicija:** Dno ekrana (prebačeno s vrha)  
**Stilizacija:** `borderTop` na aktivnom tabu (orange accent), ne `borderBottom`  
**6 tabova:** Coach | Unos | Plan | Povijest | Memory | Report  
**Mobile:** `padding-bottom: env(safe-area-inset-bottom)` za iPhone home indicator

---

### 6.5 Coach Tab (Chat)

**UI:**
- Scrollabilna lista poruka (user: narančasti bubble desno, assistant: tamni bubble lijevo s 🤖 avatarom)
- Loading indicator: "●●●" animacija dok čeka AI odgovor
- Input field + send button na dnu
- `chatEndRef` — auto-scroll na novu poruku

**Markdown rendering:**
```js
line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
```
Renderira se s `dangerouslySetInnerHTML`. Podržava samo **bold** i *italic*, ne i headinge, liste, code blokove.

**Enter tipka** šalje poruku (bez Shift). Shift+Enter ne radi (nema newline u inputu).

**Edge case:** Ako API vrati error, poruka "⚠️ Greška: [message]" se prikazuje kao assistant poruka ali se **ne sprema** u chat_history.

---

### 6.6 Unos Tab (Brzi log)

Tri kartice jedna ispod druge:

**💪 Trening forma:**
- exercise (text), weight_kg (number), sets (number), reps (number), notes (text)
- Button "Spremi trening" → `logWorkout()` → POST /workouts
- `exercise` je obavezno, ostalo opcionalno (parseInt/parseFloat vraća null ako prazno)

**⚖️ Kilaza forma:**
- weight_kg (number, step 0.1)
- Button "Spremi" → `logWeight()` → POST /weight_logs
- **Nema zaštite od duplicata** za isti dan (za razliku od regex parsinga)

**🍽️ Prehrana forma:**
- calories, protein_g, carbs_g, fat_g (svi numbers), notes (text)
- Button "Spremi prehranu" → `logNutrition()` → POST /nutrition_logs
- `calories` je obavezno

**Toast:** Zeleni banner "✓ [poruka]" na vrhu, nestaje nakon 2 sekunde.

---

### 6.7 Plan Tab

**Forma za dodavanje vježbe:**
- exercise (text), training_day (select: Pon-Ned), current_level (text), goal (text), notes (text)
- Button "Spremi u plan" → `saveGoal()` → upsert /exercise_goals

**Bug:** `saveGoal()` koristi `upsert` bez unique constrainta → **uvijek stvara novi red** umjesto da updatea.

**Prikaz:** Vježbe grupirane po danu. Za svaki dan kartice s vježbama:
- Naziv (bold), "Sad: X", "Cilj: Y" (narančasto), napomena (italic)
- ✕ gumb → `deleteGoal(id)` → DELETE /exercise_goals

**Auto-dodavanje:** `extractExercisesFromChat()` dodaje vježbe u pozadini. Filtrira duplikate po lowercase imenu ali samo uspoređuje s trenutnim `goals` state-om (koji je možda zastario ako ekstrakcija radi brže nego loadAll).

---

### 6.8 Povijest Tab

Tri sekcije:

**Zadnji treninzi (workouts):** Max 15 prikazanih. Svaki red: naziv + datum lijevo, kg + setsxreps desno.

**Kilaza (weight_logs):** Max 10 prikazanih. Datum + kg.

**Prehrana (nutrition_logs):** Max 10 prikazanih. Datum + notes + kcal + protein.

**Problem:** "Nema treninga još" čak i kad postoje treninzi uneseni kroz chat, jer regex za workout hvata samo "vježba Xkg AxB" format. Treninzi uneseni kroz formulare u Unos tabu se prikazuju ispravno.

---

### 6.9 Memory Tab

**Gumb "🧠 Izvuci memoriju iz chata":**
- Triggerira `extractMemory()`
- Loading state prikazuje "⏳ Analiziram chat..."
- Analizira zadnjih 30 poruka
- Upserta key-value parove u `coach_memory`

**Prikaz memorije:**
- Svaki unos: KEY (narančasto, uppercase) + value
- ✏️ gumb → inline edit (dva inputa: key i value)
- ✕ gumb → `deleteMemoryItem(id)` → DELETE /coach_memory

**Inline edit flow:** Klik ✏️ → `setEditingMemory({...item})` → prikaz input fielda → "Spremi" poziva `saveMemoryEdit()` (upsert) → `setEditingMemory(null)`

**Bug:** `saveMemoryEdit()` koristi `eq("id", item.id).upsert()` — kombinacija eq filtera i upserta može ne raditi ispravno jer upsert ne koristi WHERE clause na isti način.

---

### 6.10 Report Tab

**Gumb "📋 Generiraj Weekly Report":**
- Triggerira `generateWeeklyReport()`
- Loading state: "⏳ Generiranje..."

**Što report dobiva:**
- `thisWeekStart = daysAgo(7)`, `lastWeekStart = daysAgo(14)`
- Workouts ovog tjedna vs prošlog (filtrirani iz lokalnog state-a)
- Kilaze ovog tjedna vs prošlog
- Prehrana ovog tjedna

**Report se ne sprema** — nestaje kad se refresha app.

**Format kojeg AI vraća:**
```
📊 TJEDNI IZVJEŠTAJ
---
⚖️ Kilaza: [promjena]
💪 Trening napredak: [konkretna usporedba vježbi]
🍽️ Prehrana: [prosječni unos, komentar]
---
🎯 PREPORUKE ZA SLJEDEĆI TJEDAN:
1. [preporuka kalorija/makroa]
2. [preporuka treninga]
3. [ostalo]
```

---

## 7. Weekly Report — Detalji

### Generiranje
Manualno — korisnik pritisne gumb. Nema automatskog generiranja.

### Podaci koje koristi
Svi podaci se uzimaju iz **lokalnog React state-a** (ne direktno iz baze):

```js
const thisWeekStart = daysAgo(7);   // 7 dana unazad od danas
const lastWeekStart = daysAgo(14);  // 14 dana unazad od danas

thisW = workouts.filter(w => w.logged_at >= thisWeekStart + "T00:00:00")
lastW = workouts.filter(w => w.logged_at >= lastWeekStart + "T00:00:00" 
                          && w.logged_at < thisWeekStart + "T00:00:00")
```

**Problem s string komparacijom datuma:** Usporedba `w.logged_at >= "2026-05-23T00:00:00"` radi ispravno jer ISO 8601 datumi su leksikografski sortirani, ali ovisi o timezone-u koji Supabase koristi za pohranu.

### AI poziv za report
```js
{
  model: "claude-sonnet-4-5",
  max_tokens: 800,
  messages: [{ role: "user", content: prompt }]
}
// Nema system prompta — report prompt je sve u user poruci
```

### Što report ne uključuje
- `exercise_goals` (plan i ciljevi) — nije u reportu
- `coach_memory` — nije u reportu
- Prehrana prošlog tjedna — nije u reportu (samo ovotjedna)

---

## 8. Workout Logging

### Dva načina unosa

**1. Chat — automatski (regex parsing)**  
Format koji radi: `"[naziv vježbe] [X]kg [A]x[B]"`  
Primjeri koji rade: "bench 100kg 4x8", "mrtvo dizanje 60kg 4x8", "čučnjevi 80 kg 3×6"  
Primjeri koji ne rade: "zgibovi 4x5" (bez kg), "napravio sam 5 zgibova", "bench bez utega"

**2. Unos tab — ručno**  
Forma s poljima: exercise, weight_kg, sets, reps, notes  
Sve vježbe tu rade, uključujući one bez utega (weight_kg je opcionalan).

### Što se sprema
```js
{
  exercise: "bench press",  // text, trimmed
  weight_kg: 100.0,         // float
  sets: 4,                  // int
  reps: 8,                  // int
  logged_at: "2026-05-30T14:23:11.000Z"
}
```

### Praćenje napretka
- Svaki workout je zaseban red s datumom
- Nema automatske usporedbe u UI-ju (povijest tab prikazuje samo listu)
- Coach u chatu može usporediti workouts jer ih dobiva u system promptu (zadnjih 20)
- `exercise_goals.current_level` je **baseline** (početna razina, ne mijenja se)
- Napredak = usporedba `workouts` zapisa s istom vježbom kroz vrijeme

---

## 9. Weight Tracking

### Unos
- **Chat:** Regex hvata "imam 82kg", "kilaza 82", "vagao se 83.5", "82kg trenutno"
- **Forma:** Unos tab → Kilaza kartica, slobodan numerički unos

### Zaštita duplicata (samo za chat)
```js
const todayAlreadyLogged = weights.some(w => w.logged_at?.startsWith(today()));
if (!todayAlreadyLogged) { /* spremi */ }
```
Forma nema ovu zaštitu — može se unijeti više puta.

### Trendovi
- Stats bar prikazuje zadnju kilažu i razliku od pretprošle
- Nema grafikona
- Coach koristi zadnjih 10 weight_logs za preporuke

### Automatske preporuke
Coach je instruiran pravilima:
- Kilaza pada → +200-300 kcal preporuka
- Kilaza raste previše → -150-200 kcal preporuka

Ove preporuke su samo u tekstu chata, ne mijenjaju automatski nikakve targete.

### Korisnikov protokol vaganja
Jednom tjedno, u isti dan, pod istim uvjetima (isti trening dan prije, ista prehrana). Ovo je u coach_memory ali nema automatskog podsjetnika.

---

## 10. Nutrition Tracking

### Što se prati
- calories (integer)
- protein_g (numeric)
- carbs_g (numeric)  
- fat_g (numeric)
- notes (string, max 100 chars — originalna poruka)

### Unos
**Chat regex:**
```js
/(?:kalorij[ae]?|kcal|jeo|unos)\s*[:\-]?\s*(\d{3,5})/i
```
Hvata: "jeo sam 2500 kcal", "kalorije: 2000", "unos 1800kcal"  
Makroi se parsiraju dodatno iz iste poruke ako postoje.

**Forma:** Sva polja direktno.

### Korištenje u AI-ju
- Zadnjih 10 unosa u system promptu
- Report koristi ovotjedne unose
- Nema automatskog izračuna prosjeka — coach to radi verbalno

### Nedostaje
- Nema praćenja po obroku (samo dnevni totali)
- Nema library-ja namirnica
- Nema vizualizacije trenda kalorija

---

## 11. UI & Navigation

### Layout struktura
```
┌─────────────────────────────────┐
│ Header (logo + settings)        │  ~46px, fixed
├─────────────────────────────────┤
│ Stats Bar (kilaza/kcal/vježbe)  │  ~56px, fixed
├─────────────────────────────────┤
│                                 │
│ Content Area (scrollable)       │  flex: 1
│                                 │
├─────────────────────────────────┤
│ Tab Navigation (6 tabova)       │  ~56px, fixed dno
└─────────────────────────────────┘
```

### Max širina
`max-width: 480px, margin: 0 auto` — centrirano na desktopu, puna širina na mobu.

### Visina
`height: 100dvh` — dynamic viewport height, ispravno na mobilnim browserima gdje se address bar pojavljuje/nestaje.

### Boje (C konstanta)
```js
bg: "#0a0a0f"      // pozadina
surface: "#13131a"  // header, stats, tab nav
card: "#1a1a24"    // kartice, chat bubbles
border: "#2a2a38"  // borderovi
accent: "#f97316"  // narančasta (primary CTA, active tab)
text: "#f1f0ed"    // bijeli tekst
sub: "#8884a0"     // sekundarni tekst
green: "#22c55e"   // success
red: "#ef4444"     // error
```

### Font
DM Sans (Google Fonts), fallback: Segoe UI, sans-serif. Težine: 400, 600, 700, 800.

### Nema
- Grafova i vizualizacija
- Dark/light mode toggle (uvijek dark)
- Animacija (osim typing indikatora)
- Swipe gesta za promjenu taba

---

## 12. Data Flow Dijagrami

### Slanje chat poruke

```
Korisnik upiše tekst → pritisne Enter
    │
    ▼
sendMessage()
    │
    ├── setInput("") — clearing input
    ├── newMessages = [...messages, {role: "user", content}]
    ├── setMessages(newMessages) — prikaži odmah
    ├── setLoading(true)
    │
    ├── POST /chat_history (user poruka)
    │
    ├── trySaveFromMessage(userMsg) ──────────────────────────────┐
    │       │                                                      │
    │       ├── regex workout match? → POST /workouts             │
    │       ├── regex weight match + !todayLogged? → POST /weight_logs  │
    │       ├── regex cal match? → POST /nutrition_logs           │
    │       └── loadAll() — osvježi state                         │
    │                                                              │
    ├── POST api.anthropic.com/v1/messages ◄──────────────────────┘
    │       system: buildContext() (koristi osvježeni state)
    │       messages: newMessages.slice(-50)
    │
    ├── setMessages([...newMessages, {role: "assistant", reply}])
    ├── POST /chat_history (assistant poruka)
    │
    ├── Keyword check: treba li extractExercisesFromChat?
    │       Da → extractExercisesFromChat(updatedMessages) [async, background]
    │               │
    │               ├── POST api.anthropic.com/v1/messages
    │               │       (analizira zadnjih 20 poruka, vraća JSON vježbi)
    │               ├── filtriraj duplikate
    │               └── POST /exercise_goals (bulk insert)
    │
    └── setLoading(false)
```

### Ručni unos treninga (Unos tab)

```
Korisnik popuni formu → pritisne "Spremi trening"
    │
    ▼
logWorkout()
    │
    ├── Provjera: sb && wForm.exercise — ako ne, return
    ├── POST /workouts {exercise, weight_kg, sets, reps, notes, logged_at}
    ├── setWForm({...prazno})
    ├── setSaveMsg("✓ Trening spremljen")
    ├── setTimeout → setSaveMsg("") nakon 2s
    └── loadAll() — osvježi sve
```

### Generiranje weekly reporta

```
Korisnik pritisne "📋 Generiraj Weekly Report"
    │
    ▼
generateWeeklyReport()
    │
    ├── setReportLoading(true)
    ├── setWeeklyReport(null)
    │
    ├── Filtriraj iz lokalnog state-a:
    │       thisW = workouts zadnjih 7 dana
    │       lastW = workouts dana 7-14 unazad
    │       thisWt = kilaze zadnjih 7 dana
    │       lastWt = kilaze dana 7-14 unazad
    │       thisN = prehrana zadnjih 7 dana
    │
    ├── POST api.anthropic.com/v1/messages
    │       model: claude-sonnet-4-5
    │       max_tokens: 800
    │       messages: [{ role: "user", content: prompt s podacima }]
    │       (bez system prompta)
    │
    ├── setWeeklyReport(odgovor)
    └── setReportLoading(false)
```

---

## 13. Poznati Bugovi & Problemi

### Bug 1: saveGoal() uvijek kreira novi red (ne updatea)
**Simptom:** Svaki put kad spremiš vježbu u Plan formu, kreira se novi red umjesto da se updatea postojeći.  
**Uzrok:** `upsert()` bez unique constrainta na (exercise, training_day) — Supabase ne zna koji red updateati pa kreira novi.  
**Fix:** Dodaj `UNIQUE(exercise, training_day)` u bazi, ili koristi `eq("id").update()`.

### Bug 2: saveMemoryEdit() može ne raditi ispravno
**Simptom:** Editiranje memorijskog unosa možda ne sprema ispravno.  
**Uzrok:** `eq("id", item.id).upsert()` — kombinacija WHERE filtera i upserta je nestandardna.  
**Fix:** Koristi `eq("id", item.id).update({key, value})` umjesto upsert.

### Bug 3: Duplikati vježbi u Plan tabu
**Simptom:** Iste vježbe se pojavljuju više puta.  
**Uzrok:** `extractExercisesFromChat()` uspoređuje s `goals` state-om koji može biti zastario u trenutku ekstrakcije (race condition između async poziva i loadAll).  
**Djelomičan fix implementiran:** Filtrira po lowercase imenu, ali async race condition ostaje.

### Bug 4: "Nema treninga još" u Povijesti
**Simptom:** Povijest ne prikazuje treninge koji su uneseni kroz chat.  
**Uzrok:** Chat regex hvata samo "vježba Xkg AxB" format. Vježbe bez utega (zgibovi, trbuh) ili opisani drugačije ne idu u workouts tablicu.  
**Fix:** Proširiti regex ili dodati AI-based parsing za workouts (kao za exercise_goals).

### Bug 5: Kilaza se može upisati više puta kroz formu
**Simptom:** Unos tab nema zaštitu od duplicata za isti dan.  
**Uzrok:** `logWeight()` nema provjeru je li danas već uneseno (za razliku od `trySaveFromMessage`).  
**Fix:** Dodati istu provjeru u `logWeight()`.

### Bug 6: Report ne uzima u obzir exercise_goals i coach_memory
**Simptom:** Weekly report ne zna za korisnikove ciljeve ni trajnu memoriju.  
**Uzrok:** `generateWeeklyReport()` ne poziva `buildContext()` — ima vlastiti prompt bez memorije i plana.  
**Fix:** Dodati goals summary i memory summary u report prompt.

### Bug 7: Nema error handlera u SetupScreen
**Simptom:** Ako su ključevi pogrešni, app se pokrene ali sve puca tiho.  
**Uzrok:** `loadAll()` hvata grešku samo s `console.error`.

### Bug 8: Timezone problem u filtiranju datuma
**Simptom:** Na granici dana (oko ponoći) treninzi mogu biti kategorizirani u krivi tjedan u reportu.  
**Uzrok:** String komparacija ISO datuma ne uzima u obzir lokalni timezone.

---

## 14. Missing Features / TODOs

### Nije implementirano, bilo je planirano:
1. **Push notifikacije** za vaganje (svaki tjedan, isti dan)
2. **Grafovi napretka** — progress chart za kilažu i vježbe kroz vrijeme
3. **PWA manifest** — nema `manifest.json`, nema service workera, ne može se instalirati na home screen (iako se može dodati ručno u Safariju)
4. **Automatski weekly report** — report se generira samo ručno
5. **Brisanje chat historije** — ne postoji opcija čišćenja
6. **Export podataka** — nema CSV/JSON exporta
7. **Prikaz workouts u Planu** — Plan tab prikazuje samo baseline, ne i stvarne logove po vježbi
8. **Pagination** u Povijesti — prikazuju se samo prvih 10-15 zapisa

### Parcijalno implementirano:
1. **Auto-ekstrakcija vježbi** — radi ali ima race condition problem s duplikatima
2. **Markdown rendering** — samo bold i italic, ne i liste, headinzi, code
3. **Progress tracking** — infrastruktura postoji (workouts + baseline u exercise_goals) ali nema UI prikaza usporedbe

---

## 15. Potencijalni Problemi

### Sigurnost

**Kritično:**
- Anthropic API key je vidljiv u network requestovima iz browsera. Svaka osoba s pristupom uređaju može ga ukrasti.
- Supabase anon key daje puni pristup bazi (bez RLS-a). Tko ima key, može čitati/pisati/brisati sve podatke.
- `localStorage` nije šifriran — pristupačan iz bilo kojeg JavaScripta na stranici (XSS vektor).

**Prihvatljivo za:** Osobna upotreba na osobnom uređaju.  
**Nije prihvatljivo za:** Deploy na javni URL, dijeljenje s drugima, multi-user scenarij.

### Performanse

- **`loadAll()` se poziva prečesto** — svaki put kad se nešto spremi (logWorkout, logWeight, logNutrition, saveGoal, itd.) poziva se `loadAll()` koji radi 6 paralelnih Supabase poziva. Na slabijoj vezi to je vidljiva latencija.
- **`buildContext()` je `useCallback`** s dependencies [workouts, weights, nutrition, goals] — rekreira se svaki put kad se bilo koji od tih state-ova promijeni, što je ispravno ali može biti skupo ako se poziva češće nego potrebno.
- **System prompt raste** — s više memorijskih unosa, exercise_goals i workout historije, system prompt postaje veći. Claude ima limit konteksta (200k tokena za Sonnet) pa ovo nije kritično, ali veći prompt = viši API troškovi.

### Skalabilnost

- **Sve u jednom fajlu** — `App.jsx` je ~1100 linija. Teško za maintainanje. Nema component separacije.
- **Nema state managementa** — sav state je u jednoj `App` komponenti (`useState` x12+). Prop drilling bi bio problem da su komponente razdvojene.
- **Baza bez indeksa** — `logged_at` kolone nemaju indekse. Pri većem broju zapisa (tisuće), `ORDER BY logged_at` će biti spor.
- **Chat history raste neograničeno** — nema automatskog čišćenja. Nakon godinu dana, `chat_history` može imati tisuće redova. API dobiva samo zadnjih 50 ali loadAll učitava sve 50 pri svakom pozivu.

### Troškovi

- Svaka chat poruka = minimalno 1 API poziv (do 2 ako se triggerira exercise ekstrakcija)
- Weekly report = 1 API poziv
- Memory ekstrakcija = 1 API poziv
- Claude Sonnet 4-5: ~$3/M input tokena, ~$15/M output tokena
- System prompt je ~500-800 tokena, messages do ~10,000 tokena za 50 poruka
- Procjena: 10-20 poruka dnevno ≈ $0.10-0.30/dan ≈ $3-9/mjesec pri intenzivnoj upotrebi

---

## Appendix: Supabase Lite Client

App ne koristi Supabase JavaScript SDK. Implementiran je minimalan custom client koji podržava:

```js
createSupabase(url, key)
  .from("table")
  .eq("col", val)      // WHERE col = val
  .gte("col", val)     // WHERE col >= val
  .lte("col", val)     // WHERE col <= val
  .order("col", {ascending: true/false})
  .limit(n)
  .select("*")         // GET request
  .insert(data)        // POST request
  .upsert(data)        // POST s Prefer: merge-duplicates
  .delete()            // DELETE request (zahtijeva .eq() filter)
```

Svaki `from()` poziv vraća novi query objekt s metodama koje se chainaju. Async metode (`select`, `insert`, `upsert`, `delete`) šalju HTTP request i vraćaju `{data, error}`.

**Ograničenja:**
- Nema `.or()` filtera
- Nema `.in()` filtera  
- Nema realtime subscriptiona
- Nema auth metoda
- `upsert` radi samo s unique constraintima na tablici
