require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const { Resend } = require("resend");
const Redis = require("ioredis");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD;
const ADMIN_KEY = process.env.ADMIN_KEY || process.env.ADMIN_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-session-secret";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || process.env.MAIL_FROM;
const MAIL_TO = process.env.MAIL_TO || process.env.ADMIN_EMAIL;
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || process.env.PHONE || "0741 406 263";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.FRONTEND_ORIGIN;
const REDIS_URL = process.env.REDIS_URL;

let mailer = null;
let emailWarningShown = false;
let redis = null;

function getRedis() {
  if (!REDIS_URL) return null;
  if (!redis) {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    redis.connect().catch(() => {});
  }
  return redis;
}

function getMailer() {
  if (!RESEND_API_KEY || !MAIL_TO || !RESEND_FROM) return null;
  if (!mailer) {
    mailer = new Resend(RESEND_API_KEY);
  }
  return mailer;
}

async function buildBookingsExcel(bookings = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Programări");
  ws.columns = [
    { header: "Nume", key: "name", width: 22 },
    { header: "Telefon", key: "phone", width: 14 },
    { header: "Email", key: "email", width: 24 },
    { header: "Nr. Auto", key: "plate", width: 12 },
    { header: "Marca / Model", key: "marcaModel", width: 18 },
    { header: "Combustibil", key: "combustibil", width: 12 },
    { header: "An", key: "an", width: 8 },
    { header: "Data", key: "date", width: 14 },
    { header: "Ora", key: "time", width: 10 },
    { header: "Serviciu", key: "service", width: 16 },
    { header: "Observații", key: "notes", width: 28 },
    { header: "Reminder", key: "reminderChannel", width: 12 },
    { header: "Status", key: "status", width: 10 },
    { header: "Creat la", key: "createdAt", width: 20 },
  ];

  const ordered = [...bookings].sort((a, b) => {
    const toTs = (item) => {
      const base = item.date || item.dateText || "1970-01-01";
      const t = item.time || "00:00";
      const d = new Date(`${base}T${t}`);
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    };
    return toTs(a) - toTs(b);
  });

  ordered.forEach((booking) => {
    ws.addRow({
      name: booking.name,
      phone: booking.phone,
      email: booking.email || "-",
      plate: booking.plate,
      marcaModel: booking.marcaModel || booking.model || "-",
      combustibil: booking.combustibil || booking.fuel || "-",
      an: booking.an || booking.year || "-",
      date: booking.dateText || booking.date,
      time: booking.time,
      service: booking.service || "ITP",
      notes: booking.notes || "-",
      reminderChannel: booking.reminderChannel || "-",
      status: booking.status || "-",
      createdAt: booking.createdAt || "-",
    });
  });

  ws.getRow(1).font = { bold: true };
  return wb.xlsx.writeBuffer();
}

async function sendBookingEmail(booking) {
  const transport = getMailer();
  if (!transport) {
    if (!emailWarningShown) {
      console.warn("ℹ️ Email trimitere dezactivată: setează RESEND_API_KEY, RESEND_FROM și MAIL_TO.");
      emailWarningShown = true;
    }
    return;
  }

  try {
    const store = await readStore();
    const excelBuffer = await buildBookingsExcel(store.bookings || []);
    const subject = `Programare ITP ${booking.date} ${booking.time} — ${booking.name}`;
    const text = [
      `Nume: ${booking.name}`,
      `Telefon: ${booking.phone}`,
      `Email: ${booking.email || "-"}`,
      `Nr auto: ${booking.plate}`,
      `Data: ${booking.dateText || booking.date}`,
      `Ora: ${booking.time}`,
      `Serviciu: ${booking.service || "ITP"}`,
      `Observații: ${booking.notes || "-"}`,
    ].join("\n");

    await transport.emails.send({
      from: RESEND_FROM,
      to: MAIL_TO,
      subject,
      text,
      attachments: [
        {
          filename: `programari-itp.xlsx`,
          content: excelBuffer.toString("base64"),
        },
      ],
    });
  } catch (err) {
    console.warn("⚠️  Nu am putut trimite emailul cu Excel:", err.message);
  }
}

async function sendClientEmail(booking) {
  if (!booking.email) return;
  const transport = getMailer();
  if (!transport) return;
  try {
    const subject = `Confirmare programare ITP ${booking.date} ${booking.time}`;
    const text = [
      `Bună, ${booking.name}!`,
      `Programarea ta ITP a fost înregistrată.`,
      `Data: ${booking.dateText || booking.date}`,
      `Ora: ${booking.time}`,
      `Nr auto: ${booking.plate}`,
      `Serviciu: ${booking.service || "ITP"}`,
      `Observații: ${booking.notes || "-"}`,
      ``,
      `Ne vedem la ITPEX, Str. Daciei nr. 30.`,
      `Dacă ai întrebări, sună-ne la ${SUPPORT_PHONE}.`,
    ].join("\n");
    await transport.emails.send({
      from: RESEND_FROM,
      to: booking.email,
      subject,
      text,
    });
  } catch (err) {
    console.warn("⚠️  Nu am putut trimite emailul de confirmare către client:", err.message);
  }
}

