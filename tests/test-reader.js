/* Exercises the reader's parser against mobilebasic-shaped HTML. */

const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(
    "D:/ai-question-agent/chrome-extension/doc-reader.js",
    "utf8"
);

const context = { console, fetch: null, URL };

vm.createContext(context);
vm.runInContext(source + "\nthis.extractBlocks = extractBlocks;" +
    "\nthis.parseBlocks = parseBlocks;", context);

function run(name, html) {

    const blocks = context.extractBlocks(html);
    const questions = context.parseBlocks(blocks);

    console.log("\n===== " + name + " =====");
    questions.forEach((q) => {
        console.log(
            "[" + q.number + "] space=" + q.has_answer_space +
            " box=" + q.answer_box +
            (q.word_limit_min ? " words=" + q.word_limit_min + "-" + q.word_limit_max : "") +
            "\n    text: " + q.text.replace(/\n/g, " | ").slice(0, 90) +
            (q.context ? "\n    ctx : " + q.context.replace(/\n/g, " | ").slice(0, 70) : "")
        );
    });
    console.log("total: " + questions.length);
}


/* 1. Classic table layout: question box then blank answer box. */
run("tables", `
<p>Unit Assessment Workbook</p>
<p>Section A - Knowledge Questions</p>
<table><tr><td><p>Question 1. Explain what a risk assessment is.</p>
<p>Answers must be 50-100 words.</p></td></tr></table>
<table><tr><td><p></p></td></tr></table>
<table><tr><td><p>Question 2. Read the case study and answer 2(a) to 2(b).</p>
<p>A builder is storing cement on an open site.</p></td></tr></table>
<table><tr><td><p>Question 2(a). What storage risks apply?</p></td></tr></table>
<table><tr><td><p>&nbsp;</p></td></tr></table>
<table><tr><td><p>Question 2(b). Who checks them?</p></td></tr></table>
<table><tr><td><p></p></td></tr></table>
`);

/* 2. Plain paragraphs with blank lines as the answer space. */
run("paragraphs", `
<p>Assignment 1</p>
<p>Task 1. Describe the WHS duties of a PCBU.</p>
<p>(80-120 words)</p>
<p></p>
<p></p>
<p>Activity 2: List three hazard controls.</p>
<p></p>
<p>Question 3. What is a SWMS?</p>
<p>Satisfactory response</p>
<p>Answers must include a safe work method statement.</p>
<p></p>
`);

/* 3. No Question/Task headings at all - plain numbered list. */
run("loose numbering", `
<p>Section B</p>
<p>1. Define duty of care.</p>
<p></p>
<p>2. Give an example of a hazard.</p>
<p></p>
<p>3. Why is consultation important?</p>
`);

/* 4. Section heading that is itself the question. */
run("section as question", `
<p>Question 1. Name two hazards.</p>
<p></p>
<p>Part C</p>
<p>Write a short reflection on your own safety practice.</p>
<p></p>
`);

/* 5. Answer label inside the box, tick boxes, no blank space. */
run("labels and ticks", `
<table><tr><td><p>Question 1. Explain hierarchy of control.</p></td>
<td><p>Yes \u2610</p><p>No \u2610</p></td></tr></table>
<p>Answer:</p>
<p></p>
<p>Question 2. Explain PPE.</p>
<p>Question 3. Explain training.</p>
`);
