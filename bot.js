// ============================================================
//  نظام إدارة عقود المقاولات — Telegram Bot v3.0
//  يعمل على: Node.js 18+
//  المكتبات: node-telegram-bot-api, googleapis, puppeteer, dotenv
// ============================================================

require("dotenv").config();
process.env.NTBA_FIX_350 = "1";

const TelegramBot = require("node-telegram-bot-api");
const { google }  = require("googleapis");
const fs          = require("fs");
const path        = require("path");
const puppeteer   = require("puppeteer");

// ─── الإعدادات ── تُقرأ من .env ──────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const YOUR_CHAT_ID   = process.env.YOUR_CHAT_ID;
const COMPANY_NAME   = process.env.COMPANY_NAME || "شركة صروح العالمية لتشطيب المباني";
const LOGO_PATH      = path.join(__dirname, "logo.png");
const LOG_FILE       = path.join(__dirname, "bot.log");
const PID_FILE       = path.join(__dirname, "bot.pid");
const COUNTER_FILE   = path.join(__dirname, "invoice_counter.txt");

// التحقق من المتغيرات الإلزامية
if (!TELEGRAM_TOKEN) throw new Error("❌ TELEGRAM_TOKEN غير موجود في .env");
if (!SPREADSHEET_ID) throw new Error("❌ SPREADSHEET_ID غير موجود في .env");
if (!YOUR_CHAT_ID)   throw new Error("❌ YOUR_CHAT_ID غير موجود في .env");

// ─── Google Credentials: Railway env var → direct object ──────
// On Railway: set GOOGLE_CREDENTIALS to the full JSON content of credentials.json
// Locally:    uses credentials.json file as fallback
let googleAuthConfig;
if (process.env.GOOGLE_CREDENTIALS) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    googleAuthConfig = { credentials: creds };
    console.log("✅ Google credentials loaded from environment variable");
  } catch (e) {
    throw new Error("❌ GOOGLE_CREDENTIALS env var is not valid JSON: " + e.message);
  }
} else {
  googleAuthConfig = { keyFile: path.join(__dirname, "credentials.json") };
  console.log("✅ Google credentials loaded from credentials.json file");
}

// ─── منع تشغيل أكثر من نسخة (PID Lock) ──────────────────────
if (fs.existsSync(PID_FILE)) {
  const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
  try {
    process.kill(oldPid, 0); // تحقق هل العملية حية
    console.error(`⚠️ البوت يعمل بالفعل (PID: ${oldPid}). أوقفه أولاً.`);
    process.exit(1);
  } catch {
    // العملية القديمة لم تعد موجودة — نمسح الملف ونكمل
    fs.unlinkSync(PID_FILE);
  }
}
fs.writeFileSync(PID_FILE, String(process.pid));
process.on("exit", () => { try { fs.unlinkSync(PID_FILE); } catch {} });

// ─── Logging ──────────────────────────────────────────────────
function log(level, msg, data = {}) {
  const entry = { time: new Date().toISOString(), level, msg, ...data };
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n"); } catch {}
  const prefix = level === "ERROR" ? "❌" : level === "WARN" ? "⚠️" : "✅";
  console.log(`${prefix} [${level}] ${msg}`, Object.keys(data).length ? data : "");
}

// ─── صلاحيات Google Sheets ───────────────────────────────────
const auth = new google.auth.GoogleAuth({
  ...googleAuthConfig,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ─── Retry Wrapper لـ Google Sheets API ──────────────────────
async function sheetsRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries - 1) throw e;
      const delay = 1000 * (i + 1);
      log("WARN", `إعادة محاولة Sheets API (${i + 1} من ${retries - 1})`, { error: e.message });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// إرسال رسائل طويلة مع تجزئة تلقائية (حد Telegram = 4096 حرف)
async function sendLong(chatId, text, opts = {}) {
  const MAX = 4000;
  if (text.length <= MAX) {
    return bot.sendMessage(chatId, text, opts);
  }
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > MAX) {
      await bot.sendMessage(chatId, chunk, opts);
      chunk = line;
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) await bot.sendMessage(chatId, chunk, opts);
}

// ─── تشغيل البوت ─────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const sessions = {};

// ─── Lock لمنع الدفعات المتزامنة لنفس العقد ──────────────────
const processingLocks = new Set();

// ─── Invoice counter (atomic, loaded once at startup) ────────
let invoiceCounter = 0;
try {
  const raw = fs.readFileSync(COUNTER_FILE, "utf8");
  invoiceCounter = parseInt(raw, 10) || 0;
} catch { /* ملف غير موجود بعد */ }

function getNextInvoiceSerial() {
  invoiceCounter++;
  fs.writeFileSync(COUNTER_FILE, String(invoiceCounter));
  return String(invoiceCounter).padStart(3, "0");
}

// ─── أنواع العقود ─────────────────────────────────────────────
const CONTRACT_TYPES = {
  "1": "سيراميك",
  "2": "ديكور",
  "3": "تصميم داخلي",
  "4": "مقاولات عامة",
};

// ─── الدوال المساعدة ──────────────────────────────────────────
function nowKuwait() {
  return new Date().toLocaleString("ar-KW", {
    timeZone: "Asia/Kuwait",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmt(n) {
  return Number(n).toFixed(3) + " د.ك";
}

// تعقيم النص قبل إدراجه في رسائل Markdown
function escapeMd(text) {
  if (!text) return "";
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

// ─── Google Sheets Helpers ────────────────────────────────────
async function sheetExists(sheetName) {
  const meta = await sheetsRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID })
  );
  return meta.data.sheets.some(s => s.properties.title === sheetName);
}

async function getAllContractSheets() {
  const meta = await sheetsRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID })
  );
  return meta.data.sheets
    .map(s => s.properties.title)
    .filter(t => t.startsWith("عقد-"));
}