if (!ADMIN_PASS) {
  console.warn("⚠️  Set ADMIN_PASS env var for production. Using fallback 'admin' for now.");
}

const STORE_KEY = "itpex:store:v1";

async function readStore() {
  const client = getRedis();
  if (client) {
    try {
      const raw = await client.get(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.warn("ℹ️ Redis read fallback to file:", err.message);
    }
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(raw || '{"bookings":[],"blocked":{}}');
  } catch {
    const init = { bookings: [], blocked: {} };
    await fs.writeFile(DATA_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
}

async function writeStore(store) {
  const client = getRedis();
  if (client) {
    try {
      await client.set(STORE_KEY, JSON.stringify(store));
      return;
    } catch (err) {
      console.warn("ℹ️ Redis write fallback to file:", err.message);
    }
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
}

function requireAuth(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query?.admin_key;
  if (req.session?.isAdmin) return next();
  if (ADMIN_KEY && key === ADMIN_KEY) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key, x-admin-key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(
  session({
    name: "itpex.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8, // 8h
    },
  })
);

// ── AUTH ────────────────────────────────────────────────────────────────────
app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  const expected = ADMIN_PASS || "admin";
  if (password && password === expected) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "Parolă incorectă" });
});

app.get("/api/session", (req, res) => {
  res.json({ ok: true, loggedIn: !!req.session?.isAdmin });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ── PUBLIC ENDPOINTS ────────────────────────────────────────────────────────
app.get("/api/availability", async (_req, res) => {
  const store = await readStore();
  const publicBookings = store.bookings.map((b) => ({
    id: b.id,
    date: b.date,
    time: b.time,
    status: b.status,
  }));
  res.json({ bookings: publicBookings, blocked: store.blocked || {} });
});

app.post("/api/bookings", async (req, res) => {
  const booking = req.body || {};
  if (!booking.name || !booking.phone || !booking.plate || !booking.date || !booking.time) {
    return res.status(400).json({ ok: false, error: "Câmpuri obligatorii lipsă" });
  }
  const store = await readStore();
  const isTaken =
    (store.blocked?.[booking.date] || []).includes(booking.time) ||
    store.bookings.some((b) => b.date === booking.date && b.time === booking.time && b.status !== "anulat");
  if (isTaken) return res.status(409).json({ ok: false, error: "Interval deja ocupat" });

  const newBooking = {
    ...booking,
    id: booking.id || crypto.randomUUID(),
    status: booking.status || "confirmat",
    createdAt: new Date().toISOString(),
  };
  store.bookings.push(newBooking);
  await writeStore(store);
  sendBookingEmail(newBooking).catch(() => {});
  sendClientEmail(newBooking).catch(() => {});
  res.json({ ok: true, booking: newBooking });
});

// ── ADMIN ENDPOINTS ─────────────────────────────────────────────────────────
app.get("/api/admin/state", requireAuth, async (_req, res) => {
  const store = await readStore();
  res.json({ ok: true, bookings: store.bookings || [], blocked: store.blocked || {} });
});

app.patch("/api/admin/bookings/:id/status", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ ok: false, error: "Lipsește statusul" });
  const store = await readStore();
  const idx = store.bookings.findIndex((b) => b.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "Nu există booking" });
  store.bookings[idx].status = status;
  await writeStore(store);
  res.json({ ok: true });
});

app.delete("/api/admin/bookings/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const store = await readStore();
  const before = store.bookings.length;
  store.bookings = store.bookings.filter((b) => b.id !== id);
  if (store.bookings.length === before) return res.status(404).json({ ok: false, error: "Nu există booking" });
  await writeStore(store);
  res.json({ ok: true });
});

app.post("/api/admin/block", requireAuth, async (req, res) => {
  const { date, time } = req.body || {};
  if (!date) return res.status(400).json({ ok: false, error: "Lipsește data" });
  const store = await readStore();
  if (!store.blocked[date]) store.blocked[date] = [];
  if (time) {
    if (!store.blocked[date].includes(time)) store.blocked[date].push(time);
  } else {
    const ALL = ["08:00","08:45","09:30","10:15","11:00","11:45","13:00","13:45","14:30","15:15","16:00","16:45","17:30","18:15","19:00","19:45"];
    store.blocked[date] = Array.from(new Set([...(store.blocked[date] || []), ...ALL]));
  }
  await writeStore(store);
  res.json({ ok: true });
});

// ── STATIC FILES ────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname);
app.use(express.static(PUBLIC_DIR));

// Fallback to index for other GETs
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ITPEX server pornit pe http://localhost:${PORT}`);
});
