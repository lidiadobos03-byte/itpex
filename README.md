# ITPEX

<p align="center">
  <img src="logo.png" alt="ITPEX Logo" width="180">
</p>

<p align="center">
  Site de prezentare și sistem de programări online pentru o stație ITP autorizată RAR.
</p>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-18%2B-1A4D2E?style=for-the-badge&logo=node.js&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-5-111827?style=for-the-badge&logo=express&logoColor=white">
  <img alt="Status" src="https://img.shields.io/badge/Status-Active-2D7A47?style=for-the-badge">
</p>

## Despre proiect

ITPEX este un proiect web pentru o stație ITP care combină:

- o pagină de prezentare modernă, orientată spre conversie
- un calendar de disponibilitate pentru programări
- un formular complet pentru rezervarea inspecției
- un backend Node.js/Express pentru stocare, validare și administrare
- notificări email și export automat în Excel

Aplicația este gândită pentru fluxul real al unei stații ITP: clientul își alege data și ora, completează datele de contact și ale mașinii, iar rezervarea ajunge în backend, este salvată și poate fi gestionată ulterior de administrator.

## Funcționalități

- Programări online cu selecție de dată și interval orar
- Validare pentru sloturi ocupate, zile trecute și duminică
- Formular cu date client, date mașină, observații și consimțământ GDPR
- Confirmare vizuală după trimiterea programării
- Salvare draft în browser pentru formularul început de utilizator
- Fallback local în browser dacă backendul devine indisponibil temporar
- Trimitere email către administrator cu atașament Excel actualizat
- Trimitere email de confirmare către client dacă există adresă de email
- Stocare rezervări în fișier JSON sau Redis
- Endpoint-uri admin pentru autentificare, modificare status, ștergere și blocare/deblocare intervale

## Stack tehnic

- Frontend: HTML, CSS, JavaScript vanilla
- Backend: Node.js + Express
- Sesiuni: `express-session`
- Email: `resend`
- Export Excel: `exceljs`
- Persistență: fișier local JSON sau Redis prin `ioredis`

## Structura proiectului

```text
ITPEX/
├── index.html
├── politica.html
├── logo.png
├── server.js
├── package.json
├── netlify-dist/
│   ├── index.html
│   ├── politica.html
│   └── logo.png
└── data/
    ├── store.json
    └── programari-itp.xlsx
```

## Cum pornești proiectul local

### 1. Instalează dependențele

```bash
npm install
```

### 2. Creează fișierul `.env`

Exemplu minim:

```env
ADMIN_PASS=parola-admin
ADMIN_KEY=cheie-admin-optionala
SESSION_SECRET=schimba-aceasta-valoare
```

Exemplu extins:

```env
ADMIN_PASS=parola-admin
ADMIN_KEY=cheie-admin-optionala
SESSION_SECRET=un-secret-lung-si-greu-de-ghicit

RESEND_API_KEY=re_xxxxxxxxx
RESEND_FROM=programari@domeniu.ro
MAIL_TO=contact@domeniu.ro

SUPPORT_PHONE=0741406263
ALLOWED_ORIGIN=http://localhost:3000
REDIS_URL=redis://localhost:6379
DATA_DIR=./data
BUSINESS_TIMEZONE=Europe/Bucharest
```

### 3. Pornește serverul

```bash
npm start
```

Aplicația va fi disponibilă la:

```text
http://localhost:3000
```

## Variabile de mediu

| Variabilă | Rol | Necesară |
| --- | --- | --- |
| `ADMIN_PASS` | parola pentru login admin | Da, recomandat |
| `ADMIN_KEY` | cheie alternativă pentru endpoint-urile protejate | Opțional |
| `SESSION_SECRET` | secret pentru sesiuni | Da, recomandat |
| `RESEND_API_KEY` | cheia API pentru email | Opțional |
| `RESEND_FROM` | expeditorul emailurilor | Opțional |
| `MAIL_TO` | adresa care primește rezervările | Opțional |
| `SUPPORT_PHONE` | numărul afișat în comunicarea cu clientul | Opțional |
| `ALLOWED_ORIGIN` | origine permisă pentru CORS | Opțional |
| `REDIS_URL` | persistență în Redis | Opțional |
| `DATA_DIR` | locație custom pentru stocarea fișierelor | Opțional |
| `BUSINESS_TIMEZONE` | fusul orar al aplicației | Opțional |

Nota:

- Pentru emailuri trebuie configurate împreună `RESEND_API_KEY`, `RESEND_FROM` și `MAIL_TO`.
- Dacă `REDIS_URL` lipsește, rezervările sunt salvate local în `data/store.json`.
- Serverul acceptă și alias-uri precum `ADMIN_PASSWORD`, `ADMIN_TOKEN`, `MAIL_FROM`, `ADMIN_EMAIL`, `PHONE` sau `FRONTEND_ORIGIN`.

## Endpoint-uri API

### Publice

| Metodă | Endpoint | Descriere |
| --- | --- | --- |
| `GET` | `/api/availability` | întoarce sloturile rezervate și intervalele blocate |
| `POST` | `/api/bookings` | creează o programare nouă |

### Admin

| Metodă | Endpoint | Descriere |
| --- | --- | --- |
| `POST` | `/api/login` | autentificare admin pe baza parolei |
| `GET` | `/api/session` | verifică dacă sesiunea admin este activă |
| `POST` | `/api/logout` | închide sesiunea curentă |
| `GET` | `/api/admin/state` | lista completă de rezervări + sloturi blocate |
| `PATCH` | `/api/admin/bookings/:id/status` | actualizează statusul unei programări |
| `DELETE` | `/api/admin/bookings/:id` | șterge o programare |
| `POST` | `/api/admin/block` | blochează o dată sau un interval |
| `POST` | `/api/admin/unblock` | deblochează o dată sau un interval |

Autentificarea pentru zona admin se face fie prin sesiune, fie prin header-ul:

```http
X-Admin-Key: cheia-ta
```

## Persistență și fișiere generate

- `data/store.json` păstrează rezervările și intervalele blocate
- `data/programari-itp.xlsx` este generat automat pentru evidența programărilor
- dacă este configurat Redis, aplicația folosește Redis și păstrează în paralel și snapshot local

## Observații de dezvoltare

- Serverul Express livrează fișierele statice din folderul `netlify-dist`
- În acest moment, fișierele din rădăcină (`index.html`, `politica.html`, `logo.png`) există și în `netlify-dist`
- Dacă modifici frontendul, este bine să menții sincronizate și copiile din `netlify-dist`
- Nu există încă teste automate configurate

## Fluxul aplicației

1. Utilizatorul alege o dată și o oră disponibile.
2. Completează formularul cu datele personale și ale autovehiculului.
3. Frontendul validează câmpurile obligatorii și disponibilitatea slotului.
4. Backendul salvează rezervarea, actualizează snapshot-ul Excel și trimite emailurile, dacă sunt configurate.
5. Administratorul poate gestiona ulterior rezervările prin endpoint-urile protejate.

## Posibile îmbunătățiri

- panou admin cu interfață vizuală, nu doar API
- `.env.example` dedicat pentru onboarding mai rapid
- sistem real de reminder automat pentru expirarea ITP
- teste automate pentru fluxurile critice
- pas de build/deploy care sincronizează automat fișierele din `netlify-dist`

## Licență

Conform `package.json`, proiectul folosește licența `ISC`.
