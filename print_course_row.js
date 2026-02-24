// print_course_row.js

// Parses terminal input into usable course information for our search
// Usage:
//   node print_course_row.js "COMP_SCI 212"     -> normalized to COMP_SCI 212-0
//   node print_course_row.js "COMP_SCI 212-1"   -> stays COMP_SCI 212-1
//   node print_course_row.js "HISTORY 201"      -> normalized to HISTORY 201-0
//   node print_course_row.js "COMP_SCI 111-SG"  -> stays COMP_SCI 111-SG
function parseCourseArg(argv) {
  const raw = argv.slice(2).join(" ").trim();

  if (!raw) {
    throw new Error(
      'Missing input. Example: node print_course_row.js "COMP_SCI 212"'
    );
  }

  // SUBJECT is uppercase with optional underscores, e.g., COMP_SCI
  // COURSE can be:
  //   212
  //   212-0
  //   212-1
  //   111-SG
  // We accept digits, optionally followed by a hyphen and alphanumerics
  const match = raw.match(/^([A-Z_]+)\s+([0-9]+(?:-[A-Z0-9]+)?)$/);

  if (!match) {
    throw new Error(
      `Invalid input: "${raw}". Use format like "COMP_SCI 212" or "COMP_SCI 212-1".`
    );
  }

  const subject = match[1];
  let number = match[2];

  // Your rule:
  // If user does specify a suffix, assume "-0".
  // If user specifies a suffix (e.g., -1, -2, -SG), keep it.
  if (!number.includes("-")) {
    number = `${number}-0`;
  }

  return { subject, number, raw };
}

function main() {
  const { subject, number, raw } = parseCourseArg(process.argv);

  console.log("Parsed course input:");
  console.log(`- Raw:     ${raw}`);
  console.log(`- Subject: ${subject}`);
  console.log(`- Number:  ${number}`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}