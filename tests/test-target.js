/*
 * The route the writer takes from a question to the space the
 * document leaves for its answer, and what kind of answer each
 * question is asking for.
 */

const fs = require("fs");
const vm = require("vm");

const ctx = { console, URL };

vm.createContext(ctx);

vm.runInContext(
    fs.readFileSync(
        "D:/ai-question-agent/chrome-extension/doc-reader.js",
        "utf8"
    ) +
    "\nthis.extractBlocks = extractBlocks;\nthis.parseBlocks = parseBlocks;",
    ctx
);


function show(name, html) {

    console.log("\n===== " + name + " =====");

    ctx.parseBlocks(ctx.extractBlocks(html)).forEach((q) => {

        const t = q.target;

        console.log(
            "[" + q.number + "] type=" + q.answer_type +
            (q.word_limit_min
                ? " words=" + q.word_limit_min + "-" + q.word_limit_max
                : "") +
            "\n   route: " + (t
                ? "down x" + t.downs + " to the " + t.kind +
                  ", anchored on \"" + t.anchor.slice(0, 45) + "...\""
                : "none - answer goes at the end")
        );
    });
}


/* The real workbook shape. */
show("RTO workbook", `
<table><tr><td><p>Question 1. Read the case study and answer the provided question.</p>
<p>You are a construction manager in Australia tasked with selecting, procuring and storing construction materials for a commercial project in Melbourne.</p>
<p>Question</p>
<p>What is some common legislation you must consider when selecting materials?</p>
<p>Answer must be 250-300 words.</p>
<p>Satisfactory response</p><p>Yes &#9744;</p><p>No &#9744;</p></td></tr></table>
<p></p>
<table><tr><td><p></p></td></tr></table>
<p></p>
<table><tr><td><p>Question 2(a). Explain what project plans and specifications are.</p>
<p>Answer must be 30-80 words.</p>
<p>Satisfactory response</p><p>Yes &#9744;</p><p>No &#9744;</p></td></tr></table>
<p></p>
<table><tr><td><p></p></td></tr></table>
`);

/* A genuine yes/no question, and a blank-line answer space. */
show("yes-no and blank lines", `
<p>Question 1. Is a safe work method statement required for work at heights?</p>
<p>Yes &#9744;</p><p>No &#9744;</p>
<p></p>
<p>Question 2. Explain the reason for your answer above.</p>
<p>Answer must be 40-60 words.</p>
<p></p>
`);

/*
 * Two routes that must be refused rather than guessed: an anchor
 * that appears twice, and a long line in the way that might wrap.
 */
show("unsafe routes", `
<p>Question 1. Explain the hierarchy of control.</p>
<p></p>
<p>Question 2. Explain the hierarchy of control.</p>
<p></p>
<p>Question 3. Name one hazard on a construction site.</p>
<p>Before answering, read the following note carefully, because it changes what a satisfactory answer looks like in practice on site.</p>
<p></p>
`);