// ─── البحث عن عقود برقم الهاتف ───────────────────────────────
async function findContractsByPhone(phone) {
  const sheetNames = await getAllContractSheets();
  const results = [];

  await Promise.all(sheetNames.map(async (sheetName) => {
    try {
      const res = await sheetsRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${sheetName}!A1:B15`,
        })
      );
      const rows = res.data.values || [];
      const phoneRow = rows.find(r => (r[0] || "").includes("رقم الهاتف"));
      const storedPhone = (phoneRow?.[1] || "").toString().replace(/\s/g, "");
      const queryPhone  = phone.replace(/\s/g, "");

      if (storedPhone.includes(queryPhone) || queryPhone.includes(storedPhone)) {
        const contractNo   = rows.find(r => (r[0] || "").includes("رقم العقد"))?.[1]  || sheetName.replace("عقد-", "");
        const clientName   = rows.find(r => (r[0] || "").includes("اسم العميل"))?.[1] || "";
        const contractType = rows.find(r => (r[0] || "").includes("نوع العقد"))?.[1]  || "";
        const contractValue = parseFloat(rows.find(r => (r[0] || "").includes("قيمة العقد"))?.[1]) || 0;
        results.push({ contractNo, clientName, storedPhone: phoneRow?.[1] || "", contractType, contractValue });
      }
    } catch {}
  }));

  return results;
}

// ─── إنشاء عقد جديد ──────────────────────────────────────────
async function createContractSheet(d, dateTime) {
  const sheetName = `عقد-${d.contractNo}`;
  if (await sheetExists(sheetName)) return { error: `العقد رقم ${d.contractNo} مسجل مسبقاً` };

  await sheetsRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    })
  );

  const headers = [
    ["بيانات العقد", ""],
    ["رقم العقد",       d.contractNo],
    ["اسم العميل",      d.clientName],
    ["رقم الهاتف",      d.clientPhone],
    ["عنوان العميل",    d.clientAddress],
    ["الرقم المدني",    d.civilId],
    ["نوع العقد",       d.contractType],
    ["قيمة العقد (د.ك)", d.contractValue],
    ["تاريخ التسجيل",   dateTime],
    ["", ""],
    ["رقم الدفعة", "التاريخ والوقت", "طريقة الدفع", "نوع الدفعة", "قيمة الدفعة (د.ك)", "مجموع المدفوع (د.ك)", "المتبقي (د.ك)"],
  ];

  await sheetsRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: headers },
    })
  );

  log("INFO", "عقد جديد", { contractNo: d.contractNo, client: d.clientName });
  return { success: true, sheetName };
}

// ─── قراءة بيانات عقد كاملة (API call واحدة فقط — بدون sheetExists مسبق) ──
async function getContractInfo(contractNo) {
  const sheetName = `عقد-${contractNo}`;

  let rows = [];
  try {
    const res = await sheetsRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A1:G200`,
      })
    );
    rows = res.data.values || [];
    if (!rows.length) return null; // ورقة فارغة
  } catch (e) {
    // الشيت غير موجود أو خطأ في الوصول
    if (e.code === 400 || e.code === 404 || (e.message || '').includes('Unable to parse range')) return null;
    throw e; // خطأ آخر — أعد الرمي
  }

  // قراءة البيانات بناءً على عناوين عمود A (يعمل مع الهياكل القديمة والجديدة)
  const findVal = (label) => {
    const row = rows.find(r => (r[0] || "").includes(label));
    return row?.[1] || "";
  };
  const contractNo2   = rows[1]?.[1]?.toString()  || contractNo;
  const clientName    = findVal("اسم العميل");
  const clientPhone   = findVal("رقم الهاتف");
  const clientAddress = findVal("عنوان العميل");
  const civilId       = findVal("الرقم المدني");
  const contractType  = findVal("نوع العقد");
  const contractValue = parseFloat(findVal("قيمة العقد")) || 0;
  const regDate       = findVal("تاريخ التسجيل");

  let totalPaid = 0, paymentCount = 0;
  const payments = [];

  // الصف 10 (index 10) هو أول صف للدفعات (بعد صف الرؤوس في الصف 11 وهو index 10)
  for (let i = 10; i < rows.length; i++) {
    const rawNo = rows[i]?.[0];
    if (!rawNo) continue;
    const paymentNo = parseInt(rawNo);
    if (isNaN(paymentNo)) continue;

    // كشف الشكل: القديم (بدون paymentType) vs الجديد (مع paymentType)
    let amountIdx, totalIdx, remainingIdx, paymentTypeIdx;
    if (isNaN(parseFloat(rows[i][3]))) {
      // شكل جديد: رقم | تاريخ | طريقة | نوع | مبلغ | مجموع | متبقي
      amountIdx = 4; totalIdx = 5; remainingIdx = 6; paymentTypeIdx = 3;
    } else {
      // شكل قديم: رقم | تاريخ | طريقة | مبلغ | مجموع | متبقي
      amountIdx = 3; totalIdx = 4; remainingIdx = 5; paymentTypeIdx = null;
    }

    const amt = parseFloat(rows[i][amountIdx]) || 0;
    totalPaid += amt;
    paymentCount++;
    payments.push({
      no: paymentNo,
      date: rows[i][1] || "",
      method: rows[i][2] || "",
      paymentType: paymentTypeIdx !== null ? rows[i][paymentTypeIdx] || "" : "",
      amount: amt,
      total: parseFloat(rows[i][totalIdx]) || 0,
      remaining: parseFloat(rows[i][remainingIdx]) || 0,
    });
  }

  return {
    sheetName, contractNo: contractNo2, clientName, clientPhone,
    clientAddress, civilId, contractType, contractValue,
    regDate, totalPaid, paymentCount, payments,
    remaining: contractValue - totalPaid,
  };
}

