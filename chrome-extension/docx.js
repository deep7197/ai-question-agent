/*
 * A Word workbook, read and answered in the browser.
 *
 * A .docx is a zip whose word/document.xml holds the text, so the
 * questions can be found and the answers written without any
 * server, any library, or Word itself. The same blocks the Google
 * Docs reader produces are produced here - a paragraph or a table
 * cell, empty ones kept, because an empty cell is the space left
 * for an answer - so the question-finding rules are shared.
 *
 * Needs a DOM parser, so it runs in the offscreen document rather
 * than the service worker.
 */

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";


/*
 * The tag name without its namespace prefix. Browsers strip the
 * prefix from localName; other XML parsers do not, and a document
 * may use any prefix it likes, so the part after the colon is what
 * can be relied on.
 */
function nameOf(element) {

    const name = element.localName || element.nodeName || "";

    const at = name.indexOf(":");

    return at === -1 ? name : name.slice(at + 1);
}


class Workbook {

    constructor() {

        this.zip = null;
        this.doc = null;
        this.blocks = [];
        this.tables = [];
    }


    async load(buffer) {

        this.zip = await unzip(buffer);

        const xml = await this.zip.read("word/document.xml");

        if (!xml) {
            throw new Error(
                "That file has no document inside it - is it really "
                + "a .docx?"
            );
        }

        this.doc = new DOMParser().parseFromString(
            new TextDecoder().decode(xml),
            "application/xml"
        );

        const failed = this.doc.querySelector("parsererror");

        if (failed) {
            throw new Error("That Word document could not be read.");
        }

        this.read();

        return this.blocks;
    }


    /* Walks the body in reading order, paragraphs and cells alike. */
    read() {

        this.blocks = [];
        this.tables = [];

        /*
         * Found by walking rather than by namespace lookup: the
         * prefix a document uses is its own business, and local
         * names are what every one of them agrees on.
         */
        const root = this.doc.documentElement;

        const body = root && Array.from(root.children).find(
            child => nameOf(child) === "body"
        );

        if (!body) {
            throw new Error("That Word document has no body.");
        }

        const walk = (parent, insideCell) => {

            for (const child of Array.from(parent.children)) {

                if (nameOf(child) === "p") {

                    if (!insideCell) {
                        this.push(textOf(child), false, child, null);
                    }

                    continue;
                }

                if (nameOf(child) === "tbl") {

                    this.table(child);
                }
            }
        };

        walk(body, false);
    }


    table(element) {

        const at = this.tables.length;

        this.tables.push(element);

        const rows = Array.from(element.children).filter(
            child => nameOf(child) === "tr"
        );

        rows.forEach((row, rowAt) => {

            const cells = Array.from(row.children).filter(
                child => nameOf(child) === "tc"
            );

            cells.forEach((cell, cellAt) => {

                /*
                 * A cell merged upwards repeats its content in Word's
                 * model; the continuation carries vMerge with no
                 * "val", and is skipped so a question spanning rows
                 * is not found twice.
                 */
                if (isMergeContinuation(cell)) {
                    return;
                }

                const paragraphs = Array.from(cell.children).filter(
                    child => nameOf(child) === "p"
                );

                const text = paragraphs
                    .map(textOf)
                    .filter(line => line.length > 0)
                    .join("\n");

                this.push(text, true, null, cell, at, rowAt, cellAt);

                Array.from(cell.children)
                    .filter(child => nameOf(child) === "tbl")
                    .forEach(inner => this.table(inner));
            });
        });
    }


    push(text, inTable, paragraph, cell, table, row, column) {

        this.blocks.push({
            at: this.blocks.length,
            text: (text || "").trim(),
            empty: !(text || "").trim(),
            inTable: !!inTable,
            table: table === undefined ? -1 : table,
            row: row === undefined ? -1 : row,
            cell: column === undefined ? -1 : column,
            element: paragraph || cell
        });
    }


    /* ------------------------------------------------------------
     * Writing
     * ------------------------------------------------------------ */

    /*
     * Puts an answer into an empty block - the box or the blank
     * line the question left for it - keeping the look of the
     * document by copying the run properties already there.
     */
    fill(block, text) {

        const paragraphs = splitParagraphs(text);

        if (block.inTable) {

            const cell = block.element;

            const existing = Array.from(cell.children).filter(
                child => nameOf(child) === "p"
            );

            const model = existing[0] || null;

            existing.forEach(one => cell.removeChild(one));

            paragraphs.forEach((part) => {
                cell.appendChild(this.paragraph(part, model));
            });

            return;
        }

        const target = block.element;

        this.setText(target, paragraphs[0]);

        let anchor = target;

        paragraphs.slice(1).forEach((part) => {

            const made = this.paragraph(part, target);

            anchor.after(made);

            anchor = made;
        });
    }


    /* No space of its own: the answer goes under the question. */
    insertAfter(block, text) {

        const paragraphs = splitParagraphs(text);

        /*
         * A question inside a box gets its answer below the box, not
         * appended inside the cell, where it would read as another
         * line of the question.
         */
        let anchor = block.inTable
            ? tableOf(block.element)
            : block.element;

        const model = block.inTable
            ? Array.from(block.element.children).find(
                child => nameOf(child) === "p"
            )
            : block.element;

        paragraphs.forEach((part) => {

            const made = this.paragraph(part, model);

            anchor.after(made);

            anchor = made;
        });
    }


