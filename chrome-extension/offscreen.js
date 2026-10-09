/*
 * The document worker.
 *
 * Holds the Word workbook open while a run is going: finds the
 * questions, writes each answer into the space that question left
 * for it, and hands the finished file back when it is done.
 *
 * It lives in an offscreen page because reading a .docx means
 * parsing XML, and a service worker has no parser.
 */

let workbook = null;

let questions = [];

/* Where each question's answer goes, worked out once, up front. */
let placements = [];


function bytesFromBase64(base64) {

    const binary = atob(base64);

    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}


function base64FromBytes(bytes) {

    let binary = "";

    const size = 0x8000;

    for (let at = 0; at < bytes.length; at += size) {

        binary += String.fromCharCode.apply(
            null, bytes.subarray(at, at + size)
        );
    }

    return btoa(binary);
}


function firstBlockOf(blocks, question) {

    /*
     * The reader records where each question sits, and that is what
     * is used. Searching for the question's words would find the
     * wrong one: a workbook opens question after question with the
     * very same sentence - "Read the case study and answer the
     * provided question." - so six of them would all resolve to the
     * first, and their answers would pile up in one place.
     */
    if (typeof question.block_at === "number" && question.block_at >= 0) {
        return question.block_at;
    }

    const head = question.text.split("\n")[0].slice(0, 45);

    if (!head) {
        return -1;
    }

    const found = blocks.find(
        block => !block.empty && block.text.includes(head)
    );

    return found ? found.at : -1;
}


async function open(base64) {

    workbook = new Workbook();

    const blocks = await workbook.load(bytesFromBase64(base64).buffer);

    questions = parseBlocks(blocks);

    /* Each question's own block, then the space that follows it. */
    const starts = questions.map(
        question => firstBlockOf(blocks, question)
    );

    placements = questions.map((question, at) => {

        if (question.grid) {
            return { kind: "table", block: null, start: starts[at] };
        }

        /*
         * The reader has already worked out where this question's
         * answer goes, from that question's own blocks - so there
         * is nothing to search for here.
         */
        const at_space = typeof question.space_at === "number"
            ? question.space_at
            : -1;

        return {
            kind: question.space_kind || "none",
            block: at_space >= 0 ? blocks[at_space] : null,
            start: starts[at]
        };
    });

    return {
        blocks: blocks.length,
        questions: questions.map((question, at) => ({
            number: question.number,
            text: question.text,
            context: question.context,
            answer_type: question.answer_type,
            word_min: question.word_limit_min,
            word_max: question.word_limit_max,
            grid: question.grid
                ? {
                    headers: question.grid.headers,
                    rows: question.grid.rows,
                    table: question.grid.table
                }
                : null,
            where: placements[at].kind
        }))
    };
}


function writeAnswer(at, text) {

    const place = placements[at];

    if (!place) {
        throw new Error("No such question.");
    }

    if (place.block) {

        workbook.fill(place.block, text);

        return place.kind;
    }

    if (place.start >= 0) {

        workbook.insertAfter(workbook.blocks[place.start], text);

        return "under";
    }

    throw new Error("That question could not be found again.");
}


function writeGrid(at, rows) {

    const question = questions[at];

    if (!question || !question.grid) {
        throw new Error("That question has no table.");
    }

    let written = 0;

    rows.forEach((row) => {

        written += workbook.fillRow(
            question.grid.table, row.row, row.cells
        );
    });

    return written;
}


chrome.runtime.onMessage.addListener((message, sender, reply) => {

    if (!message || message.target !== "offscreen") {
        return false;
    }

    (async () => {

        try {

            if (message.type === "docx_open") {
                reply({ success: true, result: await open(message.file) });
                return;
            }

            if (message.type === "docx_answer") {
                reply({
                    success: true,
                    where: writeAnswer(message.at, message.text)
                });
                return;
            }

            if (message.type === "docx_grid") {
                reply({
                    success: true,
                    cells: writeGrid(message.at, message.rows || [])
                });
                return;
            }

            if (message.type === "docx_save") {
                reply({
                    success: true,
                    file: base64FromBytes(await workbook.save())
                });
                return;
            }

            reply({ success: false, error: "Unknown request." });

        } catch (error) {

            reply({ success: false, error: error.message });
        }
    })();

    return true;
});
