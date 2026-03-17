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
const EXCEL_FILE = path.join(DATA_DIR, "programari-itp.xlsx");
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD;
const ADMIN_KEY = process.env.ADMIN_KEY || process.env.ADMIN_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-session-secret";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || process.env.MAIL_FROM;
const MAIL_TO = process.env.MAIL_TO || process.env.ADMIN_EMAIL;
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || process.env.PHONE || "0741 406 263";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.FRONTEND_ORIGIN;
const REDIS_URL = process.env.REDIS_URL;
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "Europe/Bucharest";
const SLOT_TIMES = ["08:00", "08:45", "09:30", "10:15", "11:00", "11:45", "13:00", "13:45", "14:30", "15:15", "16:00", "16:45", "17:30", "18:15", "19:00", "19:45"];
const WEEKDAYS_RO = ["Duminica", "Luni", "Marti", "Miercuri", "Joi", "Vineri", "Sambata"];

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
  wb.creator = "ITPEX";
  wb.created = new Date();
  ws.columns = [
    { header: "Data", key: "date", width: 13 },
    { header: "Zi", key: "weekday", width: 12 },
    { header: "Ora", key: "time", width: 10 },
    { header: "Status", key: "status", width: 10 },
    { header: "Nume", key: "name", width: 22 },
    { header: "Telefon", key: "phone", width: 14 },
    { header: "Nr. Auto", key: "plate", width: 12 },
    { header: "Marca / Model", key: "marcaModel", width: 20 },
    { header: "Combustibil", key: "combustibil", width: 12 },
    { header: "An", key: "an", width: 8 },
    { header: "Email", key: "email", width: 24 },
    { header: "Serviciu", key: "service", width: 16 },
    { header: "Reminder", key: "reminderChannel", width: 12 },
    { header: "Observații", key: "notes", width: 34 },
    { header: "Creat la", key: "createdAt", width: 20 },
  ];

  const ordered = sortBookings(bookings);

  ordered.forEach((booking) => {
    ws.addRow({
      date: formatDateForDisplay(booking.date || booking.dateText),
      weekday: getWeekdayLabel(booking.date),
      time: booking.time,
      status: booking.status || "-",
      name: booking.name,
      phone: booking.phone,
      plate: booking.plate,
      marcaModel: booking.marcaModel || booking.model || "-",
      combustibil: booking.combustibil || booking.fuel || "-",
      an: booking.an || booking.year || "-",
      email: booking.email || "-",
      service: booking.service || "ITP",
      reminderChannel: booking.reminderChannel || "-",
      notes: booking.notes || "-",
      createdAt: formatDateTimeForDisplay(booking.createdAt),
    });
  });

  ws.views = [{ state: "frozen", xSplit: 4, ySplit: 1 }];
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: ws.columns.length },
  };
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1A4D2E" },
  };
  ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
  ws.getRow(1).height = 22;

  const centerColumns = new Set(["A", "B", "C", "D", "F", "G", "H", "K", "M"]);
  ws.eachRow((row, rowNumber) => {
    row.eachCell((cell, colNumber) => {
      const columnLetter = ws.getColumn(colNumber).letter;
      cell.border = {
        top: { style: "thin", color: { argb: "FFD1D5DB" } },
        left: { style: "thin", color: { argb: "FFD1D5DB" } },
        bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
        right: { style: "thin", color: { argb: "FFD1D5DB" } },
      };
      cell.alignment = {
        vertical: "middle",
        horizontal: centerColumns.has(columnLetter) ? "center" : "left",
        wrapText: columnLetter === "N",
      };

      if (rowNumber > 1) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: rowNumber % 2 === 0 ? "FFF7FBF9" : "FFFFFFFF" },
        };
      }
    });
  });

  return wb.xlsx.writeBuffer();
}

function sortSlotTimes(times = []) {
  return [...times].sort((a, b) => SLOT_TIMES.indexOf(a) - SLOT_TIMES.indexOf(b));
}

function sortBlockedMap(blocked = {}) {
  return Object.fromEntries(
    Object.entries(blocked)
      .sort(([dateA], [dateB]) => String(dateA).localeCompare(String(dateB)))
      .map(([date, times]) => [date, sortSlotTimes(times)])
  );
}

function normalizeBlockedMap(rawBlocked) {
  const normalized = {};
  if (!rawBlocked || typeof rawBlocked !== "object") return normalized;

  Object.entries(rawBlocked).forEach(([date, times]) => {
    if (!Array.isArray(times)) return;
    const cleanTimes = sortSlotTimes(Array.from(new Set(times.filter((time) => SLOT_TIMES.includes(time)))));
    if (cleanTimes.length) normalized[date] = cleanTimes;
  });

  return sortBlockedMap(normalized);
}

function normalizeStore(store) {
  const bookings = Array.isArray(store?.bookings) ? store.bookings : [];
  const hasManualBlocked = !!(store?.manualBlocked && typeof store.manualBlocked === "object");
  const sourceBlocked = hasManualBlocked ? store.manualBlocked : store?.blocked;
  const blocked = normalizeBlockedMap(sourceBlocked);

  if (!hasManualBlocked) {
    const bookedByDate = new Map();
    bookings.forEach((booking) => {
      if (!booking?.date || !booking?.time) return;
      if (!bookedByDate.has(booking.date)) bookedByDate.set(booking.date, new Set());
      bookedByDate.get(booking.date).add(booking.time);
    });

    Object.entries(blocked).forEach(([date, times]) => {
      const bookedTimes = bookedByDate.get(date);
      if (!bookedTimes) return;
      const manualOnly = times.filter((time) => !bookedTimes.has(time));
      if (manualOnly.length) blocked[date] = manualOnly;
      else delete blocked[date];
    });
  }

  return { bookings, blocked: sortBlockedMap(blocked), manualBlocked: sortBlockedMap(blocked) };
}

