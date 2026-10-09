/*
 * Answering a Word workbook, start to finish, inside Chrome.
 *
 * The document is opened in the offscreen page, each question is
 * asked in the AI tab, the answer written into the space that
 * question left for it, and the finished file is downloaded.
 *
 * Nothing is uploaded anywhere: the file is read in the browser and
 * written back by the browser, and the only traffic is to the AI tab
 * the user is already signed in to.
 */

const DOCX_GRID_BATCH = 5;


async function ensureOffscreen() {

    const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"]
    });

    if (existing.length > 0) {
        return;
    }

    await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["DOM_PARSER"],
        justification:
            "Reads and writes the Word document the user chose."
    });
}


function askOffscreen(message) {

    return chrome.runtime.sendMessage(
        Object.assign({ target: "offscreen" }, message)
    );
}


/*
 * Reads the workbook and reports what is in it, without asking the
 * AI and without writing anything - so you can see the agent has
 * your file, and what it makes of it, before it does anything.
 */
async function checkWorkbook(file) {

    await ensureOffscreen();

    try {

        const opened = await askOffscreen({
            type: "docx_open",
            file: file
        });

        if (!opened || !opened.success) {
            throw new Error(
                (opened && opened.error) || "That file could not be read."
            );
        }

        return opened.result;

    } finally {

        try {
            await chrome.offscreen.closeDocument();
        } catch (error) {
            /* Already gone. */
        }
    }
}


/*
 * The whole run. Reports progress through the same job state the
 * popup already shows.
 */
async function runWorkbook(options) {

    const provider = options.provider || "claude";

    if (job.status === "running") {
        throw new Error("A job is already running.");
    }

    stopRequested = false;

    job = emptyJob();
    job.status = "running";
    job.provider = provider;
    job.docTitle = options.fileName || "your workbook";

    startKeepAlive();
    saveJob();

    let aiTab = null;

    try {

        setStep("Reading " + job.docTitle + "...");

        await ensureOffscreen();

        const opened = await askOffscreen({
            type: "docx_open",
            file: options.file
        });

        if (!opened || !opened.success) {
            throw new Error(
                (opened && opened.error) || "That file could not be read."
            );
        }

        const questions = opened.result.questions;

        job.total = questions.length;

        setStep(
            "Found " + questions.length + " question" +
            (questions.length === 1 ? "" : "s") + "."
        );

        /* 1. The AI, in this browser, already signed in. */

        setStep("Opening " + provider + "...");

        aiTab = await helperTabFor(provider);

        /* 2. Question by question. */

        for (let at = 0; at < questions.length; at++) {

            if (stopRequested) {
                break;
            }

            const question = questions[at];

            const entry = {
                number: question.number,
                question: question.text,
                answer: "",
                error: ""
            };

            setStep(
                "Question " + question.number +
                " (" + (at + 1) + " of " + questions.length + ")..."
            );

            try {

                if (question.grid) {
                    await answerGrid(aiTab, at, question, entry);
                } else {
                    await answerOne(aiTab, at, question, entry);
                }

            } catch (error) {
                entry.error = error.message;
            }

            job.results.push(entry);
            job.done = job.results.length;
            saveJob();
        }

        /* 4. Hand the finished document back. */

        setStep("Saving your answered document...");

        const saved = await askOffscreen({ type: "docx_save" });

        if (!saved || !saved.success) {
            throw new Error(
                (saved && saved.error) || "The document could not be saved."
            );
        }

        const name = (options.fileName || "workbook.docx")
            .replace(/\.docx$/i, "") + " - answered.docx";

        await chrome.downloads.download({
            url: "data:application/vnd.openxmlformats-officedocument."
                + "wordprocessingml.document;base64," + saved.file,
            filename: name,
            saveAs: true
        });

        job.wroteToDoc = true;
        job.status = stopRequested ? "stopped" : "done";

        job.step = (stopRequested ? "Stopped. " : "Finished. ") +
            job.results.filter(one => !one.error).length +
            " of " + questions.length +
            " answered. Your answered document has been downloaded.";

        saveJob();

    } catch (error) {

        job.status = "error";
        job.error = error.message;
        job.step = "Stopped: " + error.message;
        saveJob();

    } finally {

        stopKeepAlive();

        try {
            await chrome.offscreen.closeDocument();
        } catch (error) {
            /* Already gone. */
        }
    }

    return job;
}


async function answerOne(aiTab, at, question, entry) {

    const prompt = buildPrompt({
        number: question.number,
        text: question.text,
        context: question.context,
        answer_type: question.answer_type,
        word_limit_min: question.word_min,
        word_limit_max: question.word_max
    });

    entry.question = prompt;

    await chrome.tabs.update(aiTab, { active: true });

    const response = await askTab(
        aiTab,
        {
            type: "ask",
            question: prompt,
            options: { timeout: ANSWER_TIMEOUT }
        },
        { attempts: 1, delay: 0 }
    );

    if (!response || !response.success) {
        throw new Error(
            (response && response.error) || "The AI did not answer."
        );
    }

    let answer = cleanAnswer(response.answer);

    if (question.answer_type === "yesno") {
        answer = asYesNo(answer) || answer;
    }

    if (!answer) {
        throw new Error("The AI sent nothing back.");
    }

    entry.answer = answer;

    const written = await askOffscreen({
        type: "docx_answer",
        at: at,
        text: answer
    });

    if (!written || !written.success) {
        throw new Error(
            (written && written.error) || "It could not be written in."
        );
    }
}


async function answerGrid(aiTab, at, question, entry) {

    const rows = question.grid.rows;

    const headers = question.grid.headers;

    const found = {};

    for (let start = 0; start < rows.length; start += DOCX_GRID_BATCH) {

        if (stopRequested) {
            break;
        }

        const batch = rows.slice(start, start + DOCX_GRID_BATCH);

        setStep(
            "Question " + question.number + " - rows " +
            (start + 1) + " to " + (start + batch.length) +
            " of " + rows.length + "..."
        );

        await chrome.tabs.update(aiTab, { active: true });

        try {

            const response = await askTab(
                aiTab,
                {
                    type: "ask",
                    question: buildGridPrompt(
                        {
                            number: question.number,
                            text: question.text,
                            context: question.context,
                            grid: { headers: headers, rows: rows }
                        },
                        batch
                    ),
                    options: { timeout: ANSWER_TIMEOUT }
                },
                { attempts: 1, delay: 0 }
            );

            if (response && response.success) {

                const parsed = parseGridReply(
                    response.answer, batch, headers
                );

                Object.keys(parsed).forEach((key) => {
                    found[key] = parsed[key];
                });
            }

        } catch (error) {
            /* Row asked again below. */
        }
    }

    const answered = rows
        .filter(row => found[rowKey(row)])
        .map(row => ({ row: row, cells: found[rowKey(row)] }));

    if (answered.length === 0) {
        throw new Error("The AI did not fill in the table.");
    }

    const written = await askOffscreen({
        type: "docx_grid",
        at: at,
        rows: answered
    });

    if (!written || !written.success) {
        throw new Error(
            (written && written.error) || "The table could not be filled."
        );
    }

    entry.answer = answered
        .map(row => row.row + " - " + row.cells.join(" / "))
        .join("\n");
}
