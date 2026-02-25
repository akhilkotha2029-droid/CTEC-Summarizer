// print_course_row.js
//
// Open CAESAR Search CTECs in a real browser, let user log in,
// then confirm we reached the Search CTECs page.
//
// Usage (still just prints parsed input + checks login page reached):
// node print_course_row.js "COMP_SCI 212"

const { chromium } = require("playwright");

const START_URL =
  "https://caesar.ent.northwestern.edu/psp/csnu_6/EMPLOYEE/SA/c/NWCT.NW_CT_PUBLIC_VIEW.GBL";

function parseCourseArg(argv) {
  const raw = argv.slice(2).join(" ").trim();

  if (!raw) {
    throw new Error('Missing input. Example: node print_course_row.js "COMP_SCI 212"');
  }

  const match = raw.match(/^([A-Z_]+)\s+([0-9]+(?:-[A-Z0-9]+)?)$/);
  if (!match) {
    throw new Error(
      `Invalid input: "${raw}". Use format like "COMP_SCI 212" or "COMP_SCI 212-1".`
    );
  }

  const subject = match[1];
  let number = match[2];

  // Default to -0 if no suffix
  if (!number.includes("-")) number = `${number}-0`;

  return { subject, number, raw };
}

async function waitForEnter(message) {
  console.log(message);
  await new Promise((resolve) => process.stdin.once("data", resolve));
}

async function main() {
  const { subject, number, raw } = parseCourseArg(process.argv);

  console.log("Parsed course input:");
  console.log(`- Raw:     ${raw}`);
  console.log(`- Subject: ${subject}`);
  console.log(`- Number:  ${number}`);

  // Persistent profile so you only log in once:
  const context = await chromium.launchPersistentContext("./pw-profile", {
    headless: false,
    slowMo: 50,
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });

  await waitForEnter(
    "\nIf redirected to Northwestern login, sign in (NetID + Duo).\n" +
      "When you can see the 'Search CTECs' page, press Enter here.\n"
  );

  const bodyText = await page.locator("body").innerText();
  const looksRight =
    bodyText.includes("Search CTECs") ||
    bodyText.includes("Course and Teacher Evaluations");

  console.log("\nReached Search CTECs page:", looksRight ? "YES" : "NOT SURE");

  if (!looksRight) {
    console.log(
      "If this says NOT SURE, it's usually fine—just make sure you're actually on the Search CTECs page."
    );
  }

  await context.close();
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});