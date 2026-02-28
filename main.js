// main.js
//
// Northwestern CTEC scraper + OpenAI summarizer
//
// Usage:
//   node main.js "COMP_SCI 212"
//
// Setup:
//   npm install playwright openai
//   export OPENAI_API_KEY="your_key_here"

const { chromium } = require("playwright");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

// ======================== CONFIG ========================

const START_URL =
  "https://caesar.ent.northwestern.edu/psp/csnu_6/EMPLOYEE/SA/c/NWCT.NW_CT_PUBLIC_VIEW.GBL";

const PROFILE_DIR = "./pw-profile";
const OUT_DIR = "./data/raw";

// =======================================================

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------------ OpenAI ------------------------

async function summarizeCTEC({ subject, number, term, desc, essayChunk }) {
  if (!process.env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY not set, skipping summary");
    return null;
  }
  if (!essayChunk || essayChunk.trim().length < 50) {
    console.log("essayChunk too small, skipping summary");
    return null;
  }

  console.log("Generating OpenAI summary...");

  const systemPrompt = `
You are summarizing Northwestern University CTEC written comments.

Return ONLY valid JSON matching this schema:

{
  "overall_sentiment": "positive | mixed | negative",
  "workload": "low | medium | high",
  "difficulty": "low | medium | high",
  "teaching_quality": "low | medium | high",
  "common_praise": ["..."],
  "common_complaints": ["..."],
  "tips_to_succeed": ["..."],
  "summary_paragraph": "..."
}

Rules:
- Use only evidence from the provided text.
- If unclear, choose "mixed" or "medium".
- Keep arrays 3–6 items.
`.trim();

  const userPrompt = `
Course: ${subject} ${number}
Evaluation row: ${term} | ${desc}

TEXT (between ESSAY QUESTIONS and DEMOGRAPHICS):
${essayChunk}
`.trim();

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    text: { format: { type: "json_object" } },
  });

  try {
    return JSON.parse(resp.output_text);
  } catch {
    console.log("⚠️ Failed to parse summary JSON");
    return null;
  }
}

// --------------------- Utilities ------------------------

