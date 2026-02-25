// print_course_row.js
// Open CAESAR -> wait for Search CTECs dropdowns -> select Undergraduate + subject -> search
// -> select course -> open evaluation list -> open first real evaluation -> extract key stats
//
// Usage: node print_course_row.js "COMP_SCI 212"

const { chromium } = require("playwright");

const START_URL =
  "https://caesar.ent.northwestern.edu/psp/csnu_6/EMPLOYEE/SA/c/NWCT.NW_CT_PUBLIC_VIEW.GBL";

// set true if you want to print every evaluation row in the list:
const DEBUG_LIST_EVAL_ROWS = false;

function parseCourseArg(argv) {
  const raw = argv.slice(2).join(" ").trim();
  if (!raw) throw new Error('Missing input. Example: node print_course_row.js "COMP_SCI 212"');

  const match = raw.match(/^([A-Z_]+)\s+([0-9]+(?:-[A-Z0-9]+)?)$/);
  if (!match) throw new Error(`Invalid input: "${raw}". Use "COMP_SCI 212" or "COMP_SCI 212-1".`);

  const subject = match[1];
  let number = match[2];
  if (!number.includes("-")) number = `${number}-0`; // your rule
  return { subject, number };
}

function norm(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// Find frame that contains a selector
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

  // Correct IDs (discovered from your dump)
  const CAREER_SEL = "#NW_CT_PB_SRCH_ACAD_CAREER";
  const SUBJECT_SEL = "#NW_CT_PB_SRCH_SUBJECT";

  // Find the frame that contains the career dropdown
  const frame = await waitForFrameWithSelector(page, CAREER_SEL);
  console.log("Found Search CTECs frame");
  // console.log("Frame URL:", frame.url()); // optional

  // Select Undergraduate (by label)
  const careerChosen = await selectByLabelMatch(
    frame,
    CAREER_SEL,
    (label) => label.toLowerCase() === "undergraduate"
  );
  console.log(`Set Academic Career = ${careerChosen}`);

  // Wait for subject options to load after career selection
  await frame.waitForFunction(
    (sel) => {
      const s = document.querySelector(sel);
      return s && s.options && s.options.length > 1;
    },
    SUBJECT_SEL,
    { timeout: 0 }
  );

  // Select subject (match option label starting with "COMP_SCI")
  const subjChosen = await selectByLabelMatch(frame, SUBJECT_SEL, (label) => {
    return label.startsWith(subject + " ");
  });
  console.log(`Set Academic Subject = ${subjChosen}`);

  // Click Search
  await frame.click('input[value="Search"]');

  // Wait for results
  await frame.waitForSelector('a:has-text("Get List of CTECs")', { timeout: 0 });

  const courseLinks = await frame.$$('a:has-text("Get List of CTECs")');
  console.log(`Found ${courseLinks.length} course rows.`);

  // Find the exact course row that starts with your number (e.g., "212-0:")
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

  // Click "Get List of CTECs"
  await targetLink.click();

  // Wait for evaluation list
  await frame.waitForSelector('a:has-text("View Evaluation")', { timeout: 0 });

  const evalLinks = await frame.$$('a:has-text("View Evaluation")');

  // Find first REAL evaluation row (skip header/control rows)
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

  if (!realEvalLink) {
    throw new Error("Could not find a real evaluation row to open.");
  }

  if (DEBUG_LIST_EVAL_ROWS) {
    console.log(`\nFound ${evalLinks.length} evaluation links. Listing rows:\n`);
    for (const link of evalLinks) {
      const rowHandle = await link.evaluateHandle((a) => a.closest("tr"));
      const row = rowHandle.asElement();
      if (!row) continue;

      const cells = await row.$$("td");
      if (cells.length < 2) continue;

      const termText = norm(await cells[0].innerText());
      const descText = norm(await cells[1].innerText());

      if (!looksLikeTerm(termText)) continue;

      let instructor = "Unknown";
      const parens = [...descText.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
      if (parens.length > 0) instructor = parens[parens.length - 1];

      console.log(`- ${termText} | Instructor: ${instructor} | ${descText}`);
    }
  }

  console.log(`\nOpening evaluation for: ${realRowTerm} | ${realRowDesc}`);

  // Click and capture popup if it opens a new tab/window
  const popupPromise = page.waitForEvent("popup").catch(() => null);
  await realEvalLink.click();

  let evalPage = await popupPromise;
  if (!evalPage) {
    // No popup; assume same page navigated
    evalPage = page;
    await evalPage.waitForLoadState("domcontentloaded");
  } else {
    await evalPage.waitForLoadState("domcontentloaded");
  }

  await evalPage.waitForTimeout(1500);

  const bodyText = await evalPage.locator("body").innerText();
  const text = bodyText;

  // helper to pull a single match
  function pick(re, group = 1) {
  const m = text.match(re);
  if (!m) return null;
  const val = m[group];
  return typeof val === "string" ? val.trim() : null;
}

  // 1) Title + term
  const reportTitle =
    pick(/^Student Report for .*$/m) || pick(/^My Report Viewer\s*\n(.*)$/m);
  const ctecTerm = pick(/Course and Teacher Evaluations CTEC\s+([A-Za-z]+\s+\d{4})/);

  // 2) Responses info
  const audience = pick(/Courses Audience\s*\n(\d+)/);
  const received = pick(/Responses Received\s*\n(\d+)/);
  const ratio = pick(/Response Ratio\s*\n([0-9.]+%)/);

  // 3) Means for key questions
  function meanForQuestion(qStartsWith) {
    const idx = text.indexOf(qStartsWith);
    if (idx === -1) return null;
    const window = text.slice(idx, idx + 1200);
    const m = window.match(/Mean\s+([0-9.]+)/);
    return m ? m[1] : null;
  }

  const meanInstruction = meanForQuestion("1. Provide an overall rating of the instruction.");
  const meanCourse = meanForQuestion("2. Provide an overall rating of the course.");

  console.log("\n=== Extracted Report Data ===");
  console.log("Title:", reportTitle);
  console.log("CTEC Term:", ctecTerm);
  console.log("Audience:", audience);
  console.log("Responses Received:", received);
  console.log("Response Ratio:", ratio);
  console.log("Mean (Instruction):", meanInstruction);
  console.log("Mean (Course):", meanCourse);
  console.log("=============================\n");

  await context.close();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});