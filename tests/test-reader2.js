/* Reader checks for the mixed-heading cases the real workbook shows. */

const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(
    "D:/ai-question-agent/chrome-extension/doc-reader.js",
    "utf8"
);

const context = { console, fetch: null, URL };
vm.createContext(context);
vm.runInContext(
    source +
    "\nthis.extractBlocks = extractBlocks;\nthis.parseBlocks = parseBlocks;",
    context
);

function run(name, html) {
    const questions = context.parseBlocks(context.extractBlocks(html));
    console.log("\n===== " + name + " =====");
    questions.forEach((q) => {
        console.log(
            "[" + q.number + "] space=" + q.has_answer_space +
            " box=" + q.answer_box +
            (q.word_limit_min ? " words=" + q.word_limit_min + "-" + q.word_limit_max : "") +
            "\n    text: " + q.text.replace(/\n/g, " | ").slice(0, 80) +
            (q.context ? "\n    ctx : " + q.context.replace(/\n/g, " | ").slice(0, 70) : "")
        );
    });
    console.log("total: " + questions.length);
}


/* A. The real workbook: a task heading that only introduces the
 *    questions must never be asked itself. */
run("RTO workbook", `
<p>Unit Assessment Task (UAT)</p>
<p>Assessment Task 1 &ndash; Unit Knowledge Test (UKT)</p>
<p>Assessment type:</p>
<p>Written Questions</p>
<p>Assessment task description:</p>
<p>This is the first unit of assessment task the student must complete.</p>
<p>The Unit Knowledge Test is comprised of eleven (11) written questions.</p>
<p></p>
<table><tr><td><p>Question 1. Read the case study and answer the provided question.</p>
<p>You are a construction manager in Australia selecting materials.</p>
<p>Question</p>
<p>What is some common legislation you must consider?</p>
<p>Answer must be 250-300 words.</p>
<p>Satisfactory response</p><p>Yes &#9744;</p><p>No &#9744;</p></td></tr></table>
<p></p>
<table><tr><td><p></p></td></tr></table>
<p></p>
<table><tr><td><p>Question 2. Read the case study and answer 2(a) to 2(c).</p>
<p>You oversee a commercial building project in Melbourne.</p>
<p>Satisfactory response</p><p>Yes &#9744;</p><p>No &#9744;</p></td></tr></table>
<p></p>
<table><tr><td><p>Question 2(a). Explain what project plans and specifications are.</p>
<p>Answer must be 30-80 words.</p>
<p>Satisfactory response</p><p>Yes &#9744;</p><p>No &#9744;</p></td></tr></table>
<p></p>
<table><tr><td><p></p></td></tr></table>
`);

/* B. A workbook whose items really are activities. */
run("activities as questions", `
<p>Assignment 1</p>
<p>Task 1. Describe the WHS duties of a PCBU.</p>
<p>(80-120 words)</p>
<p></p>
<p>Activity 2: List three hazard controls.</p>
<p></p>
<p>Activity 3: Explain why consultation matters.</p>
<p></p>
`);

/* C. "Assessment task description:" must not read as task "d". */
run("loose task words", `
<p>Assessment task description:</p>
<p>Read each question carefully.</p>
<p></p>
<p>Question 1. What is a SWMS?</p>
<p></p>
`);