function norm(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function safeFilename(s) {
  return (s || "output").replace(/[^\w.-]+/g, "_").slice(0, 180);
}

function writeJson(outDir, baseName, obj) {
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, safeFilename(baseName) + ".json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

function sectionBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return null;

  const afterStart = start + startMarker.length;
  const end = endMarker ? text.indexOf(endMarker, afterStart) : -1;

  const chunk = end === -1 ? text.slice(afterStart) : text.slice(afterStart, end);
  return chunk.trim();
}

function extractEssayToDemographics(fullText) {
  return (
    sectionBetween(fullText, "ESSAY QUESTIONS", "DEMOGRAPHICS") ||
    sectionBetween(fullText, "ESSAY QUESTIONS", "Creation Date") ||
    sectionBetween(fullText, "ESSAY QUESTIONS", "Download PDF") ||
    sectionBetween(fullText, "ESSAY QUESTIONS", null)
  );
}

function looksLikeTerm(termText) {
  // Examples: "2016 Sprng", "2025 Wintr", "2024 Fall"
  return /^\d{4}\s+(Fall|Wintr|Sprng|Summr)$/i.test(termText);
}

async function waitForFrameWithSelector(page, selector) {
  while (true) {
    for (const f of page.frames()) {
      try {
        const el = await f.$(selector);
        if (el) {
          await el.dispose();
          return f;
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function selectByLabelMatch(frame, selectSelector, matcherFn) {
  await frame.waitForSelector(selectSelector, { state: "visible", timeout: 0 });
  const options = await frame.$$(selectSelector + " option");
  for (const opt of options) {
    const label = norm(await opt.innerText());
    const value = await opt.getAttribute("value");
    if (matcherFn(label)) {
      await frame.selectOption(selectSelector, value);
      return label;
    }
  }
  throw new Error(`No matching option found for selector ${selectSelector}`);
}

// ---------- Login / report gating (SSO-safe) ------------

async function waitForEitherLoginOrReport(page) {
  await page.waitForFunction(() => {
    const t = document.body?.innerText || "";
    const url = location.href.toLowerCase();

    const hasReport =
      t.includes("Student Report for") ||
      t.includes("Responses Received") ||
      t.includes("Course and Teacher Evaluations") ||
      t.includes("ESSAY QUESTIONS");

    const tl = t.toLowerCase();
    const looksLikeLogin =
      tl.includes("netid") ||
      tl.includes("sign in") ||
      tl.includes("duo") ||
      tl.includes("two-factor") ||
      url.includes("shibboleth") ||
      url.includes("login") ||
      url.includes("sso");

    return hasReport || looksLikeLogin;
  }, { timeout: 0 });
}

async function waitForReport(page) {
  while (true) {
    const t = await page.locator("body").innerText().catch(() => "");
    const url = (page.url?.() || "").toLowerCase();

    const hasReport =
      t.includes("Student Report for") ||
      t.includes("Responses Received") ||
      t.includes("Course and Teacher Evaluations") ||
      t.includes("ESSAY QUESTIONS");

    if (hasReport) return;

    const tl = t.toLowerCase();
    const looksLikeLogin =
      tl.includes("netid") ||
      tl.includes("sign in") ||
      tl.includes("duo") ||
      tl.includes("two-factor") ||
      url.includes("shibboleth") ||
      url.includes("login") ||
      url.includes("sso");

    if (looksLikeLogin) {
      console.log("\n⚠️ Login screen detected in the evaluation tab.");
      console.log("Complete NetID + Duo in the browser window. I’ll resume automatically.\n");
    } else {
      console.log("\n⏳ Waiting for evaluation report to finish loading...\n");
    }

    await page.waitForTimeout(1000);
  }
}

// ------------------------- Main -------------------------

function parseCourseArg(argv) {
  const raw = argv.slice(2).join(" ").trim();
  if (!raw) throw new Error('Missing input. Example: node main.js "COMP_SCI 212"');

  const match = raw.match(/^([A-Z_]+)\s+([0-9]+(?:-[A-Z0-9]+)?)$/);
  if (!match) throw new Error(`Invalid input: "${raw}". Use "COMP_SCI 212" or "COMP_SCI 212-1".`);

  const subject = match[1];
  let number = match[2];
  if (!number.includes("-")) number = `${number}-0`;

  return { subject, number, raw };
}

async function main() {
  const { subject, number } = parseCourseArg(process.argv);
  console.log(`Input normalized -> Subject: ${subject}, Number: ${number}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: 50,
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });

    console.log(
      "If you see Northwestern login, complete NetID + Duo in the browser.\n" +
        "This will continue automatically once the Search CTECs dropdowns exist."
    );

    const CAREER_SEL = "#NW_CT_PB_SRCH_ACAD_CAREER";
    const SUBJECT_SEL = "#NW_CT_PB_SRCH_SUBJECT";

    const frame = await waitForFrameWithSelector(page, CAREER_SEL);
    console.log("Found Search CTECs frame ✅");

    // Academic career
    const careerChosen = await selectByLabelMatch(
      frame,
      CAREER_SEL,
      (label) => label.toLowerCase() === "undergraduate"
    );
    console.log(`Set Academic Career = ${careerChosen}`);

    // Wait for subject options to populate
    await frame.waitForFunction(
      (sel) => {
        const s = document.querySelector(sel);
        return s && s.options && s.options.length > 1;
      },
      SUBJECT_SEL,
      { timeout: 0 }
    );

    // Select subject
    const subjChosen = await selectByLabelMatch(frame, SUBJECT_SEL, (label) => {
      return label.startsWith(subject + " ");
    });
    console.log(`Set Academic Subject = ${subjChosen}`);

    // Search
    await frame.click('input[value="Search"]');
    await frame.waitForSelector('a:has-text("Get List of CTECs")', { timeout: 0 });

    // Find course row
    const courseLinks = await frame.$$('a:has-text("Get List of CTECs")');
    console.log(`Found ${courseLinks.length} course rows.`);

    let targetLink = null;
    let targetRowText = null;

    for (const link of courseLinks) {
      const rowText = norm(await link.evaluate((a) => a.closest("tr")?.innerText || ""));
      if (rowText.startsWith(number + ":")) {
        targetLink = link;
        targetRowText = rowText;
        break;
      }
    }

    if (!targetLink) throw new Error(`Could not find course ${number}`);

    console.log("\nMatched course:");
    console.log(targetRowText);

    // Open eval list
    await targetLink.click();
    await frame.waitForSelector('a:has-text("View Evaluation")', { timeout: 0 });

    // ✅ FIX: choose the first REAL evaluation row by checking term cell text
    const evalLinks = await frame.$$('a:has-text("View Evaluation")');

    let realEvalLink = null;
    let realRowTerm = null;
    let realRowDesc = null;

    for (const link of evalLinks) {
      const rowHandle = await link.evaluateHandle((a) => a.closest("tr"));
      const row = rowHandle.asElement();
      if (!row) continue;

      const cells = await row.$$("td");
      if (cells.length < 2) continue;

      const termText = norm(await cells[0].innerText());
      const descText = norm(await cells[1].innerText());

      if (!looksLikeTerm(termText)) continue;

      realEvalLink = link;
      realRowTerm = termText;
      realRowDesc = descText;
      break;
    }

    if (!realEvalLink) throw new Error("Could not find a real evaluation row to open.");

    console.log(`\nOpening evaluation for: ${realRowTerm} | ${realRowDesc}`);

    // Popup-safe open
    const popupPromise = page.waitForEvent("popup").catch(() => null);
    await realEvalLink.click();

    let evalPage = await popupPromise;
    if (!evalPage) evalPage = page;

    await evalPage.waitForLoadState("domcontentloaded");

    await waitForEitherLoginOrReport(evalPage);
    await waitForReport(evalPage);

    const fullText = await evalPage.locator("body").innerText();

    const essayChunk = extractEssayToDemographics(fullText);
    if (!essayChunk) console.log("⚠️ Could not find ESSAY QUESTIONS chunk (still saving fullText length info)");

    // Summarize via OpenAI
    const summary = await summarizeCTEC({
      subject,
      number,
      term: realRowTerm,
      desc: realRowDesc,
      essayChunk: essayChunk || "",
    });

    const payload = {
      scrapedAt: new Date().toISOString(),
      courseInput: { subject, number },
      evaluationRow: { term: realRowTerm, desc: realRowDesc },
      essayChunk,
      summary,
    };

    const outPath = writeJson(OUT_DIR, `${subject}_${number}_${realRowTerm}`, payload);
    console.log("Saved to:", outPath);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});