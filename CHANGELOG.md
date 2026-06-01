# FitCoach AI — Changelog

## v1.7.0 — 1. 6. 2025.

### Novo
- **Coach tool: save_exercise_goal** — kad kažeš "cilj mi je 4x15 HSPU", coach automatski spremi cilj (i baseline) direktno u biblioteku vježbi; kreira vježbu ako ne postoji
- **Promjena datuma u day modalu** — 📅 ikona pored naziva dana otvara date picker za odabir drugog datuma

### Popravljeno
- **Coach system prompt** — coach više ne govori o vježbama koje nisu u biblioteci; eksplicitna instrukcija za korištenje save_exercise_goal

---

## v1.6.0 — 1. 6. 2025.

### Novo
- **Učitaj još u Dnevniku** — gumb na dnu učitava starijih 21 dan; prikazuje se samo ako ima starijih logova
- **Potvrda brisanja loga** — stisak ✕ na logu u day modalu prikazuje inline "Obriši / Ne" umjesto instant brisanja

### Popravljeno
- **Stats bar — Treninga/tjedan** — broji unikatne sessione (session_id) u zadnjih 7 dana, ne dane; 2 treninga isti dan = 2
- **Coach datum** — uvijek koristi točan datum iz system prompta, ignorirar stare datume iz chat historije

---

## v1.5.1 — 1. 6. 2025.

### Popravljeno
- **Coach datum** — coach sada uvijek zna točan dan; injected date podsjetnik na svaki API poziv + jača instrukcija u system promptu da ignorira datume iz chat historije

---

## v1.5.0 — 1. 6. 2025.

### Novo
- **Novi unos u Dnevniku** — dashed gumb iznad dnevnika otvara day modal za danas (bez switcha na drugi tab)
- **Dodaj/uredi/briši vježbe po sessionu** — svaki session u day modalu ima vlastiti "＋ Dodaj vježbu" gumb koji dodaje u taj session; na dnu "＋ Novi trening ovaj dan" za novi session
- **Višestruki unos** — forma ostaje otvorena nakon dodavanja vježbe, resetiraju se samo polja

### Popravljeno
- **Touch scroll u chatu** — `WebkitOverflowScrolling: touch` na chat containeru
- **Zaglavljen loading** — `setLoading(false)` premješten u `finally` blok
- **Scroll na vrh pri ulasku u Coach** — `useEffect` na promjenu taba scrolls na dno
- **Datumi u Historiji logova** — prikazuju se kao "Subota, 31. 5." umjesto "2026-05-31"
- **Day modal refresh** — modal se ažurira odmah nakon dodavanja vježbe (direktni fetch, ne stale state)
- **Vidljivost TRENING 1/2 labela** — `C.muted` (undefined→crno) zamijenjen s `C.sub`
- **Brzi log maknut iz Vježbe taba** — logiranje treninga sada samo kroz Dnevnik

---

## v1.4.0 — 31. 5. 2025.

### Novo
- **Session queue (Brzi log)** — dodaj više vježbi u pending listu pa spremi sve odjednom s jednim session_id; vide se u dnevniku kao isti trening
- **Day modal** — klik na datum u Dnevniku otvara modal s cijelim danom, grupiran po sessionima ("Trening 1", "Trening 2")
- **Edit i brisanje logova** — ✏️/✕ gumbi na svakom logu u day modalu, edit modal za izmjenu vježbe/kg/seti/reps

### Popravljeno
- **Dodaj vježbu u trening** — nova vježba dodana kroz day modal sada se sprema u isti session (ne stvara novi "Trening 2")
- **Enter navigacija u day modalu** — kg → Seti → Reps → Spremi (isto kao u Brzi log)

---

## v1.3.0 — 31. 5. 2025.

### Novo
- **Baseline i cilj na vježbama** — forma za dodavanje vježbe sad ima polje "Početno stanje" (baseline) uz cilj; coach vidi oba u kontekstu
- **Edit vježbe** — ✏️ gumb na svakoj vježbi u biblioteci, otvara pre-fillanu formu za izmjenu
- **Napredak → Dnevnik** — klik na datum u historiji logova otvara modal s cijelim treningom tog dana (sve vježbe)
- **Napredak stat boxovi** — prikazuju se čim je vježba odabrana, čak i bez logova (Početak / Zadnji / Cilj umjesto PR)

### Navigacijska logika
- Vježbe → klik na karticu → Napredak (filtriran na tu vježbu)
- Napredak → klik na datum → modal s cijelim danom
- Dnevnik → klik na vježbu → modal s historijom te vježbe

---

## v1.2.0 — 31. 5. 2025.

### Novo
- **Modal za vježbu u Dnevniku** — klik na naziv vježbe otvara sheet s kompletnom historijom logova (datum + kg/sets×reps)
- **Auto-login iz env varijabli** — app se automatski loginira ako su `VITE_SB_URL`, `VITE_SB_KEY`, `VITE_AI_KEY` postavljeni u Vercel project settingsima

### Popravljeno
- Modal se otvara iznad tab navigacije (ne skriva se iza nje)

---

## v1.1.0 — 30. 5. 2025.

### Novo
- **Dnevnik tab** — zaseban tab s pregledom treninga grupiranim po danima (zadnjih 21 dan)

### Poboljšano
- **Nova vježba** — forma je sada skrivena iza "+ Nova vježba" gumba, otvara se na klik i zatvara nakon dodavanja

## v1.0.0 — 30. 5. 2025. (Initial Release)

### Novo
- **Coach tab** — AI fitness coach na hrvatskom, pamti kontekst treninga i daje personalizirane savjete
- **Vježbe tab** — biblioteka vježbi s mišićnom skupinom, ciljem i zadnjim logom
- **Napredak tab** — dnevnik treninga grupiran po danima, progress chart po vježbi, trend kilaze
- **Brzi log** — unos treninga i kilaze direktno iz Vježbe taba
- **AI tool use** — coach automatski sprema workout i kilazu iz chata (bez regexova)
- **Stats bar** — kilaza, treninzi ovaj tjedan, zadnji trening
- **Setup screen** — unos Supabase i Anthropic API ključeva, čuvaju se u localStorage

### Tehničko
- Model: `claude-sonnet-4-6`
- Baza: `exercises`, `workout_logs`, `weight_logs`, `chat_history`
- Deploy: Vercel — [ai-coach-kappa-liart.vercel.app](https://ai-coach-kappa-liart.vercel.app)
- Stack: React 18, Vite 5, Recharts, custom Supabase REST klient