// ─── إضافة دفعة ───────────────────────────────────────────────
async function addPayment(contractNo, amount, method, paymentType, dateTime) {
  // Lock — منع الدفعات المتزامنة
  if (processingLocks.has(contractNo)) {
    return { error: "جاري معالجة دفعة أخرى لهذا العقد، انتظر لحظة ثم أعد المحاولة." };
  }
  processingLocks.add(contractNo);

  try {
    const info = await getContractInfo(contractNo);
    if (!info) return { error: `لم يتم العثور على العقد رقم ${contractNo}` };

    // ─── تحقق: الدفعة لا تتجاوز المتبقي ───────────────────────
    if (amount > info.remaining + 0.001) {
      return {
        error: `قيمة الدفعة (${fmt(amount)}) تتجاوز المبلغ المتبقي (${fmt(info.remaining)}).\nأقصى مبلغ مسموح به: ${fmt(info.remaining)}`
      };
    }

    const newTotal  = info.totalPaid + amount;
    const remaining = info.contractValue - newTotal;
    const paymentNo = info.paymentCount + 1;

    await sheetsRetry(() =>
      sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${info.sheetName}!A12`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[paymentNo, dateTime, method, paymentType, amount, newTotal, remaining]] },
      })
    );

    log("INFO", "دفعة مسجلة", { contractNo, amount, method, paymentType });
    return { success: true, paymentNo, clientName: info.clientName, contractNo, amount, totalPaid: newTotal, remaining, paymentType };
  } finally {
    processingLocks.delete(contractNo);
  }
}

// ─── تعديل بيانات عقد ────────────────────────────────────────
async function updateContractField(contractNo, field, value) {
  const sheetName = `عقد-${contractNo}`;
  if (!(await sheetExists(sheetName))) return { error: `العقد رقم ${contractNo} غير موجود` };

  // تعديل رقم العقد: يتطلب إعادة تسمية الورقة
  if (field === "contractNo") {
    const meta = await sheetsRetry(() =>
      sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID })
    );
    const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
    if (!sheet) return { error: `العقد رقم ${contractNo} غير موجود` };
    const newSheetName = `عقد-${value}`;
    const exists = meta.data.sheets.find(s => s.properties.title === newSheetName);
    if (exists) return { error: `رقم العقد ${value} مستخدم بالفعل` };
    await sheetsRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ updateSheetProperties: {
            properties: { sheetId: sheet.properties.sheetId, title: newSheetName },
            fields: "title",
          }}],
        },
      })
    );
    await sheetsRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${newSheetName}!B2`,
        valueInputOption: "RAW",
        requestBody: { values: [[value]] },
      })
    );
    log("INFO", "تعديل رقم عقد", { oldNo: contractNo, newNo: value });
    return { success: true };
  }

  // البحث عن الصف الصحيح بناءً على عنوان عمود A
  const labelMap = {
    "clientName":    "اسم العميل",
    "clientPhone":   "رقم الهاتف",
    "clientAddress": "عنوان العميل",
    "civilId":       "الرقم المدني",
    "contractType":  "نوع العقد",
    "contractValue": "قيمة العقد",
    "contractDate":  "تاريخ التسجيل",
  };
  const label = labelMap[field];
  if (!label) return { error: "حقل غير معروف" };

  // قراءة عمود A لإيجاد الصف المناسب
  const metaRes = await sheetsRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:A15`,
    })
  );
  const colA = (metaRes.data.values || []).map(r => r[0] || "");
  const rowIdx = colA.findIndex(l => l.includes(label));
  if (rowIdx === -1) return { error: `لم يتم العثور على حقل "${label}" في الشيت` };
  const targetCell = `${sheetName}!B${rowIdx + 1}`;

  await sheetsRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: targetCell,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[value]] },
    })
  );

  log("INFO", "تعديل عقد", { contractNo, field, value, cell: targetCell });
  return { success: true };
}

// ─── حذف عقد ─────────────────────────────────────────────────
async function deleteContractSheet(contractNo) {
  const sheetName = `عقد-${contractNo}`;
  const meta = await sheetsRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID })
  );
  const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) return { error: `العقد رقم ${contractNo} غير موجود` };

  await sheetsRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ deleteSheet: { sheetId: sheet.properties.sheetId } }] },
    })
  );

  log("INFO", "حذف عقد", { contractNo });
  return { success: true };
}

// ─── إنشاء صورة فاتورة PNG ────────────────────────────────────
async function generateImage(info) {
  const pct = info.contractValue > 0
    ? Math.round(info.totalPaid / info.contractValue * 100) : 0;
  const remainingColor = info.remaining <= 0 ? "#1D9E75" : "#D85A30";

  const invoiceSerial = getNextInvoiceSerial();

  // تحويل الشعار إلى Base64 إن وُجد
  let logoBase64 = "";
  if (fs.existsSync(LOGO_PATH)) {
    const ext = path.extname(LOGO_PATH).replace(".", "") || "png";
    logoBase64 = `data:image/${ext};base64,` + fs.readFileSync(LOGO_PATH).toString("base64");
  }

  const paymentsRows = info.payments.length > 0
    ? info.payments.map((p, idx) => `
        <tr class="${idx % 2 === 0 ? "row-even" : "row-odd"}">
          <td>${p.no}</td>
          <td>${p.date || "—"}</td>
          <td>${p.method}</td>
          <td>${p.paymentType || "—"}</td>
          <td class="amount">${fmt(p.amount)}</td>
          <td class="amount">${fmt(p.total)}</td>
          <td class="amount ${p.remaining <= 0 ? "paid" : "unpaid"}">${fmt(p.remaining)}</td>
        </tr>`).join("")
    : `<tr><td colspan="7" class="no-data">لا توجد دفعات مسجلة بعد</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>فاتورة رقم ${invoiceSerial}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --primary: #1a6fc4; --primary-light: #3b8fe0;
      --green: #1D9E75; --orange: #D85A30;
      --dark: #1a1a2e; --gray: #64748b;
      --light-bg: #f8fafc; --border: #e2e8f0; --white: #ffffff;
    }
    body { font-family: 'Cairo', 'Segoe UI', Tahoma, sans-serif; background: var(--light-bg); color: var(--dark); padding: 0; margin: 0; }
    .invoice-wrapper { width: 860px; margin: 0 auto; background: var(--white); overflow: hidden; }

    .header { background: linear-gradient(135deg, var(--dark) 0%, #162a4a 100%); color: white; padding: 30px 40px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
    .header-right { display: flex; align-items: center; gap: 18px; }
    .header-logo { width: 68px; height: 68px; border-radius: 12px; object-fit: cover; border: 3px solid rgba(255,255,255,0.15); padding: 4px; }
    .logo-placeholder { width: 68px; height: 68px; border-radius: 12px; background: linear-gradient(135deg, var(--primary), var(--primary-light)); display: flex; align-items: center; justify-content: center; font-size: 26px; }
    .company-name { font-size: 1.35rem; font-weight: 900; line-height: 1.3; }
    .company-sub  { font-size: 0.82rem; color: rgba(255,255,255,0.6); margin-top: 4px; }
    .header-left  { text-align: left; }
    .invoice-badge { background: linear-gradient(135deg, var(--primary), var(--primary-light)); color: white; padding: 10px 20px; border-radius: 10px; font-weight: 700; font-size: 0.95rem; white-space: nowrap; }
    .invoice-date { font-size: 0.78rem; color: rgba(255,255,255,0.55); margin-top: 8px; text-align: left; }

    .status-bar { background: linear-gradient(90deg, var(--primary) 0%, var(--primary-light) 100%); padding: 11px 40px; display: flex; align-items: center; justify-content: space-between; color: white; font-size: 0.88rem; }
    .progress-track { flex: 1; max-width: 260px; background: rgba(255,255,255,0.25); border-radius: 99px; height: 8px; margin: 0 20px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 99px; background: white; width: ${pct}%; }

    .content { padding: 30px 40px; }
    .section-title { font-size: 1rem; font-weight: 700; color: var(--primary); border-right: 4px solid var(--primary); padding-right: 12px; margin-bottom: 18px; }

    .client-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 28px; }
    .field-card { background: var(--light-bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
    .field-label { font-size: 0.72rem; color: var(--gray); margin-bottom: 3px; }
    .field-value { font-size: 0.95rem; font-weight: 600; color: var(--dark); }
    .field-card.highlight { background: #eff6ff; border-color: #bfdbfe; }
    .field-card.highlight .field-value { color: var(--primary); }

    .financial-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 24px; }
    .fin-card { border-radius: 12px; padding: 18px; text-align: center; border: 2px solid transparent; }
    .fin-card.total   { background: #f0f9ff; border-color: #bae6fd; }
    .fin-card.paid    { background: #f0fdf4; border-color: #bbf7d0; }
    .fin-card.remaining-card { background: #fff7ed; border-color: #fed7aa; }
    .fin-card.remaining-card.done { background: #f0fdf4; border-color: #bbf7d0; }
    .fin-label { font-size: 0.78rem; color: var(--gray); margin-bottom: 7px; }
    .fin-amount { font-size: 1.18rem; font-weight: 900; }
    .fin-card.total   .fin-amount { color: var(--dark); }
    .fin-card.paid    .fin-amount { color: var(--green); }
    .fin-card.remaining-card .fin-amount { color: ${remainingColor}; }

    .progress-section { margin-bottom: 28px; }
    .progress-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 9px; }
    .progress-label { font-size: 0.85rem; color: var(--gray); }
    .progress-pct { font-size: 0.95rem; font-weight: 800; color: var(--primary); }
    .bar-bg { background: var(--border); border-radius: 99px; height: 10px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 99px; background: linear-gradient(90deg, var(--primary), var(--primary-light)); width: ${pct}%; }

    .table-wrapper { overflow-x: auto; margin-bottom: 28px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
    thead tr { background: linear-gradient(135deg, var(--dark), #162a4a); color: white; }
    thead th { padding: 10px 8px; text-align: center; font-weight: 700; white-space: nowrap; }
    tbody td { padding: 7px 8px; text-align: center; border-bottom: 1px solid var(--border); }
    .row-even { background: var(--white); }
    .row-odd  { background: #f8fafc; }
    .amount { font-weight: 700; font-size: 0.85rem; }
    .paid   { color: var(--green); }
    .unpaid { color: var(--orange); }
    .no-data { color: var(--gray); padding: 20px; font-style: italic; }

    .footer { background: var(--light-bg); border-top: 1px solid var(--border); padding: 18px 40px; text-align: center; font-size: 0.82rem; color: var(--gray); }
    .footer strong { color: var(--primary); }
    .divider { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
  </style>
</head>
<body>
<div class="invoice-wrapper">

  <div class="header">
    <div class="header-right">
      ${logoBase64
        ? `<img src="${logoBase64}" class="header-logo" alt="شعار الشركة">`
        : `<div class="logo-placeholder">🏗</div>`}
      <div>
        <div class="company-name">${COMPANY_NAME}</div>
        <div class="company-sub">نظام إدارة العقود والمدفوعات</div>
      </div>
    </div>
    <div class="header-left">
      <div class="invoice-badge">🧾 فاتورة رقم: ${invoiceSerial}</div>
      <div class="invoice-date">📅 ${nowKuwait()}</div>
    </div>
  </div>

  <div class="status-bar">
    <span>نسبة السداد</span>
    <div class="progress-track"><div class="progress-fill"></div></div>
    <strong>${pct}%</strong>
  </div>

  <div class="content">

    <div class="section-title">📄 بيانات العقد والعميل</div>
    <div class="client-grid">
      <div class="field-card">
        <div class="field-label">الاسم الكامل</div>
        <div class="field-value">${info.clientName || "—"}</div>
      </div>
      <div class="field-card highlight">
        <div class="field-label">رقم العقد</div>
        <div class="field-value">${info.contractNo}</div>
      </div>
      <div class="field-card">
        <div class="field-label">العنوان</div>
        <div class="field-value">${info.clientAddress || "—"}</div>
      </div>
      <div class="field-card">
        <div class="field-label">رقم الهاتف</div>
        <div class="field-value">${info.clientPhone || "—"}</div>
      </div>
      <div class="field-card">
        <div class="field-label">نوع العقد</div>
        <div class="field-value">${info.contractType || "—"}</div>
      </div>
      <div class="field-card">
        <div class="field-label">تاريخ التسجيل</div>
        <div class="field-value">${info.regDate || "—"}</div>
      </div>
    </div>

    <hr class="divider">

    <div class="section-title">💰 الملخص المالي</div>
    <div class="financial-grid">
      <div class="fin-card total">
        <div class="fin-label">قيمة العقد الإجمالية</div>
        <div class="fin-amount">${fmt(info.contractValue)}</div>
      </div>
      <div class="fin-card paid">
        <div class="fin-label">إجمالي المدفوع</div>
        <div class="fin-amount">${fmt(info.totalPaid)}</div>
      </div>
      <div class="fin-card remaining-card ${info.remaining <= 0 ? "done" : ""}">
        <div class="fin-label">المبلغ المتبقي</div>
        <div class="fin-amount">${fmt(info.remaining)}</div>
      </div>
    </div>

    <div class="progress-section">
      <div class="progress-header">
        <span class="progress-label">نسبة الإنجاز المالي</span>
        <span class="progress-pct">${pct}%</span>
      </div>
      <div class="bar-bg"><div class="bar-fill"></div></div>
    </div>

    <hr class="divider">

    <div class="section-title">📋 سجل الدفعات (${info.paymentCount})</div>
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>التاريخ والوقت</th>
            <th>طريقة الدفع</th>
            <th>نوع الدفعة</th>
            <th>قيمة الدفعة</th>
            <th>مجموع المدفوع</th>
            <th>المتبقي</th>
          </tr>
        </thead>
        <tbody>
          ${paymentsRows}
        </tbody>
      </table>
    </div>

  </div>

  <div class="footer">
    <strong>${COMPANY_NAME}</strong> &nbsp;•&nbsp;
    شكراً لثقتكم بنا — الله يبارك لكم في منازلكم 🏡
  </div>

</div>
</body>
</html>`;

  const imagePath = path.join(__dirname, `invoice-${invoiceSerial}.png`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 860, height: 2000, deviceScaleFactor: 2 });
    // networkidle2 بدلاً من networkidle0 — يتجنب الانتظار الطويل إذا كان Google Fonts بطيئاً
    await page.setContent(html, { waitUntil: "networkidle2", timeout: 15000 });
    const element = await page.$(".invoice-wrapper");
    if (element) {
      await element.screenshot({ path: imagePath });
    } else {
      await page.screenshot({ path: imagePath, fullPage: true });
    }
  } finally {
    await browser.close();
  }

  return imagePath;
}

// ─── إحصائيات المناطق ─────────────────────────────────────────
async function getAreaStats() {
  const sheetNames = await getAllContractSheets();
  const areaMap = {}, typeMap = {};
  let totalValue = 0, totalPaid = 0;

  // تحميل موازي — أسرع بكثير من التسلسلي
  const infos = await Promise.all(
    sheetNames.map(name => getContractInfo(name.replace("عقد-", "")))
  );

  for (const info of infos) {
    if (!info) continue;
    const area = info.clientAddress?.split("،")[0]?.trim() || "غير محدد";
    areaMap[area] = (areaMap[area] || 0) + 1;
    const type = info.contractType || "غير محدد";
    typeMap[type] = (typeMap[type] || 0) + 1;
    totalValue += info.contractValue;
    totalPaid  += info.totalPaid;
  }

  return {
    areaMap, typeMap,
    total: sheetNames.length,
    totalValue, totalPaid,
    totalRemaining: totalValue - totalPaid,
  };
}

// ─── تقرير مالي شامل (/report) ───────────────────────────────
async function getFullReport() {
  const sheetNames = await getAllContractSheets();
  const infos = await Promise.all(
    sheetNames.map(name => getContractInfo(name.replace("عقد-", "")))
  );
  const valid = infos.filter(Boolean);

  const totalValue     = valid.reduce((s, i) => s + i.contractValue, 0);
  const totalPaid      = valid.reduce((s, i) => s + i.totalPaid, 0);
  const totalRemaining = totalValue - totalPaid;
  const done           = valid.filter(i => i.remaining <= 0);
  const active         = valid.filter(i => i.remaining > 0 && i.paymentCount > 0);
  const noPay          = valid.filter(i => i.paymentCount === 0);
  const collectionPct  = totalValue > 0 ? Math.round(totalPaid / totalValue * 100) : 0;

  return {
    total: valid.length, totalValue, totalPaid, totalRemaining,
    collectionPct,
    done: done.length, active: active.length, noPay: noPay.length,
    contracts: valid,
  };
}

// ─── حفظ صورة العقد (file_id) في الشيت ──────────────────────
async function saveContractPhoto(contractNo, fileId) {
  const sheetName = `عقد-${contractNo}`;
  if (!(await sheetExists(sheetName))) return { error: `العقد رقم ${contractNo} غير موجود` };

  const metaRes = await sheetsRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:B15`,
    })
  );
  const rows = metaRes.data.values || [];
  const colA = rows.map(r => r[0] || "");
  const existingIdx = colA.findIndex(l => l.includes("صورة العقد"));

  if (existingIdx !== -1) {
    await sheetsRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!B${existingIdx + 1}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[fileId]] },
      })
    );
  } else {
    const emptyIdx = colA.findIndex((l, i) => i >= 5 && l === "");
    const insertRow = emptyIdx !== -1 ? emptyIdx + 1 : colA.length + 1;
    await sheetsRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A${insertRow}:B${insertRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["صورة العقد", fileId]] },
      })
    );
  }
  log("INFO", "حفظ صورة عقد", { contractNo });
  return { success: true };
}