function getDateKeyInTimeZone(date = new Date(), timeZone = BUSINESS_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function parseDateKey(dateValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue || "");
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day, weekday: date.getUTCDay() };
}

function validateBookingSlot(dateValue, timeValue) {
  const parsedDate = parseDateKey(dateValue);
  if (!parsedDate) return "Data selectată este invalidă";
  if (parsedDate.weekday === 0) return "Nu se pot face programări duminica";
  if (dateValue < getDateKeyInTimeZone()) return "Nu se pot face programări în trecut";
  if (!SLOT_TIMES.includes(timeValue)) return "Ora selectată este invalidă";
  return null;
}

function getBookingSortKey(booking = {}) {
  const parsedDate = parseDateKey(booking.date);
  const datePart = parsedDate ? booking.date : "9999-99-99";
  const timePart = SLOT_TIMES.includes(booking.time) ? booking.time : "99:99";
  const createdAtPart = booking.createdAt || "9999-99-99T99:99:99.999Z";
  const platePart = booking.plate || "";
  return `${datePart}|${timePart}|${createdAtPart}|${platePart}`;
}

function sortBookings(bookings = []) {
  return [...bookings].sort((a, b) => getBookingSortKey(a).localeCompare(getBookingSortKey(b), "ro"));
}

function formatDateForDisplay(dateValue) {
  const parsed = parseDateKey(dateValue);
  if (!parsed) return dateValue || "-";
  return `${String(parsed.day).padStart(2, "0")}.${String(parsed.month).padStart(2, "0")}.${parsed.year}`;
}

function getWeekdayLabel(dateValue) {
  const parsed = parseDateKey(dateValue);
  return parsed ? WEEKDAYS_RO[parsed.weekday] : "-";
}

function formatDateTimeForDisplay(dateValue) {
  if (!dateValue) return "-";
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return String(dateValue);
  return new Intl.DateTimeFormat("ro-RO", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

async function writeExcelSnapshot(bookings = []) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const excelBuffer = await buildBookingsExcel(bookings);
  await fs.writeFile(EXCEL_FILE, Buffer.from(excelBuffer));
  return excelBuffer;
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
    const excelBuffer = await writeExcelSnapshot(store.bookings || []);
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
      if (raw) return normalizeStore(JSON.parse(raw));
    } catch (err) {
      console.warn("ℹ️ Redis read fallback to file:", err.message);
    }
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return normalizeStore(JSON.parse(raw || '{"bookings":[],"blocked":{},"manualBlocked":{}}'));
  } catch {
    const init = { bookings: [], blocked: {}, manualBlocked: {} };
    await fs.writeFile(DATA_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
}

async function writeStore(store) {
  const normalized = normalizeStore(store);
  const client = getRedis();
  if (client) {
    try {
      await client.set(STORE_KEY, JSON.stringify(normalized));
    } catch (err) {
      console.warn("ℹ️ Redis write fallback to file:", err.message);
    }
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(normalized, null, 2), "utf8");
  await writeExcelSnapshot(normalized.bookings || []);
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
  const validationError = validateBookingSlot(booking.date, booking.time);
  if (validationError) {
    return res.status(400).json({ ok: false, error: validationError });
  }
  const store = await readStore();
  const isTaken =
    (store.blocked?.[booking.date] || []).includes(booking.time) ||
    store.bookings.some((b) => b.date === booking.date && b.time === booking.time);
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
  res.json({ ok: true, bookings: sortBookings(store.bookings || []), blocked: sortBlockedMap(store.blocked || {}) });
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
  if (!parseDateKey(date)) return res.status(400).json({ ok: false, error: "Data este invalidă" });
  if (time && !SLOT_TIMES.includes(time)) return res.status(400).json({ ok: false, error: "Ora este invalidă" });
  const store = await readStore();
  if (!store.blocked[date]) store.blocked[date] = [];
  if (time) {
    if (!store.blocked[date].includes(time)) store.blocked[date].push(time);
  } else {
    store.blocked[date] = Array.from(new Set([...(store.blocked[date] || []), ...SLOT_TIMES]));
  }
  await writeStore(store);
  res.json({ ok: true });
});

app.post("/api/admin/unblock", requireAuth, async (req, res) => {
  const { date, time } = req.body || {};
  if (!date) return res.status(400).json({ ok: false, error: "Lipsește data" });
  if (!parseDateKey(date)) return res.status(400).json({ ok: false, error: "Data este invalidă" });
  if (time && !SLOT_TIMES.includes(time)) return res.status(400).json({ ok: false, error: "Ora este invalidă" });

  const store = await readStore();
  const existing = store.blocked[date] || [];

  if (time) {
    store.blocked[date] = existing.filter((slot) => slot !== time);
    if (!store.blocked[date].length) delete store.blocked[date];
  } else {
    delete store.blocked[date];
  }

  await writeStore(store);
  res.json({ ok: true, blocked: sortBlockedMap(store.blocked) });
});

// ── STATIC FILES ────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, "netlify-dist");
app.use(express.static(PUBLIC_DIR));

// Fallback to index for other GETs
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ITPEX server pornit pe http://localhost:${PORT}`);
  readStore()
    .then((store) => writeExcelSnapshot(store.bookings || []))
    .catch((err) => console.warn("⚠️  Nu am putut inițializa Excel-ul cu programări:", err.message));
});