    /* Fills one row of a table question. */
    fillRow(tableAt, rowLabel, cells) {

        const table = this.tables[tableAt];

        if (!table) {
            return 0;
        }

        const rows = Array.from(table.children).filter(
            child => nameOf(child) === "tr"
        );

        let written = 0;

        for (const row of rows) {

            const cellElements = Array.from(row.children).filter(
                child => nameOf(child) === "tc"
            );

            if (cellElements.length < 2) {
                continue;
            }

            if (rowKey(cellOf(cellElements[0])) !== rowKey(rowLabel)) {
                continue;
            }

            cells.forEach((value, index) => {

                const target = cellElements[index + 1];

                if (!target || !value) {
                    return;
                }

                if (cellOf(target).trim()) {
                    return;             /* already answered by hand */
                }

                const existing = Array.from(target.children).filter(
                    child => nameOf(child) === "p"
                );

                const model = existing[0] || null;

                existing.forEach(one => target.removeChild(one));

                target.appendChild(this.paragraph(value, model));

                written++;
            });

            break;
        }

        return written;
    }


    /* A new paragraph that looks like the one it is modelled on. */
    paragraph(text, model) {

        const made = this.doc.createElementNS(W, "w:p");

        if (model) {

            const properties = Array.from(model.children).find(
                child => nameOf(child) === "pPr"
            );

            if (properties) {
                made.appendChild(properties.cloneNode(true));
            }
        }

        made.appendChild(this.run(text, model));

        return made;
    }


    run(text, model) {

        const run = this.doc.createElementNS(W, "w:r");

        if (model) {

            const source = Array.from(model.children).find(
                child => nameOf(child) === "r"
            );

            const properties = source && Array.from(source.children).find(
                child => nameOf(child) === "rPr"
            );

            if (properties) {

                const copy = properties.cloneNode(true);

                /* An answer is body text, never a heading. */
                Array.from(copy.children)
                    .filter(child => nameOf(child) === "b" ||
                                     nameOf(child) === "i")
                    .forEach(child => copy.removeChild(child));

                run.appendChild(copy);
            }
        }

        const node = this.doc.createElementNS(W, "w:t");

        node.setAttribute("xml:space", "preserve");
        node.textContent = text;

        run.appendChild(node);

        return run;
    }


    setText(paragraph, text) {

        Array.from(paragraph.children)
            .filter(child => nameOf(child) === "r")
            .forEach(child => paragraph.removeChild(child));

        paragraph.appendChild(this.run(text, paragraph));
    }


    /* ------------------------------------------------------------
     * Saving
     * ------------------------------------------------------------ */

    async save() {

        const xml = new XMLSerializer().serializeToString(this.doc);

        const files = [];

        for (const name of this.zip.names()) {

            files.push([
                name,
                name === "word/document.xml"
                    ? new TextEncoder().encode(xml)
                    : await this.zip.read(name)
            ]);
        }

        return await zip(files);
    }
}


/* ---------------------------------------------------------------- */

/* The table an element sits in, walked up by name. */
function tableOf(element) {

    let node = element;

    while (node) {

        if (nameOf(node) === "tbl") {
            return node;
        }

        node = node.parentElement;
    }

    return element;
}


function textOf(paragraph) {

    let text = "";

    const walk = (node) => {

        for (const child of Array.from(node.children)) {

            if (nameOf(child) === "t") {
                text += child.textContent;
            } else if (nameOf(child) === "tab") {
                text += " ";
            } else if (nameOf(child) === "br") {
                text += "\n";
            } else {
                walk(child);
            }
        }
    };

    walk(paragraph);

    return text.trim();
}


function cellOf(cell) {

    return Array.from(cell.children)
        .filter(child => nameOf(child) === "p")
        .map(textOf)
        .filter(line => line.length > 0)
        .join("\n");
}


function isMergeContinuation(cell) {

    const properties = Array.from(cell.children).find(
        child => nameOf(child) === "tcPr"
    );

    if (!properties) {
        return false;
    }

    const merge = Array.from(properties.children).find(
        child => nameOf(child) === "vMerge"
    );

    if (!merge) {
        return false;
    }

    const value = merge.getAttribute("w:val") ||
                  merge.getAttributeNS(W, "val");

    return !value || value === "continue";
}


function splitParagraphs(text) {

    const parts = String(text || "")
        .split(/\n\s*\n+/)
        .map(part => part
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .join(" ")
            .trim())
        .filter(part => part.length > 0);

    return parts.length > 0 ? parts : [""];
}


function rowKey(text) {

    return String(text || "")
        .toLowerCase()
        .replace(/^[\s(]*[0-9]+[.)]?\s*/, "")
        .replace(/[^a-z0-9]/g, "");
}


if (typeof module !== "undefined") {
    module.exports = {
        Workbook, textOf, rowKey, splitParagraphs, nameOf
    };
}
