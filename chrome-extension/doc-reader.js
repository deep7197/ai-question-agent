/*
 * Reads the questions out of a Google Doc.
 *
 * Google Docs paints the document into a <canvas>, so the text is
 * NOT in the page and cannot be scraped from it. Instead this fetches
 * the document's own plain HTML view ("mobilebasic") using the user's
 * signed-in session, which returns the real text - and, just as
 * importantly, the real structure: paragraphs, tables, and the blank
 * boxes and blank lines the document leaves for the answer.
 *
 * Runs in the background service worker, where host_permissions allow
 * the cross-origin request. The document is never opened in a tab.
 */


const DOC_ID_PATTERN = /\/document\/d\/([a-zA-Z0-9_-]+)/;


function getDocumentId(url) {

    const match = DOC_ID_PATTERN.exec(url);

    return match ? match[1] : null;
}


function getTabParam(url) {

    try {
        return new URL(url).searchParams.get("tab") || "";
    } catch (error) {
        return "";
    }
}


/* ------------------------------------------------------------------
 * HTML -> blocks
 *
 * A "block" is one paragraph, heading, list item or table cell.
 * Blocks with no text are kept, because an empty paragraph or an
 * empty table cell is exactly the white space the document leaves
 * for the student's answer.
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    ndash: "-",
    mdash: "-",
    rsquo: "'",
    lsquo: "'",
    rdquo: "\"",
    ldquo: "\""
};


function decodeEntities(text) {

    return text.replace(
        /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
        (whole, name) => {

            const key = name.toLowerCase();

            if (NAMED_ENTITIES[key] !== undefined) {
                return NAMED_ENTITIES[key];
            }

            if (key.charAt(0) === "#") {

                const code = key.charAt(1) === "x"
                    ? parseInt(key.slice(2), 16)
                    : parseInt(key.slice(1), 10);

                if (!isNaN(code)) {
                    return String.fromCharCode(code);
                }
            }

            return whole;
        }
    );
}


const BLOCK_TAG = /^(p|h[1-6]|li|blockquote)$/;


function extractBlocks(html) {

    const source = html.replace(
        /<(script|style)[\s\S]*?<\/\1>/gi,
        ""
    );

    const blocks = [];

    let buffer = "";

    let tableDepth = 0;

    let cellFilled = false;

    /*
     * Where a block sits in the document's tables. Grid questions -
     * a header row, then a row per item with empty cells to fill -
     * can only be recognised from this geometry.
     */
    let tableIndex = -1;

    let tableCount = 0;

    const openTables = [];

    const rowOf = {};

    const cellOf = {};

    function take() {

        const value = decodeEntities(buffer)
            .replace(/[ \t ]+/g, " ")
            .trim();

        buffer = "";

        return value;
    }

    function push(value) {

        blocks.push({
            at: blocks.length,
            text: value,
            empty: value.length === 0,
            inTable: tableDepth > 0,
            table: tableDepth > 0 ? tableIndex : -1,
            row: tableDepth > 0 ? (rowOf[tableIndex] || 0) : -1,
            cell: tableDepth > 0 ? (cellOf[tableIndex] || 0) : -1
        });
    }

    const TAG = /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi;

    let position = 0;

    let match;

    while ((match = TAG.exec(source)) !== null) {

        buffer += source.slice(position, match.index);

        position = TAG.lastIndex;

        const closing = match[1] === "/";

        const name = match[2].toLowerCase();

        if (name === "br") {

            buffer += "\n";

            continue;
        }

        if (name === "table") {

            const value = take();

            if (value) {
                push(value);
            }

            if (closing) {

                tableDepth = Math.max(0, tableDepth - 1);

                openTables.pop();

                tableIndex = openTables.length
                    ? openTables[openTables.length - 1]
                    : -1;

            } else {

                tableDepth++;

                tableIndex = tableCount;

                tableCount++;

                openTables.push(tableIndex);

                rowOf[tableIndex] = -1;
                cellOf[tableIndex] = -1;
            }

            continue;
        }

        if (name === "tr") {

            if (!closing && tableDepth > 0) {

                rowOf[tableIndex] = (rowOf[tableIndex] || 0) + 1;
                cellOf[tableIndex] = -1;
            }

            continue;
        }

        if (name === "td" || name === "th") {

            if (closing) {

                const value = take();

                if (value) {
                    push(value);
                    cellFilled = true;
                }

                /* An empty cell is a blank answer box. */
                if (!cellFilled) {
                    push("");
                }

            } else {

                buffer = "";
                cellFilled = false;

                if (tableDepth > 0) {
                    cellOf[tableIndex] = (cellOf[tableIndex] || 0) + 1;
                }
            }

            continue;
        }

        if (BLOCK_TAG.test(name)) {

            const value = take();

            if (value) {

                push(value);
                cellFilled = true;

            } else if (closing && tableDepth === 0) {

                /*
                 * A paragraph that closed with nothing in it is an
                 * empty line in the body - white space. Only the
                 * closing tag counts, or every opening <p> would
                 * look like one.
                 */
                push("");
            }

            continue;
        }
    }

    const tail = take();

    if (tail) {
        push(tail);
    }

    return blocks;
}


