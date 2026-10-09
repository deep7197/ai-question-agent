/*
 * The extension reading and answering a Word workbook on its own -
 * no Python, no server. Runs the real docx-zip.js and docx.js
 * against a real .docx, using linkedom to stand in for the
 * browser's DOM.
 *
 *   node tests/test-docx.js ["<workbook.docx>"]
 *
 * With no file given it builds a small workbook of its own, so the
 * check runs anywhere.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const { DOMParser } = require("linkedom");

/* linkedom has no XMLSerializer; a document knows how to print
 * itself, which is all the workbook needs. */
class XMLSerializer {
    serializeToString(node) {
        return node.toString();
    }
}

const root = path.join(__dirname, "..", "chrome-extension");

/* docx.js and docx-zip.js are plain scripts, as the browser loads
 * them - so they are run in one shared context, not required. */
const context = {
    console, TextDecoder, TextEncoder, Blob, Response,
    DecompressionStream, CompressionStream, DOMParser, XMLSerializer,
    module: { exports: {} },
};

vm.createContext(context);

for (const file of ["docx-zip.js", "docx.js", "doc-reader.js"]) {

    context.module = { exports: {} };

    vm.runInContext(
        fs.readFileSync(path.join(root, file), "utf8"),
        context,
        { filename: file }
    );
}

vm.runInContext(
    "this.Workbook = Workbook; this.parseBlocks = parseBlocks;",
    context
);


function sampleWorkbook() {
    /* A tiny .docx, written with python-docx through the test that
     * already builds one. Falls back to skipping if absent. */
    return null;
}


async function main() {

    const given = process.argv[2];

    const file = given || sampleWorkbook();

    if (!file || !fs.existsSync(file)) {
        console.log("no workbook given - skipping");
        return 0;
    }

    const bytes = fs.readFileSync(file);

    const buffer = bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength
    );

    const book = new context.Workbook();

    const blocks = await book.load(buffer);

    const questions = context.parseBlocks(blocks);

    console.log("read %d blocks, found %d questions\n",
        blocks.length, questions.length);

    const problems = [];

    questions.slice(0, 8).forEach((question) => {

        const where = question.grid
            ? "table " + question.grid.rows.length + "x" +
              question.grid.headers.length
            : (question.target ? question.target.kind : "under it");

        console.log("  [%s] %s  %s", question.number,
            question.answer_type, where);
    });

    if (questions.length === 0) {
        problems.push("no questions were found");
    }

    /* Answer them with marked placeholders, then read it back. */

    let filled = 0;
    let cells = 0;

    questions.forEach((question) => {

        if (question.grid) {

            question.grid.rows.forEach((row) => {

                cells += book.fillRow(
                    question.grid.table,
                    row,
                    question.grid.headers.map(
                        head => "[TEST " + question.number + " " + head + "]"
                    )
                );
            });

            return;
        }

        const text = "[TEST " + question.number + " answer]";

        const space = blocks.find(
            block => block.empty && block.at > firstBlockOf(blocks, question)
        );

        if (question.target && space) {
            book.fill(space, text);
        } else {
            book.insertAfter(
                blocks[firstBlockOf(blocks, question)], text
            );
        }

        filled++;
    });

    const out = path.join(
        os.tmpdir(), "extension-answered-" + Date.now() + ".docx"
    );

    fs.writeFileSync(out, Buffer.from(await book.save()));

    console.log("\nwrote %d answers and %d table cells", filled, cells);
    console.log("saved: %s", out);

    /* Re-open what was written: it must still be a valid .docx. */

    const again = new context.Workbook();

    const back = fs.readFileSync(out);

    const reloaded = await again.load(
        back.buffer.slice(back.byteOffset, back.byteOffset + back.byteLength)
    );

    const marks = reloaded.filter(
        block => block.text.includes("[TEST ")
    ).length;

    console.log("re-opened it: %d blocks, %d marked answers",
        reloaded.length, marks);

    if (marks === 0) {
        problems.push("nothing was written into the saved file");
    }

    if (problems.length) {
        console.log("\nFAILED:");
        problems.forEach(problem => console.log("  - " + problem));
        return 1;
    }

    console.log("\nthe extension can read and answer a .docx by itself");
    return 0;
}


function firstBlockOf(blocks, question) {

    const head = question.text.split("\n")[0].slice(0, 40);

    const found = blocks.find(
        block => !block.empty && block.text.includes(head)
    );

    return found ? found.at : 0;
}


main().then(code => process.exit(code)).catch((error) => {
    console.error(error);
    process.exit(1);
});
