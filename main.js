// print_course_row.js
//
// End-to-end CTEC extractor (single evaluation for now):
// 1) Open CAESAR "Search CTECs"
// 2) Select Academic Career = Undergraduate
// 3) Select Academic Subject (e.g., COMP_SCI)
// 4) Search, then find your specific course row (e.g., 212-0)
// 5) Click "Get List of CTECs"
// 6) Find the first REAL evaluation row (skip table header / controls)
// 7) Open the "View Evaluation" report (popup-safe)
// 8) WAIT through any extra NetID/Duo login screens
// 9) Store EVERYTHING between "ESSAY QUESTIONS" and "DEMOGRAPHICS" into JSON
//
// Usage: node print_course_row.js "COMP_SCI 212"

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const START_URL =
  "https://caesar.ent.northwestern.edu/psp/csnu_6/EMPLOYEE/SA/c/NWCT.NW_CT_PUBLIC_VIEW.GBL";

const DEBUG_LIST_EVAL_ROWS = false;

function parseCourseArg(argv) {
  const raw = argv.slice(2).join(" ").trim();
  if (!raw)
    throw new Error('Missing input. Example: node print_course_row.js "COMP_SCI 212"');

  const match = raw.match(/^([A-Z_]+)\s+([0-9]+(?:-[A-Z0-9]+)?)$/);
  if (!match)
    throw new Error(`Invalid input: "${raw}". Use "COMP_SCI 212" or "COMP_SCI 212-1".`);

  const subject = match[1];
  let number = match[2];

  if (!number.includes("-")) number = `${number}-0`;

  return { subject, number, raw };
}

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

function looksLikeTerm(termText) {
  return /^\d{4}\s+(Fall|Wintr|Sprng|Summr)$/i.test(termText);
}

function sectionBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return null;

  const afterStart = start + startMarker.length;
  const end = endMarker ? text.indexOf(endMarker, afterStart) : -1;

  const chunk = end === -1 ? text.slice(afterStart) : text.slice(afterStart, end);
  return chunk.trim();
}

// Store everything between ESSAY QUESTIONS and DEMOGRAPHICS (fallbacks included)
function extractEssayToDemographics(fullText) {
  return (
    sectionBetween(fullText, "ESSAY QUESTIONS", "DEMOGRAPHICS") ||
    sectionBetween(fullText, "ESSAY QUESTIONS", "Creation Date") ||
    sectionBetween(fullText, "ESSAY QUESTIONS", "Download PDF") ||
    sectionBetween(fullText, "ESSAY QUESTIONS", null)
  );
}

/**
 * Sometimes, when you click "View Evaluation", you get an extra NetID/Duo/SSO
 * login interstitial. If we parse immediately, fields become null / wrong.
 *
 * These helpers detect that and PAUSE until the report content is actually loaded.
 */
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

async function main() {
  const { subject, number } = parseCourseArg(process.argv);
  console.log(`Input normalized -> Subject: ${subject}, Number: ${number}`);

  const context = await chromium.launchPersistentContext("./pw-profile", {
    headless: false,
    slowMo: 50,
  });

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

  // Wait for subject options
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

  if (!targetLink) {
    console.error(`Could not find course ${number}`);
    await context.close();
    return;
  }

  console.log("\nMatched course:");
  console.log(targetRowText);

  // Open eval list
  await targetLink.click();
  await frame.waitForSelector('a:has-text("View Evaluation")', { timeout: 0 });

  const evalLinks = await frame.$$('a:has-text("View Evaluation")');

  // Pick first real evaluation row
  let realEvalLink = null;
  let realRowTerm = null;
  let realRowDesc = null;

  if (DEBUG_LIST_EVAL_ROWS) console.log("\nParsed reports:\n");

  for (const link of evalLinks) {
    const rowHandle = await link.evaluateHandle((a) => a.closest("tr"));
    const row = rowHandle.asElement();
    if (!row) continue;

    const cells = await row.$$("td");
    if (cells.length < 2) continue;

    const termText = norm(await cells[0].innerText());
    const descText = norm(await cells[1].innerText());

    if (!looksLikeTerm(termText)) continue;

    if (DEBUG_LIST_EVAL_ROWS) {
      console.log(`- ${termText} | ${descText}`);
    }

    if (!realEvalLink) {
      realEvalLink = link;
      realRowTerm = termText;
      realRowDesc = descText;
    }
  }

  if (!realEvalLink) throw new Error("Could not find a real evaluation row to open.");

  console.log(`\nOpening evaluation for: ${realRowTerm} | ${realRowDesc}`);

  // Popup-safe open
  const popupPromise = page.waitForEvent("popup").catch(() => null);
  await realEvalLink.click();

  let evalPage = await popupPromise;
  if (!evalPage) {
    evalPage = page;
    await evalPage.waitForLoadState("domcontentloaded");
  } else {
    await evalPage.waitForLoadState("domcontentloaded");
  }

  // Handle occasional extra SSO / login interstitials here
  await waitForEitherLoginOrReport(evalPage);
  await waitForReport(evalPage);

  // Pull full page text AFTER report is confirmed loaded
  const text = await evalPage.locator("body").innerText();

  // Extract everything between ESSAY QUESTIONS and DEMOGRAPHICS
  const essayChunk = extractEssayToDemographics(text);

  if (!essayChunk) {
    console.log("\n❌Could not find ESSAY QUESTIONS section on this report.");
  } else {
    console.log(`\n Extracted ESSAY QUESTIONS → DEMOGRAPHICS chunk (${essayChunk.length} chars).`);
  }

  // Save to JSON (fast + small enough)
  const payload = {
    scrapedAt: new Date().toISOString(),
    courseInput: { subject, number },
    evaluationRow: { term: realRowTerm, desc: realRowDesc },
    essayChunk, // EVERYTHING between ESSAY QUESTIONS and DEMOGRAPHICS
  };

  const outPath = writeJson("./data/raw", `${subject}_${number}_${realRowTerm}`, payload);
  console.log("Saved to:", outPath);

  await context.close();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});