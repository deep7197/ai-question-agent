/*
 * The check the writer makes after typing its probe, before it
 * types an answer: did the caret really land in the space that
 * belongs to this question?
 */

const fs = require("fs");
const vm = require("vm");

const PROBE = "\u00abAIQA\u00bb";

/* A workbook page: question box, blank line, empty answer box. */
function page(probeIn) {

    const cell = (text) => "<table><tr><td><p>" + text + "</p></td></tr></table>";

    return "" +
        cell(
            "Question 1. Read the case study.</p>" +
            "<p>What legislation applies to storing materials?</p>" +
            "<p>Answer must be 250-300 words.</p>" +
            "<p>Satisfactory response</p><p>Yes &#9744;</p><p>No &#9744;"
        ) +
        "<p>" + (probeIn === "blankline" ? PROBE : "") + "</p>" +
        cell(probeIn === "box" ? PROBE : "") +
        "<p></p>" +
        cell("Question 2. Name one hazard." +
             (probeIn === "question2" ? " " + PROBE : ""));
}

const ctx = { console, URL };

vm.createContext(ctx);

vm.runInContext(
    fs.readFileSync(
        "D:/ai-question-agent/chrome-extension/doc-reader.js",
        "utf8"
    ) +
    "\nthis.extractBlocks = extractBlocks;" +
    "\nthis.parseBlocks = parseBlocks;" +
    "\nthis.confirmProbe = confirmProbe;" +
    "\nthis.setHtml = (h) => { fetchDocHtml = async () => h; };",
    ctx
);

/* The route the reader works out for question 1. */
const target = ctx
    .parseBlocks(ctx.extractBlocks(page("none")))[0]
    .target;

console.log(
    "route: down x" + target.downs +
    ", " + target.offset + " blocks on, to the " + target.kind +
    "\nanchor: " + target.anchor
);

const url = "https://docs.google.com/document/d/abc123/edit";

async function check(where, expected) {

    ctx.setHtml(page(where));

    const got = await ctx.confirmProbe(url, target, PROBE);

    const verdict = got === expected ? "ok" : "WRONG";

    console.log(
        "  probe in " + where.padEnd(10) +
        " -> " + (got ? "accepted" : "refused") +
        "  (" + verdict + ")"
    );

    return got === expected;
}

(async () => {

    console.log("\nwhere the probe ended up:");

    const results = [
        await check("box", true),
        await check("blankline", false),
        await check("question2", false),
        await check("none", false)
    ];

    if (results.some(pass => !pass)) {
        process.exit(1);
    }
})();