// ─── جلب file_id صورة العقد من الشيت ────────────────────────
async function getContractPhoto(contractNo) {
  const sheetName = `عقد-${contractNo}`;
  if (!(await sheetExists(sheetName))) return null;
  const res = await sheetsRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:B15`,
    })
  );
  const rows = res.data.values || [];
  const row = rows.find(r => (r[0] || "").includes("صورة العقد"));
  return row?.[1] || null;
}

// ─────────────────────────────────────────────────────────────
//  معالجة الرسائل
// ─────────────────────────────────────────────────────────────
// ─── polling_error handler — يمنع تعطّل البوت عند انقطاع الشبكة ───────────
bot.on("polling_error", (err) => {
  log("ERROR", "خطأ في الاستطلاع (polling)", { code: err.code, message: err.message });
});

bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  const text   = msg.text?.trim();

  if (chatId !== String(YOUR_CHAT_ID)) {
    bot.sendMessage(chatId, "⛔ غير مصرح لك باستخدام هذا البوت.");
    log("WARN", "وصول غير مصرح", { chatId });
    return;
  }

  if (!text) return;

  // ── FIX: معالجة /cancel قبل حذف الجلسة ──────────────────────────────────
  if (text === "/cancel") {
    if (sessions[chatId]) {
      delete sessions[chatId];
      bot.sendMessage(chatId, "❌ تم إلغاء العملية الحالية.\n\nاكتب /help لعرض الأوامر.");
    } else {
      bot.sendMessage(chatId, "لا توجد عملية جارية لإلغائها.");
    }
    return;
  }

  // إذا تم استلام أي أمر آخر يبدأ بـ '/' نعيد تعيين الجلسة
  if (text.startsWith("/")) {
    delete sessions[chatId];
  }

  // ── /start & /help ────────────────────────────────────────
  if (text === "/start" || text === "/help") {
    bot.sendMessage(chatId,
      `مرحباً 👋\n\n*الأوامر المتاحة:*\n\n` +
      `📋 /new — عقد جديد\n` +
      `💰 /pay — تسجيل دفعة\n` +
      `🔍 /query — استعلام عن عقد\n` +
      `📱 /findphone — البحث عن عقد برقم الهاتف\n` +
      `📋 /list — قائمة جميع العقود\n` +
      `✏️ /edit — تعديل بيانات عقد\n` +
      `🗑 /delete — حذف عقد\n` +
      `🖼️ /pdf — فاتورة صورة (PNG عالية الجودة)\n` +
      `📎 /attach — إرفاق صورة وثيقة العقد\n` +
      `🖼️ /photo — عرض صورة وثيقة العقد\n` +
      `📊 /stats — إحصائيات المناطق والأنواع\n` +
      `📈 /report — تقرير مالي شامل\n` +
      `❌ /cancel — إلغاء العملية الحالية\n`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // /cancel handled above (before session deletion) — skip here

  // ── /new ──────────────────────────────────────────────────
  if (text === "/new") {
    sessions[chatId] = { step: "new_contract", data: {} };
    bot.sendMessage(chatId, "📋 *تسجيل عقد جديد*\n\nأرسل رقم العقد (أرقام وأحرف فقط):", { parse_mode: "Markdown" });
    return;
  }

  // ── /pay ──────────────────────────────────────────────────
  if (text === "/pay") {
    sessions[chatId] = { step: "pay_contract", data: {} };
    bot.sendMessage(chatId, "💰 *تسجيل دفعة*\n\nأرسل رقم العقد:", { parse_mode: "Markdown" });
    return;
  }

  // ── /query ────────────────────────────────────────────────
  if (text === "/query") {
    sessions[chatId] = { step: "query", data: {} };
    bot.sendMessage(chatId, "🔍 أرسل رقم العقد للاستعلام:");
    return;
  }

  // ── /pdf ──────────────────────────────────────────────────
  if (text === "/pdf") {
    sessions[chatId] = { step: "pdf", data: {} };
    bot.sendMessage(chatId, "🖼️ أرسل رقم العقد لإنشاء صورة الفاتورة:");
    return;
  }

  // ── /findphone ────────────────────────────────────────────
  if (text === "/findphone") {
    sessions[chatId] = { step: "findphone", data: {} };
    bot.sendMessage(chatId, "📱 أرسل رقم هاتف العميل للبحث عن عقوده:");
    return;
  }

  // ── /attach ───────────────────────────────────────────────
  if (text === "/attach") {
    sessions[chatId] = { step: "attach_contract", data: {} };
    bot.sendMessage(chatId, "📎 *إرفاق صورة وثيقة العقد*\n\nأرسل رقم العقد:", { parse_mode: "Markdown" });
    return;
  }

  // ── /photo ────────────────────────────────────────────────
  if (text === "/photo") {
    sessions[chatId] = { step: "photo_view", data: {} };
    bot.sendMessage(chatId, "🖼️ أرسل رقم العقد لعرض صورة وثيقته:");
    return;
  }

  // ── /edit ─────────────────────────────────────────────────
  if (text === "/edit") {
    sessions[chatId] = { step: "edit_start", data: {} };
    bot.sendMessage(chatId, "✏️ *تعديل بيانات عقد*\n\nأرسل رقم العقد:", { parse_mode: "Markdown" });
    return;
  }

  // ── /delete ───────────────────────────────────────────────
  if (text === "/delete") {
    sessions[chatId] = { step: "delete_confirm", data: {} };
    bot.sendMessage(chatId, "🗑 أرسل رقم العقد الذي تريد حذفه:");
    return;
  }

  // ── /stats ────────────────────────────────────────────────
  if (text === "/stats") {
    bot.sendMessage(chatId, "⏳ جاري تحليل البيانات...");
    try {
      const { areaMap, typeMap, total, totalValue, totalPaid, totalRemaining } = await getAreaStats();

      let out = `📊 *إحصائيات العقود*\n\n`;
      out += `📁 إجمالي العقود: *${total}*\n`;
      out += `💵 إجمالي القيمة: *${fmt(totalValue)}*\n`;
      out += `✅ المحصّل: *${fmt(totalPaid)}*\n`;
      out += `⏳ المتبقي: *${fmt(totalRemaining)}*\n\n`;
      out += `🗺 *حسب المنطقة:*\n`;
      Object.entries(areaMap).sort((a, b) => b[1] - a[1]).forEach(([area, count]) => {
        out += `• ${area}: ${count} عقد\n`;
      });
      out += `\n🏗 *حسب نوع العقد:*\n`;
      Object.entries(typeMap).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
        out += `• ${type}: ${count} عقد\n`;
      });

      await sendLong(chatId, out, { parse_mode: "Markdown" });
    } catch (e) {
      log("ERROR", "/stats فشل", { error: e.message });
      bot.sendMessage(chatId, `⚠️ خطأ: ${e.message}`);
    }
    return;
  }

  // ── /report ───────────────────────────────────────────────
  if (text === "/report") {
    bot.sendMessage(chatId, "⏳ جاري إعداد التقرير المالي...");
    try {
      const r = await getFullReport();
      const pct = r.collectionPct;
      const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));

      let out = `📈 *التقرير المالي الشامل*\n\n`;
      out += `📁 إجمالي العقود: *${r.total}*\n`;
      out += `   ✅ مكتملة: ${r.done} | 🔄 نشطة: ${r.active} | ⛔ بدون دفعات: ${r.noPay}\n\n`;
      out += `💰 إجمالي قيمة العقود: *${fmt(r.totalValue)}*\n`;
      out += `✅ إجمالي المحصّل: *${fmt(r.totalPaid)}*\n`;
      out += `⏳ إجمالي المتبقي: *${fmt(r.totalRemaining)}*\n\n`;
      out += `📊 نسبة التحصيل الكلي:\n`;
      out += `\`${bar}\` *${pct}%*\n\n`;

      if (r.noPay > 0) {
        const noPayList = r.contracts.filter(i => i.paymentCount === 0);
        out += `⛔ *عقود بدون أي دفعة:*\n`;
        noPayList.forEach(i => {
          out += `• عقد ${i.contractNo} — ${i.clientName} — ${fmt(i.contractValue)}\n`;
        });
      }

      await sendLong(chatId, out, { parse_mode: "Markdown" });
    } catch (e) {
      log("ERROR", "/report فشل", { error: e.message });
      bot.sendMessage(chatId, `⚠️ خطأ: ${e.message}`);
    }
    return;
  }

  // ── /list ─────────────────────────────────────────────────
  if (text === "/list") {
    bot.sendMessage(chatId, "⏳ جاري تحميل قائمة العقود...");
    try {
      const sheetNames = await getAllContractSheets();
      if (!sheetNames.length) {
        bot.sendMessage(chatId, "📭 لا توجد عقود مسجلة بعد.");
        return;
      }
      const infos = await Promise.all(
        sheetNames.map(name => getContractInfo(name.replace("عقد-", "")))
      );
      const validInfos = infos.filter(Boolean);
      let out = `📋 *قائمة العقود (${validInfos.length})*\n\n`; // FIX: عدد صحيح
      validInfos.forEach(i => {
        const p = i.contractValue > 0 ? Math.round(i.totalPaid / i.contractValue * 100) : 0;
        const status = i.remaining <= 0 ? "✅" : i.paymentCount === 0 ? "⛔" : "🔄";
        out += `${status} *عقد ${escapeMd(i.contractNo)}* — ${escapeMd(i.clientName)}\n`;
        out += `   ${fmt(i.contractValue)} | مدفوع ${p}% | متبقي ${fmt(i.remaining)}\n`;
      });
      await sendLong(chatId, out, { parse_mode: "Markdown" });
    } catch (e) {
      log("ERROR", "/list فشل", { error: e.message });
      bot.sendMessage(chatId, `⚠️ خطأ: ${e.message}`);
    }
    return;
  }

  // ────────────────────────────────────────────────────────────
  //  معالجة الخطوات
  // ────────────────────────────────────────────────────────────
  const session = sessions[chatId];
  if (!session) {
    bot.sendMessage(chatId, "اكتب /help لعرض الأوامر المتاحة.");
    return;
  }

  // ── عقد جديد ──────────────────────────────────────────────
  if (session.step === "new_contract") {
    const d = session.data;

    if (!d.contractNo) {
      // تحقق من صيغة رقم العقد
      if (!/^[A-Za-z0-9\-]+$/.test(text)) {
        bot.sendMessage(chatId, "⚠️ رقم العقد يجب أن يحتوي على أرقام وحروف إنجليزية وشرطة فقط:\nمثال: 001 أو C-2025-01");
        return;
      }
      d.contractNo = text;
      bot.sendMessage(chatId, "اسم العميل:");
      return;
    }
    if (!d.clientName) {
      d.clientName = text;
      bot.sendMessage(chatId, "رقم هاتف العميل:");
      return;
    }
    if (!d.clientPhone) {
      // تحقق من رقم الهاتف
      if (!/^[+\d\s\-]{7,15}$/.test(text)) {
        bot.sendMessage(chatId, "⚠️ أدخل رقم هاتف صحيح (7-15 رقم):");
        return;
      }
      d.clientPhone = text;
      bot.sendMessage(chatId, "عنوان العميل (المنطقة أولاً، مثال: السالمية، بلوك 5):");
      return;
    }
    if (!d.clientAddress) {
      d.clientAddress = text;
      bot.sendMessage(chatId, "الرقم المدني للعميل:");
      return;
    }
    if (!d.civilId) {
      d.civilId = text;
      bot.sendMessage(chatId,
        "نوع العقد:\n1️⃣ سيراميك\n2️⃣ ديكور\n3️⃣ تصميم داخلي\n4️⃣ مقاولات عامة\n\nأرسل الرقم:"
      );
      return;
    }
    if (!d.contractType) {
      if (!CONTRACT_TYPES[text]) { bot.sendMessage(chatId, "⚠️ أرسل رقماً من 1 إلى 4:"); return; }
      d.contractType = CONTRACT_TYPES[text];
      bot.sendMessage(chatId, "قيمة العقد (بالدينار الكويتي):");
      return;
    }
    if (!d.contractValue) {
      const val = parseFloat(text);
      if (isNaN(val) || val <= 0) { bot.sendMessage(chatId, "⚠️ أدخل رقماً صحيحاً أكبر من صفر:"); return; }
      d.contractValue = val;
      bot.sendMessage(chatId, "⏳ جاري التسجيل...");
      const dateTime = nowKuwait();
      try {
        const result = await createContractSheet(d, dateTime);
        delete sessions[chatId];
        if (result.error) { bot.sendMessage(chatId, `⚠️ ${result.error}`); return; }
        bot.sendMessage(chatId,
          `✅ *تم تسجيل العقد بنجاح*\n\n` +
          `1️⃣ رقم العقد: ${escapeMd(d.contractNo)}\n2️⃣ اسم العميل: ${escapeMd(d.clientName)}\n` +
          `3️⃣ رقم الهاتف: ${escapeMd(d.clientPhone)}\n4️⃣ التاريخ: ${dateTime}\n` +
          `5️⃣ العنوان: ${escapeMd(d.clientAddress)}\n6️⃣ الرقم المدني: ${escapeMd(d.civilId)}\n` +
          `7️⃣ نوع العقد: ${d.contractType}\n8️⃣ قيمة العقد: ${fmt(d.contractValue)}`,
          { parse_mode: "Markdown" }
        );
      } catch (e) {
        delete sessions[chatId];
        log("ERROR", "فشل إنشاء عقد", { error: e.message });
        bot.sendMessage(chatId, `⚠️ خطأ في التسجيل: ${e.message}`);
      }
      return;
    }
  }

  // ── تسجيل دفعة ────────────────────────────────────────────
  if (session.step === "pay_contract") {
    const d = session.data;
    if (!d.contractNo) {
      // UX FIX: تحقق مبكر من وجود العقد قبل المتابعة — يوفر 3 خطوات على المستخدم
      bot.sendMessage(chatId, "⏳ جاري التحقق من العقد...");
      const contractCheck = await getContractInfo(text);
      if (!contractCheck) {
        delete sessions[chatId];
        bot.sendMessage(chatId, `⚠️ العقد رقم ${text} غير موجود.\nاستخدم /list لعرض العقود أو /new لإنشاء عقد جديد.`);
        return;
      }
      d.contractNo = text;
      bot.sendMessage(chatId, `✅ العقد: ${contractCheck.clientName}\nالمتبقي: ${fmt(contractCheck.remaining)}\n\nطريقة الدفع:\n1️⃣ تحويل بنكي\n2️⃣ نقد\n3️⃣ شيك\n\nأرسل الرقم:`);
      return;
    }
    if (!d.method) {
      const methods = { "1": "تحويل بنكي", "2": "نقد", "3": "شيك" };
      if (!methods[text]) { bot.sendMessage(chatId, "⚠️ أرسل 1 أو 2 أو 3 فقط:"); return; }
      d.method = methods[text];
      bot.sendMessage(chatId,
        "نوع الدفعة:\n1️⃣ مقدم بدء الأعمال\n2️⃣ دفعة أعمال سيراميك\n3️⃣ دفعة أعمال ديكور\n4️⃣ دفعة أعمال مقاولات\n5️⃣ دفعة نهاية الأعمال\n\nأرسل الرقم:");
      return;
    }
    if (!d.paymentType) {
      const types = {
        "1": "مقدم بدء الأعمال", "2": "دفعة أعمال سيراميك",
        "3": "دفعة أعمال ديكور", "4": "دفعة أعمال مقاولات",
        "5": "دفعة نهاية الأعمال",
      };
      if (!types[text]) { bot.sendMessage(chatId, "⚠️ أرسل رقم بين 1 و5 فقط:"); return; }
      d.paymentType = types[text];
      bot.sendMessage(chatId, "قيمة الدفعة (بالدينار الكويتي):");
      return;
    }
    if (!d.amount) {
      const val = parseFloat(text);
      if (isNaN(val) || val <= 0) { bot.sendMessage(chatId, "⚠️ أدخل رقماً صحيحاً أكبر من صفر:"); return; }
      d.amount = val;
      bot.sendMessage(chatId, "⏳ جاري التسجيل...");
      const dateTime = nowKuwait();
      try {
        const result = await addPayment(d.contractNo, d.amount, d.method, d.paymentType, dateTime);
        delete sessions[chatId];
        if (result.error) { bot.sendMessage(chatId, `⚠️ ${result.error}`); return; }
        bot.sendMessage(chatId,
          `السلام عليكم تم تسجيل الدفعة رقم (${result.paymentNo})\n\n` +
          `1️⃣ رقم العقد: ${result.contractNo}\n2️⃣ اسم العميل: ${result.clientName}\n` +
          `3️⃣ التاريخ والوقت: ${dateTime}\n4️⃣ طريقة الدفع: ${d.method}\n` +
          `5️⃣ نوع الدفعة: ${d.paymentType}\n6️⃣ قيمة الدفعة: ${fmt(result.amount)}\n` +
          `7️⃣ مجموع المدفوع: ${fmt(result.totalPaid)}\n8️⃣ المتبقي من قيمة العقد: ${fmt(result.remaining)}\n\n` +
          (result.remaining <= 0 ? "🎉 تم سداد العقد بالكامل! الله يبارك لك 🏡" : "الله يبارك لك في منزلك 🏡")
        );
      } catch (e) {
        delete sessions[chatId];
        log("ERROR", "فشل تسجيل دفعة", { error: e.message });
        bot.sendMessage(chatId, `⚠️ خطأ في التسجيل: ${e.message}`);
      }
      return;
    }
  }

  // ── استعلام ───────────────────────────────────────────────
  if (session.step === "query") {
    try {
      const info = await getContractInfo(text);
      delete sessions[chatId];
      if (!info) { bot.sendMessage(chatId, `⚠️ لم يتم العثور على العقد رقم ${text}`); return; }
      const pct = info.contractValue > 0 ? Math.round(info.totalPaid / info.contractValue * 100) : 0;
      bot.sendMessage(chatId,
        `🔍 *تقرير العقد رقم ${escapeMd(info.contractNo)}*\n\n` +
        `👤 العميل: ${escapeMd(info.clientName)}\n📞 الهاتف: ${escapeMd(info.clientPhone)}\n` +
        `📍 العنوان: ${escapeMd(info.clientAddress)}\n🏗 نوع العقد: ${info.contractType}\n` +
        `💰 قيمة العقد: ${fmt(info.contractValue)}\n` +
        `✅ إجمالي المدفوع: ${fmt(info.totalPaid)}\n` +
        `⏳ المتبقي: ${fmt(info.remaining)}\n` +
        `📊 عدد الدفعات: ${info.paymentCount}\n` +
        `📈 نسبة السداد: ${pct}%`,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      delete sessions[chatId];
      log("ERROR", "فشل استعلام", { error: e.message });
      bot.sendMessage(chatId, `⚠️ خطأ: ${e.message}`);
    }
    return;
  }

  // ── فاتورة صورة PNG ───────────────────────────────────────
  if (session.step === "pdf") {
    try {
      const info = await getContractInfo(text);
      delete sessions[chatId];
      if (!info) { bot.sendMessage(chatId, `⚠️ لم يتم العثور على العقد رقم ${text}`); return; }
      bot.sendMessage(chatId, "⏳ جاري إنشاء الفاتورة...");
      const filePath = await generateImage(info);
      await bot.sendPhoto(chatId, filePath);
      fs.unlinkSync(filePath);
    } catch (e) {
      delete sessions[chatId];
      log("ERROR", "فشل إنشاء فاتورة", { error: e.message });
      bot.sendMessage(chatId, `⚠️ خطأ في إنشاء الفاتورة: ${e.message}`);
    }
    return;
  }

  // ── /findphone — البحث برقم الهاتف ───────────────────────
  if (session.step === "findphone") {
    delete sessions[chatId];
    bot.sendMessage(chatId, "⏳ جاري البحث في جميع العقود...");
    try {
      const results = await findContractsByPhone(text);
      if (results.length === 0) {
        bot.sendMessage(chatId, `⚠️ لم يتم العثور على أي عقد مرتبط بالرقم: ${text}`);
        return;
      }
      let msg = `📱 *نتائج البحث عن: ${text}*\n\n`;
      msg += `✅ وُجد *${results.length}* عقد:\n\n`;
      results.forEach((r, i) => {
        msg += `${i + 1}. 📋 رقم العقد: *${r.contractNo}*\n`;
        msg += `   👤 العميل: ${r.clientName}\n`;
        msg += `   📞 الهاتف: ${r.storedPhone}\n`;
        if (r.contractType) msg += `   🏗 النوع: ${r.contractType}\n`;
        if (r.contractValue) msg += `   💵 القيمة: ${fmt(r.contractValue)}\n`;
        msg += `\n`;
      });
      await sendLong(chatId, msg, { parse_mode: "Markdown" });
    } catch (e) {
      log("ERROR", "فشل البحث برقم الهاتف", { error: e.message });
      bot.sendMessage(chatId, `⚠️ خطأ في البحث: ${e.message}`);
    }
    return;
  }

  // ── /photo — عرض صورة الوثيقة ────────────────────────────
  if (session.step === "photo_view") {
    try {
      const fileId = await getContractPhoto(text);
      delete sessions[chatId];
      if (!fileId) {
        bot.sendMessage(chatId, `⚠️ لا توجد صورة وثيقة مرفوعة للعقد رقم ${text}`);
        return;
      }
      await bot.sendPhoto(chatId, fileId, { caption: `📎 وثيقة العقد رقم ${text}` });
    } catch (e) {
      delete sessions[chatId];
      log("ERROR", "فشل عرض صورة العقد", { error: e.message });
      bot.sendMessage(chatId, `⚠️ خطأ: ${e.message}`);
    }
    return;
  }

  // ── /attach — الخطوة 1: رقم العقد ───────────────────────
  if (session.step === "attach_contract") {
    try {
      const info = await getContractInfo(text);
      if (!info) { bot.sendMessage(chatId, `⚠️ العقد رقم ${text} غير موجود`); delete sessions[chatId]; return; }
      session.data.contractNo = text;
      session.step = "attach_photo";
      bot.sendMessage(chatId, `📎 *العقد رقم ${text}*\n\nأرسل الآن صورة وثيقة العقد (صورة من الكاميرا أو ملف صورة):`, { parse_mode: "Markdown" });
    } catch (e) {
      delete sessions[chatId];
      bot.sendMessage(chatId, `⚠️ خطأ: ${e.message}`);
    }
    return;
  }

  // ── تعديل العقد — الخطوة 1 ────────────────────────────────
  if (session.step === "edit_start") {
    try {
      const info = await getContractInfo(text);
      if (!info) { bot.sendMessage(chatId, `⚠️ العقد رقم ${text} غير موجود`); delete sessions[chatId]; return; }
      session.data.contractNo = text;
      session.step = "edit_field";
      bot.sendMessage(chatId,
        `✏️ *تعديل العقد ${text}*\n\nاختر الحقل:\n` +
        `1️⃣ اسم العميل\n2️⃣ رقم الهاتف\n3️⃣ العنوان\n4️⃣ الرقم المدني\n` +
        `5️⃣ نوع العقد\n6️⃣ قيمة العقد\n7️⃣ تاريخ العقد\n8️⃣ رقم العقد\n\nأرسل الرقم:`,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      delete sessions[chatId];
      log("ERROR", "فشل تعديل عقد", { error: e.message });
      bot.sendMessage(chatId, `⚠️ خطأ: ${e.message}`);
    }
    return;
  }

  if (session.step === "edit_field") {
    const fieldMap = {
      "1": ["clientName",    "اسم العميل الجديد:"],
      "2": ["clientPhone",   "رقم الهاتف الجديد:"],
      "3": ["clientAddress", "العنوان الجديد:"],
      "4": ["civilId",       "الرقم المدني الجديد:"],
      "5": ["contractType",  `نوع العقد:\n1️⃣ سيراميك\n2️⃣ ديكور\n3️⃣ تصميم داخلي\n4️⃣ مقاولات عامة\n\nأرسل الرقم:`],
      "6": ["contractValue", "قيمة العقد الجديدة (بالدينار الكويتي):"],
      "7": ["contractDate",  "تاريخ العقد الجديد (مثال: 09/06/2026):"],
      "8": ["contractNo",    "رقم العقد الجديد (مثال: 002):"],
    };
    if (!fieldMap[text]) { bot.sendMessage(chatId, "⚠️ أرسل رقماً من 1 إلى 8:"); return; }
    session.data.field = fieldMap[text][0];
    session.step = "edit_value";
    if (text === "5") session.step = "edit_type";
    bot.sendMessage(chatId, fieldMap[text][1]);
    return;
  }

  if (session.step === "edit_type") {
    if (!CONTRACT_TYPES[text]) { bot.sendMessage(chatId, "⚠️ أرسل رقماً من 1 إلى 4:"); return; }
    session.data.value = CONTRACT_TYPES[text];
    session.step = "edit_value_ready";
  }

  if (session.step === "edit_value" || session.step === "edit_value_ready") {
    const value = session.step === "edit_value_ready" ? session.data.value : text;
    const { contractNo, field } = session.data;
    delete sessions[chatId];
    try {
      const result = await updateContractField(contractNo, field, value);
      if (result.error) { bot.sendMessage(chatId, `⚠️ ${result.error}`); return; }
      bot.sendMessage(chatId, `✅ تم تحديث البيانات بنجاح للعقد رقم ${contractNo}`);
    } catch (e) {
      log("ERROR", "فشل تحديث حقل", { error: e.message });
      bot.sendMessage(chatId, `⚠️ خطأ: ${e.message}`);
    }
    return;
  }

  // ── حذف العقد ─────────────────────────────────────────────
  if (session.step === "delete_confirm") {
    session.data.contractNo = text;
    session.step = "delete_execute";
    bot.sendMessage(chatId,
      `⚠️ *تأكيد الحذف*\n\nهل أنت متأكد من حذف العقد رقم *${text}*؟\nسيتم حذف جميع البيانات والدفعات نهائياً.\n\n` +
      `اكتب *نعم* للتأكيد أو /cancel للإلغاء:`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (session.step === "delete_execute") {
    if (text !== "نعم") { delete sessions[chatId]; bot.sendMessage(chatId, "❌ تم إلغاء الحذف."); return; }
    const { contractNo } = session.data;
    delete sessions[chatId];
    bot.sendMessage(chatId, "⏳ جاري الحذف...");
    try {
      const result = await deleteContractSheet(contractNo);
      if (result.error) { bot.sendMessage(chatId, `⚠️ ${result.error}`); return; }
      bot.sendMessage(chatId, `✅ تم حذف العقد رقم ${contractNo} بنجاح.`);
    } catch (e) {
      log("ERROR", "فشل حذف عقد", { error: e.message });
      bot.sendMessage(chatId, `⚠️ خطأ: ${e.message}`);
    }
    return;
  }
});

// ─── معالج استقبال الصور (لأمر /attach) ──────────────────────
bot.on("photo", async (msg) => {
  const chatId = String(msg.chat.id);
  if (chatId !== String(YOUR_CHAT_ID)) return;

  const session = sessions[chatId];
  if (!session || session.step !== "attach_photo") {
    bot.sendMessage(chatId, "⚠️ أرسل /attach أولاً لتحديد رقم العقد قبل إرسال الصورة.");
    return;
  }

  try {
    // أخذ أعلى دقة متاحة
    const photos = msg.photo;
    const bestPhoto = photos[photos.length - 1];
    const fileId = bestPhoto.file_id;
    const { contractNo } = session.data;
    delete sessions[chatId];

    bot.sendMessage(chatId, "⏳ جاري حفظ الصورة...");
    const result = await saveContractPhoto(contractNo, fileId);
    if (result.error) {
      bot.sendMessage(chatId, `⚠️ ${result.error}`);
      return;
    }
    bot.sendMessage(chatId, `✅ تم حفظ صورة وثيقة العقد رقم *${contractNo}* بنجاح!\n\nاستخدم /photo لعرضها في أي وقت.`, { parse_mode: "Markdown" });
  } catch (e) {
    delete sessions[chatId];
    log("ERROR", "فشل حفظ صورة العقد", { error: e.message });
    bot.sendMessage(chatId, `⚠️ خطأ في حفظ الصورة: ${e.message}`);
  }
});

// ─── حماية شاملة من الأعطال ───────────────────────────────────
process.on("uncaughtException",  err => log("ERROR", "خطأ غير متوقع", { error: err.message, stack: err.stack }));
process.on("unhandledRejection", err => log("ERROR", "رفض غير معالج",  { error: err?.message || String(err) }));

log("INFO", `✅ البوت v3.0 يعمل — PID: ${process.pid}`);