/* ------------------------------------------------------------------
 * Line classification
 * ------------------------------------------------------------------ */

/*
 * Question 1.   Question 1(a).   Q1.   Ques 3:   Question 3a.
 *
 * The subpart letter is written either in parentheses or run
 * straight onto the number. Without the lookahead on the bare form,
 * "Question 3 and 4" would read as subpart "a" of question 3, cut
 * out of the middle of the word "and".
 */
const QUESTION_LINE =
    /^(?:questions?|ques|q)\s*[.:#]?\s*([0-9]+)\s*(?:\(\s*([a-z])\s*\)|([a-z])(?![a-z0-9]))?\s*[.:)\-–—]?\s*(.*)$/i;

/*
 * Task 1.   Assessment Task 2.   Activity 3.   Exercise 4.
 *
 * The number must stand on its own: without the lookahead,
 * "Assessment task description:" reads as task "d" of "escription:".
 */
const TASK_LINE =
    /^(?:assessment\s+|written\s+|practical\s+)?(task|activity|exercise|scenario|case\s+study)\s*[.:#]?\s*([0-9]+|[a-z])(?![a-z0-9])\s*(?:\(\s*([a-z])\s*\))?\s*[.:)\-–—]?\s*(.*)$/i;

/* Section A.   Assignment 1.   Part B.   Unit 2.   Module 3. */
const SECTION_LINE =
    /^(section|assignment|assessment|part|unit|module|chapter|topic)\s*[.:#]?\s*(?:([0-9]+|[a-z])(?![a-z0-9]))?\s*[.:)\-–—]?\s*(.*)$/i;

/* (a) something    a) something    a. something */
const SUBPART_LINE =
    /^\(?\s*([a-z])\s*[).]\s+(.+)$/;

/* (ii) something */
const ROMAN_LINE =
    /^\(?\s*([ivx]{2,})\s*[).]\s+(.+)$/i;

/* 1. something    2) something */
const NUMBERED_LINE =
    /^([0-9]{1,2})\s*[.)]\s+(.+)$/;

const WORD_LIMIT =
    /answers?\s+(?:must|should)\s+be\s+(?:between\s+)?(\d+)\s*(?:-|–|to)\s*(\d+)\s*words?|\(?\s*(\d+)\s*(?:-|–|to)\s*(\d+)\s*words\s*\)?/i;

const WORD_LIMIT_ONLY =
    /^[\s(]*\d+\s*(?:-|–|to)\s*\d+\s*words?[\s.)]*$/i;


/*
 * Everything after one of these belongs to the marker, not to the
 * student, so it must never reach the AI.
 */
function isMarkerLine(line) {

    const lower = line.toLowerCase();

    return (
        lower === "satisfactory response" ||
        lower === "sample answer" ||
        lower === "sample response" ||
        lower === "model answer" ||
        lower === "answer may vary" ||
        lower === "benchmark answer" ||
        lower.startsWith("answers must include") ||
        lower.startsWith("answer must include") ||
        lower.startsWith("a satisfactory response") ||
        lower.startsWith("marking guide") ||
        lower.startsWith("assessor")
    );
}


function isNoiseLine(line) {

    const lower = line.toLowerCase();

    return (
        line.includes("☐") ||
        lower === "question" ||
        lower === "answer" ||
        lower === "answer:" ||
        lower === "your answer" ||
        lower === "your answer:" ||
        lower === "student response" ||
        lower === "yes" ||
        lower === "no" ||
        lower === "satisfactory" ||
        lower === "not satisfactory" ||
        /^(yes|no)\s*[☐□]/i.test(line)
    );
}


const TICK_LINE = /[\u2610\u25a1\u2612\u2611]/;

/*
 * A heading only counts as a question in its own right when it
 * actually asks for something. Workbook front matter - "Unit
 * outcome", "Assessment conditions", "Section 2: Reasonable
 * adjustments" - is prose about the assessment rather than part of
 * it, and must never be answered into.
 */
const INSTRUCTION =
    /^(explain|describe|list|outline|identify|discuss|define|state|complete|write|provide|give|name|summari[sz]e|analy[sz]e|evaluate|recogni[sz]e|choose|select|oversee|demonstrate|perform|prepare|develop|review|calculate|research|record|report|plan|apply|compare|justify)\b/i;

const YES_NO_LINE =
    /^(yes|no)\b/i;


/*
 * A section heading only counts as a section when it really looks
 * like a heading - a short line - rather than a sentence that
 * happens to begin with the word "Part" or "Assessment".
 */
function looksLikeHeading(line) {

    return line.length <= 90 && !/\?\s*$/.test(line);
}


/*
 * Works out what, if anything, a line starts.
 *
 * "loose" turns on the plain "1." and "(a)" forms. They are only
 * used in a document that has no Question or Task headings at all,
 * because inside a normal document those are usually list items
 * belonging to a question rather than new questions.
 */
function matchItemStart(line, loose) {

    let match = QUESTION_LINE.exec(line);

    if (match) {

        const letter = (match[2] || match[3] || "").toLowerCase();

        return {
            kind: "question",
            parent: match[1],
            letter: letter,
            label: letter
                ? match[1] + "(" + letter + ")"
                : match[1],
            head: (match[4] || "").trim()
        };
    }

    match = TASK_LINE.exec(line);

    if (match) {

        const word = match[1]
            .replace(/\s+/g, " ")
            .toLowerCase();

        const name = word.charAt(0).toUpperCase() + word.slice(1);

        const number = String(match[2]).toUpperCase();

        const letter = (match[3] || "").toLowerCase();

        /*
         * A task or activity heading is treated like a section: it
         * is background for whatever is asked underneath it, and is
         * only answered itself when nothing else follows it and the
         * document leaves it an answer space. Without this,
         * "Assessment Task 1 - Unit Knowledge Test" would be sent
         * to the AI as though it were question one.
         */
        return {
            kind: "section",
            parent: name + " " + number,
            letter: letter,
            label: letter
                ? name + " " + number + "(" + letter + ")"
                : name + " " + number,
            head: (match[4] || "").trim()
        };
    }

    match = SECTION_LINE.exec(line);

    if (match && looksLikeHeading(line)) {

        const word = match[1].toLowerCase();

        const name = word.charAt(0).toUpperCase() + word.slice(1);

        const number = match[2]
            ? String(match[2]).toUpperCase()
            : "";

        return {
            kind: "section",
            parent: "",
            letter: "",
            label: (name + " " + number).trim(),
            head: (match[3] || "").trim()
        };
    }

    if (!loose) {
        return null;
    }

    match = ROMAN_LINE.exec(line);

    if (match) {

        return {
            kind: "question",
            parent: "",
            letter: "",
            label: "(" + match[1].toLowerCase() + ")",
            head: match[2].trim()
        };
    }

    match = SUBPART_LINE.exec(line);

    if (match) {

        return {
            kind: "question",
            parent: "",
            letter: "",
            label: "(" + match[1].toLowerCase() + ")",
            head: match[2].trim()
        };
    }

    match = NUMBERED_LINE.exec(line);

    if (match) {

        return {
            kind: "question",
            parent: match[1],
            letter: "",
            label: match[1],
            head: match[2].trim()
        };
    }

    return null;
}


/* ------------------------------------------------------------------
 * Parser
 * ------------------------------------------------------------------ */

function hasExplicitHeadings(blocks) {

    return blocks.some((block) => {

        if (block.empty) {
            return false;
        }

        return block.text.split("\n").some((line) => {

            const text = line.trim();

            return QUESTION_LINE.test(text) || TASK_LINE.test(text);
        });
    });
}


function parseBlocks(blocks) {

    const loose = !hasExplicitHeadings(blocks);

    const items = [];

    let current = null;

    let inMarkerSection = false;

    for (const block of blocks) {

        if (block.empty) {

            if (current) {
                current.blocks.push(block);
            }

            /*
             * A blank paragraph, or an empty table cell, that comes
             * after an item's text is the white space left for its
             * answer.
             */
            if (current && (current.head || current.body.length)) {

                current.space++;

                if (block.inTable) {
                    current.spaceBox = true;
                }
            }

            continue;
        }

        /*
         * A block can be a whole table cell, and an assessment
         * question puts its wording, its word count and the
         * assessor's tick boxes in that one cell. So every line is
         * read on its own, exactly as if each were its own
         * paragraph - which is what they are in a Google Doc.
         */
        const lines = block.text
            .split("\n")
            .map(part => part.trim())
            .filter(part => part.length > 0);

        let attached = false;

        for (const line of lines) {

        const start = matchItemStart(line, loose);

        if (start) {

            if (current) {
                items.push(current);
            }

            attached = true;

            current = {
                kind: start.kind,
                parent: start.parent,
                letter: start.letter,
                label: start.label,
                head: start.head,
                body: [],
                blocks: [],
                space: 0,
                spaceBox: false,
                wordMin: null,
                wordMax: null
            };

            inMarkerSection = false;

            /*
             * The heading line belongs to the question too: it is
             * often the only line unique enough to search for.
             */
            current.blocks.push(block);

            continue;
        }

        if (!current) {
            continue;
        }

        if (!attached) {
            current.blocks.push(block);
            attached = true;
        }

        const limit = WORD_LIMIT.exec(line);

        if (limit) {

            current.wordMin = Number(limit[1] || limit[3]);
            current.wordMax = Number(limit[2] || limit[4]);

            /* A bare "(50-100 words)" line carries nothing else. */
            if (WORD_LIMIT_ONLY.test(line)) {
                continue;
            }
        }

        if (isMarkerLine(line)) {

            inMarkerSection = true;

            continue;
        }

        if (inMarkerSection || isNoiseLine(line)) {
            continue;
        }

        current.body.push(line);

        /* Text after a gap means that gap was not the answer space. */
        current.space = 0;
        current.spaceBox = false;

        }
    }

    if (current) {
        items.push(current);
    }

    return buildQuestions(items);
}


/*
 * Some questions are not answered in prose at all: the document
 * gives a table to fill in - a header row, then one row per item
 * with empty cells beside it. For example
 *
 *   Building Material | Properties | Applications | Limitations
 *   1. Cements        |            |              |
 *   2. Ceramics       |            |              |
 *
 * This finds that table among the blocks belonging to a question,
 * and describes it so each cell can be answered and filled in.
 * Returns null when the question is an ordinary written one.
 */
function detectGrid(blocks) {

    const tables = {};

    blocks.forEach((block) => {

        if (block.table >= 0) {

            if (!tables[block.table]) {
                tables[block.table] = [];
            }

            tables[block.table].push(block);
        }
    });

    const keys = Object.keys(tables);

    for (const key of keys) {

        const cells = tables[key];

        const header = cells
            .filter(cell => cell.row === 0)
            .sort((a, b) => a.cell - b.cell);

        /* A header row: two or more short, filled cells. */
        const headerLooksRight =
            header.length >= 2 &&
            header.every(
                cell => !cell.empty && cell.text.length <= 60
            );

        if (!headerLooksRight) {
            continue;
        }

        const numbers = [];

        cells.forEach((cell) => {

            if (cell.row > 0 && numbers.indexOf(cell.row) === -1) {
                numbers.push(cell.row);
            }
        });

        numbers.sort((a, b) => a - b);

        const rows = [];

        let columns = 0;

        numbers.forEach((number) => {

            const row = cells
                .filter(cell => cell.row === number)
                .sort((a, b) => a.cell - b.cell);

            if (row.length < 2) {
                return;
            }

            const label = row[0];

            const rest = row.slice(1);

            /* A row to fill: a label, then nothing but empty cells. */
            if (
                label.empty ||
                rest.length === 0 ||
                !rest.every(cell => cell.empty)
            ) {
                return;
            }

            rows.push(label.text);

            columns = Math.max(columns, rest.length);
        });

        if (rows.length >= 2) {

            return {
                table: Number(key),
                headers: header.slice(1).map(cell => cell.text),
                rows: rows,
                columns: columns
            };
        }
    }

    return null;
}


/*
 * Describes how the writer gets from a line it can search for to
 * the space the document leaves for the answer:
 *
 *   anchor  - the line to search for, which must appear exactly
 *             once in the whole document or the writer could land
 *             on another question
 *   downs   - how many times to press the down arrow from there
 *   offset  - how many blocks past the anchor the space is, which
 *             is what the writer checks before typing anything
 *   kind    - "box" for an empty table cell, "line" for an empty
 *             paragraph
 *
 * The anchor closest to the answer space is preferred: every line
 * in between is one more press of the down arrow, and one more
 * chance to be wrong. A line long enough to wrap in between makes
 * the count unknowable, so that anchor is passed over.
 *
 * Returns null when no safe route exists - the answer is then
 * collected at the end of the document instead, where it is
 * visible and nothing is damaged.
 */

const ANCHOR_MIN = 12;

const NO_WRAP_MAX = 60;


function buildTarget(item, counts) {

    const blocks = item.blocks || [];

    let box = -1;

    let line = -1;

    for (let i = 0; i < blocks.length; i++) {

        if (!blocks[i].empty) {
            continue;
        }

        if (blocks[i].inTable && box === -1) {
            box = i;
        }

        if (!blocks[i].inTable && line === -1) {
            line = i;
        }
    }

    const to = box !== -1 ? box : line;

    if (to === -1) {
        return null;
    }

    for (let i = to - 1; i >= 0; i--) {

        const block = blocks[i];

        if (
            block.empty ||
            block.text.length < ANCHOR_MIN ||
            counts[block.text] !== 1
        ) {
            continue;
        }

        let safe = true;

        for (let j = i + 1; j < to; j++) {

            if (
                !blocks[j].empty &&
                blocks[j].text.length > NO_WRAP_MAX
            ) {
                safe = false;
                break;
            }
        }

        if (!safe) {
            continue;
        }

        return {
            anchor: block.text,
            downs: to - i,
            offset: blocks[to].at - blocks[i].at,
            kind: box !== -1 ? "box" : "line"
        };
    }

    return null;
}


/*
 * What the question is asking for. A question that offers Yes / No
 * boxes of its own wants one of those words; anything else wants
 * prose. The assessor's own "Satisfactory response - Yes / No" is
 * not the student's to answer, so it is not counted.
 */
function answerType(item) {

    const blocks = item.blocks || [];

    let marking = false;

    for (const block of blocks) {

        if (block.empty) {
            continue;
        }

        if (isMarkerLine(block.text)) {
            marking = true;
            continue;
        }

        if (marking) {
            continue;
        }

        if (TICK_LINE.test(block.text) || YES_NO_LINE.test(block.text)) {
            return "yesno";
        }
    }

    return "prose";
}


function fullText(item) {

    return [item.head]
        .concat(item.body)
        .filter(Boolean)
        .join("\n")
        .trim();
}


/*
 * Turns the items into the list of things to actually ask.
 *
 *   - "Question 2." with parts 2(a)..2(c) is never asked on its own:
 *     its case study becomes context for each part.
 *   - A section or assignment heading becomes context for everything
 *     under it - unless nothing follows it and it has its own answer
 *     space, in which case it is a question in its own right.
 *   - Everything else that carries text is asked.
 */
/* The question's own words, with the grid's contents left out. */
function gridFreeText(item, grid) {

    const inGrid = {};

    (item.blocks || []).forEach((block) => {

        if (block.table === grid.table && !block.empty) {
            inGrid[block.text] = true;
        }
    });

    const lines = [item.head]
        .concat(item.body)
        .filter(line => line && !inGrid[line]);

    return lines.join("\n").trim();
}


/* How many times each line appears in the whole document. */
function countLines(items) {

    const counts = {};

    items.forEach((item) => {

        (item.blocks || []).forEach((block) => {

            if (block.empty) {
                return;
            }

            counts[block.text] = (counts[block.text] || 0) + 1;
        });
    });

    return counts;
}


/*
 * The space this question leaves for its answer, as a position in
 * the document: an empty box first, because a box is unmistakable,
 * otherwise an empty line - but never one sitting past the marking
 * guidance, which belongs to the assessor.
 *
 * Only the question's own blocks are considered. Looking ahead as
 * far as the next question would wander into whatever lies between
 * them - a result sheet, a declaration - and write the answer into
 * one of those empty boxes instead.
 */
function spaceOf(item) {

    let box = null;

    let blank = null;

    let pastMarking = false;

    (item.blocks || []).forEach((block) => {

        if (!block.empty) {

            block.text.split("\n").forEach((part) => {

                if (part.trim() && isMarkerLine(part.trim())) {
                    pastMarking = true;
                }
            });

            return;
        }

        if (block.inTable && box === null) {
            box = block;
        }

        if (!block.inTable && blank === null && !pastMarking) {
            blank = block;
        }
    });

    if (box) {
        return { at: box.at, kind: "box" };
    }

    if (blank) {
        return { at: blank.at, kind: "line" };
    }

    return { at: -1, kind: "none" };
}


function buildQuestions(items) {

    const hasParts = {};

    items.forEach((item) => {

        if (item.letter && item.parent) {
            hasParts[item.parent] = true;
        }
    });

    /* Does anything follow this section before the next one? */
    const sectionHasContent = {};

    let lastSection = -1;

    items.forEach((item, index) => {

        if (item.kind === "section") {

            lastSection = index;

            sectionHasContent[index] = false;

        } else if (lastSection >= 0) {

            sectionHasContent[lastSection] = true;
        }
    });

    const caseStudyFor = {};

    items.forEach((item) => {

        if (
            item.kind === "question" &&
            !item.letter &&
            item.parent &&
            hasParts[item.parent]
        ) {
            caseStudyFor[item.parent] = fullText(item);
        }
    });

    const questions = [];

    const used = {};

    const counts = countLines(items);

    let sectionContext = "";

    items.forEach((item, index) => {

        const grid = detectGrid(item.blocks || []);

        /*
         * The grid's own labels are part of the table, not of the
         * question, so they are kept out of the text sent to the AI.
         */
        const text = grid
            ? gridFreeText(item, grid)
            : fullText(item);

        if (item.kind === "section") {

            /*
             * Answered itself only when nothing is asked under it,
             * the document leaves it white space, and it carries a
             * real prompt rather than just a title.
             */
            /*
             * Answered itself only when nothing is asked under it,
             * the document gives it a box of its own, and it reads
             * as an instruction rather than a title. A blank line
             * is not enough: workbooks list their activities before
             * setting them, and the gap in that list is spacing.
             */
            const answerable =
                !sectionHasContent[index] &&
                item.spaceBox &&
                text.length >= 15 &&
                (text.includes("?") || INSTRUCTION.test(text.trim()));

            if (!answerable) {

                sectionContext = [item.label, text]
                    .filter(Boolean)
                    .join(" ")
                    .trim();

                return;
            }
        }

        /* A parent that only introduces a case study is not asked. */
        if (
            item.kind === "question" &&
            !item.letter &&
            item.parent &&
            hasParts[item.parent]
        ) {
            return;
        }

        if (!text) {
            return;
        }

        const context = [
            sectionContext,
            caseStudyFor[item.parent] || ""
        ]
            .filter(Boolean)
            .join("\n\n");

        /* Labels must be unique - answers are matched back by them. */
        let label = item.label;

        if (used[label]) {

            used[label]++;

            label = label + "#" + used[label];

        } else {
            used[label] = 1;
        }

        questions.push({
            number: label,

            /*
             * Where this question sits in the document. Several
             * questions in a workbook often open with the very same
             * sentence - "Read the case study and answer the
             * provided question." - so they cannot be found again
             * by their words, and the position has to be carried.
             */
            block_at: (item.blocks && item.blocks.length)
                ? item.blocks[0].at
                : -1,

            /* Where its answer goes, found among its own blocks. */
            space_at: spaceOf(item).at,
            space_kind: grid ? "table" : spaceOf(item).kind,

            kind: grid ? "grid" : item.kind,
            text: text,
            context: context,
            grid: grid,
            target: grid ? null : buildTarget(item, counts),
            answer_type: grid ? "grid" : answerType(item),
            has_answer_space: grid ? true : item.space > 0,
            answer_box: item.spaceBox,
            word_limit_min: item.wordMin,
            word_limit_max: item.wordMax
        });
    });

    return questions;
}


/* ------------------------------------------------------------------
 * Fetching
 * ------------------------------------------------------------------ */

async function fetchDocHtml(documentId, tabParam) {

    const suffix = tabParam
        ? "?tab=" + encodeURIComponent(tabParam)
        : "";

    const url =
        "https://docs.google.com/document/d/" +
        documentId +
        "/mobilebasic" +
        suffix;

    const response = await fetch(url, {
        credentials: "include"
    });

    if (response.status === 401 || response.status === 403) {

        throw new Error(
            "Chrome is signed in to a Google account that cannot " +
            "open this document. Switch account or share the doc " +
            "with yourself, then try again."
        );
    }

    if (!response.ok) {

        throw new Error(
            "Google Docs returned an error (" +
            response.status +
            ")."
        );
    }

    return await response.text();
}


function checkAccess(blocks) {

    const opening = blocks
        .filter(block => !block.empty)
        .slice(0, 12)
        .map(block => block.text)
        .join("\n");

    if (/you need access|request access/i.test(opening)) {

        throw new Error(
            "Chrome is signed in to a Google account that cannot " +
            "open this document. Switch account or share the doc " +
            "with yourself, then try again."
        );
    }

    if (/^\s*sign in\b/i.test(opening)) {

        throw new Error(
            "You are not signed in to Google in this Chrome. " +
            "Sign in, then try again."
        );
    }
}


function getDocTitle(blocks) {

    const first = blocks.find(block => !block.empty);

    return first ? first.text : "";
}


/*
 * Checks where the probe the writer just typed actually landed.
 *
 * The document is read again and the probe located: it counts only
 * when it sits exactly as many blocks past the question's anchor
 * line as the route said it would, and in a block that was empty -
 * that is, in the space the question left for its answer.
 */
async function confirmProbe(docUrl, target, probe) {

    const documentId = getDocumentId(docUrl);

    if (!documentId) {
        return false;
    }

    let blocks = null;

    try {

        const html = await fetchDocHtml(
            documentId,
            getTabParam(docUrl)
        );

        blocks = extractBlocks(html);

    } catch (error) {

        return false;
    }

    let anchorAt = -1;

    let probeAt = -1;

    for (let i = 0; i < blocks.length; i++) {

        if (blocks[i].text === target.anchor) {
            anchorAt = i;
        }

        if (blocks[i].text.indexOf(probe) !== -1) {
            probeAt = i;
        }
    }

    if (anchorAt === -1 || probeAt === -1) {
        return false;
    }

    /*
     * The probe is the only thing in that block - anything else
     * there means it landed on text that was already written.
     */
    const alone = blocks[probeAt].text.trim() === probe;

    return alone && (probeAt - anchorAt) === target.offset;
}


/*
 * Public entry point used by background.js.
 */
async function readQuestionsFromDoc(docUrl) {

    const documentId = getDocumentId(docUrl);

    if (!documentId) {
        throw new Error(
            "That link does not contain a Google Docs document id."
        );
    }

    const html = await fetchDocHtml(
        documentId,
        getTabParam(docUrl)
    );

    const blocks = extractBlocks(html);

    checkAccess(blocks);

    const questions = parseBlocks(blocks);

    if (questions.length === 0) {

        throw new Error(
            "Nothing to answer was found. Each question needs a " +
            "heading such as \"Question 1\", \"Task 1\" or " +
            "\"Activity 1\" - or, in a document with no headings " +
            "at all, a numbered line such as \"1.\"."
        );
    }

    return {
        document_id: documentId,
        url: docUrl,
        title: getDocTitle(blocks),
        questions: questions
    };
}
