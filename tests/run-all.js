/*
 * Runs every check in this folder - the JavaScript ones for the
 * Chrome extension, and the Python ones for the Word agent.
 *
 *   node tests/run-all.js
 *
 * Nothing has to be installed first: each check loads the real
 * shipping file and drives it against a stand-in for Chrome, Google
 * Docs or Word, so what gets tested is what gets used.
 *
 * The Python checks need the project's own environment; they are
 * skipped, with a note, if it is not there.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const here = __dirname;

const python = path.join(here, "..", ".venv", "Scripts", "python.exe");

const files = fs.readdirSync(here)
    .filter(name => /^test[-_].*\.(js|py)$/.test(name))
    .sort();

let failed = 0;
let skipped = 0;

files.forEach((name) => {

    const isPython = name.endsWith(".py");

    if (isPython && !fs.existsSync(python)) {
        console.log(name.padEnd(26) + "skipped (no .venv)");
        skipped++;
        return;
    }

    /*
     * This one answers a real workbook, which has to be supplied -
     * there is nothing sensible to run it against by default.
     */
    if (name === "test_real_workbook.py") {
        console.log(name.padEnd(26) + "skipped (needs a workbook)");
        skipped++;
        return;
    }

    process.stdout.write(name.padEnd(26));

    const runner = isPython ? python : process.execPath;

    try {

        execFileSync(runner, [path.join(here, name)], {
            stdio: "pipe",
            timeout: 180000,
        });

        console.log("ok");

    } catch (error) {

        failed++;

        console.log("FAILED");
        console.log(String(error.stdout || "").slice(-1200));
        console.log(String(error.stderr || "").slice(-600));
    }
});

const ran = files.length - skipped;

console.log(
    "\n" + (ran - failed) + " of " + ran + " passed" +
    (skipped ? ", " + skipped + " skipped" : "") + "."
);

process.exit(failed === 0 ? 0 : 1);
