// print_course_row.js
// Open CAESAR -> wait for Search CTECs dropdowns -> select Undergraduate + subject -> Search -> print first 5 rows.
// Usage: node print_course_row.js "COMP_SCI 212"

const { chromium } = require("playwright");

const START_URL =
  "https://caesar.ent.northwestern.edu/psp/csnu_6/EMPLOYEE/SA/c/NWCT.NW_CT_PUBLIC_VIEW.GBL";

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

  // Find the frame that contains the career dropdown
  const frame = await waitForFrameWithSelector(page, CAREER_SEL);
  console.log("Found Search CTECs frame");
  console.log("Frame URL:", frame.url());

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
  // Options look like: "COMP_SCI - Computer Science"
  const subjChosen = await selectByLabelMatch(frame, SUBJECT_SEL, (label) => {
    return label.startsWith(subject + " ");
  });
  console.log(`Set Academic Subject = ${subjChosen}`);

  // Click Search
  await frame.click('input[value="Search"]');

  // Wait for results
  await frame.waitForSelector('a:has-text("Get List of CTECs")', { timeout: 0 });

  // Print first 5 rows
  const links = await frame.$$('a:has-text("Get List of CTECs")');
  console.log(`Found ${links.length} course rows.`);

  const limit = Math.min(5, links.length);
  for (let i = 0; i < limit; i++) {
    const rowText = await links[i].evaluate((a) => a.closest("tr")?.innerText || "");
    console.log("-", norm(rowText));
  }

  await context.close();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});