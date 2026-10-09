/*
 * AI Question Agent - background service worker
 *
 * Runs the whole job inside the browser:
 *
 *   Google Doc  ->  questions  ->  AI tab  ->  answers
 *
 * The Python agent is OPTIONAL. If it is not running,
 * everything still works.
 */

importScripts(
    "doc-reader.js", "doc-writer.js", "docx-job.js"
);


const PYTHON_WS_URL = "ws://127.0.0.1:8765";

const PROVIDER_URLS = {
    claude: "https://claude.ai/new",
    chatgpt: "https://chatgpt.com/",
    gemini: "https://gemini.google.com/app"
};

const PROVIDER_FILES = {
    claude: [
        "providers/base.js", "providers/claude.js", "content.js"
    ],
    chatgpt: [
        "providers/base.js", "providers/chatgpt.js", "content.js"
    ],
    gemini: [
        "providers/base.js", "providers/gemini.js", "content.js"
    ]
};

const DOCS_FILES = [
    "providers/base.js", "providers/google-docs-find.js", "content.js"
];

const ANSWER_TIMEOUT = 180000;

const GRAMMAR_TIMEOUT = 120000;


/* ------------------------------------------------------------------
 * Job state
 * ------------------------------------------------------------------ */

let job = emptyJob();

let stopRequested = false;

let keepAliveTimer = null;


function emptyJob() {

    return {
        status: "idle",
        step: "",
        provider: "",
        docUrl: "",
        docTitle: "",
        total: 0,
        done: 0,
        results: [],
        error: "",
        wroteToDoc: false,
        writeError: "",
        resumed: false,
        placeNotes: []
    };
}


function saveJob() {

    chrome.storage.local.set({
        job: job
    });

    chrome.runtime
        .sendMessage({
            type: "job_update",
            job: job
        })
        .catch(() => {
            /* Popup is closed. Not an error. */
        });
}


function setStep(text) {

    job.step = text;

    console.log("[Agent]", text);

    saveJob();
}


/* ------------------------------------------------------------------
 * Keep the service worker awake while a job runs
 * ------------------------------------------------------------------ */

function startKeepAlive() {

    if (keepAliveTimer) {
        return;
    }

    keepAliveTimer = setInterval(() => {

        chrome.runtime.getPlatformInfo(() => {
            /* Touching a chrome API resets the idle timer. */
        });

    }, 20000);
}


function stopKeepAlive() {

    if (!keepAliveTimer) {
        return;
    }

    clearInterval(keepAliveTimer);

    keepAliveTimer = null;
}


/* ------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------ */

function wait(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}


function parseDocUrl(url) {

    if (!url) {
        throw new Error("Google Docs URL is empty.");
    }

    let parsed;

    try {
        parsed = new URL(url);
    } catch (error) {
        throw new Error("That is not a valid link.");
    }

    if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== "docs.google.com" ||
        !parsed.pathname.startsWith("/document/")
    ) {
        throw new Error(
            "The link must be a Google Docs document link."
        );
    }

    return parsed;
}


async function waitForTabLoad(tabId, timeout = 60000) {

    const started = Date.now();

    while (Date.now() - started < timeout) {

        let tab;

        try {
            tab = await chrome.tabs.get(tabId);
        } catch (error) {
            throw new Error("The tab was closed.");
        }

        if (tab.status === "complete") {
            return tab;
        }

        await wait(500);
    }

    throw new Error("The page took too long to load.");
}


/*
 * Looks across every tab the user already has open, so a
 * conversation or document they already have on screen is used as-is
 * instead of a duplicate being opened next to it. Chrome itself has
 * to already be running for any of this to run at all - an extension
 * cannot start the browser it lives inside - but this is the part
 * that actually is automatic: reuse what's open, open it only when
 * nothing matches.
 */
async function findOpenTab(matchesUrl) {

    const tabs = await chrome.tabs.query({});

    const match = tabs.find((tab) => tab.url && matchesUrl(tab.url));

    return match ? match.id : null;
}


async function injectScripts(tabId, files) {

    try {

        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: files
        });

    } catch (error) {

        console.warn(
            "Injection skipped:",
            error.message
        );
    }
}


/*
 * Talks to a content script, retrying while the page
 * is still starting up.
 */
async function askTab(tabId, message, options = {}) {

    const attempts = options.attempts ?? 20;

    const delay = options.delay ?? 1000;

    const files = options.files;

    let lastError = "The page did not respond.";

    for (let i = 0; i < attempts; i++) {

        if (stopRequested) {
            throw new Error("Stopped.");
        }

        try {

            const response =
                await chrome.tabs.sendMessage(tabId, message);

            if (response) {
                return response;
            }

            lastError = "The page sent an empty reply.";

        } catch (error) {

            lastError = error.message;

            /*
             * No content script yet. Inject it once and
             * keep retrying.
             */
            if (files && i === 1) {
                await injectScripts(tabId, files);
            }
        }

        await wait(delay);
    }

    throw new Error(lastError);
}


/*
 * Chat models pad answers with markdown and conversational filler.
 * None of that belongs in a written document, so it is stripped
 * out before the answer is pasted in.
 */

const FILLER_LINE =
    /^(certainly|sure|of course|absolutely|great question|here('s| is| are)\b|i hope this helps|hope that helps|let me know if|would you like me to|feel free to ask|in summary|in conclusion)/i;

const LIST_LINE = /^(?:[-*•]|\d+[.)])\s+/;


function cleanAnswer(text) {

    if (!text) {
        return "";
    }

    let out = text;

    /* Code fences and inline code ticks. */
    out = out.replace(/```[a-z]*\n?/gi, "");
    out = out.replace(/`/g, "");

    /* Bold, italic and heading markers. */
    out = out.replace(/\*\*(.+?)\*\*/g, "$1");
    out = out.replace(/__(.+?)__/g, "$1");
    out = out.replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$)/g, "$1$2");
    out = out.replace(/^#{1,6}\s*/gm, "");

    /* Horizontal rules. */
    out = out.replace(/^\s*([-*_]\s*){3,}$/gm, "");

    /*
     * Clean each paragraph on its own and rejoin with a blank line
     * between them. Splitting on blank lines is what keeps the
     * answer's paragraph structure instead of collapsing it into a
     * single-spaced wall of lines. Real punctuation - em-dashes
     * included - is left untouched.
     */
    const paragraphs = out
        .split(/\n\s*\n+/)
        .map((para) => {

            const lines = para
                .split("\n")
                .map(line => line.trim())
                .filter(line => line.length > 0 && !FILLER_LINE.test(line));

            if (lines.length === 0) {
                return "";
            }

            /*
             * A question that asks to list, name or identify several
             * things is genuinely answered as a list - joining its
             * lines into one run-on sentence, which is right for a
             * wrapped paragraph, would instead ruin it. So a
             * paragraph that is mostly list lines keeps its line
             * breaks and its markers; anything else is still joined
             * into flowing prose.
             */
            const marked = lines.filter(line => LIST_LINE.test(line)).length;

            if (marked >= 2 && marked >= lines.length - 1) {
                return lines.join("\n");
            }

            return lines
                .map(line => line
                    .replace(/^[-*•]\s+/, "")
                    .replace(/^\d+[.)]\s+/, ""))
                .join(" ")
                .replace(/[ \t]{2,}/g, " ")
                .trim();
        })
        .filter(para => para.length > 0);

    return paragraphs.join("\n\n").trim();
}


/*
 * The label is used as-is when it names itself - "Task 1",
 * "Activity 2" - and read as a question number otherwise.
 */
/*
 * A Yes / No question gets Yes or No, whatever else the AI said
 * around it.
 */
function asYesNo(text) {

    const match = /\b(yes|no)\b/i.exec(String(text || ""));

    if (!match) {
        return "";
    }

    return match[1].toLowerCase() === "yes" ? "Yes" : "No";
}


function questionHeading(question) {

    return /^[0-9(]/.test(question.number)
        ? "Question " + question.number
        : question.number;
}


function buildPrompt(question) {

    const parts = [];

    if (question.context) {

        parts.push("Case study:\n" + question.context);
    }

    parts.push(
        questionHeading(question) +
        ". " +
        (question.text || "")
    );

    /*
     * Some questions want one word back, not an essay: the document
     * offers Yes and No boxes rather than a space to write in.
     */
    if (question.answer_type === "yesno") {

        parts.push(
            "Answer with one word only - either Yes or No. " +
            "Do not explain and do not add anything else."
        );

        return parts.join("\n\n").trim();
    }

    if (question.word_limit_min && question.word_limit_max) {

        parts.push(
            "Answer in " +
            question.word_limit_min +
            "-" +
            question.word_limit_max +
            " words. Stay inside that range."
        );
    }

    /*
     * The answer goes straight into a document, so ask for whatever
     * shape the question actually calls for, not a chat reply.
     */
    parts.push(
        "Read the question and answer in whatever shape it " +
        "actually calls for - a short phrase or one sentence for a " +
        "direct factual question, a list only if the question " +
        "itself asks you to list, name or identify more than one " +
        "thing, a full explanatory answer for one that asks you to " +
        "explain, describe, discuss, compare or evaluate. " +
        "Whichever it is, write it in plain text, Australian " +
        "English - no headings, no bold text, no markdown. Do not " +
        "restate the question and do not add any opening or " +
        "closing remarks - give the answer only."
    );

    return parts.join("\n\n").trim();
}


/* ------------------------------------------------------------------
 * Grid questions
 *
 * Some questions are answered in a table the document provides: a
 * header row, then a row per item with empty cells beside it. Each
 * row needs its own short answer per column, so the rows are asked
 * in small batches and the reply is split back into cells.
 * ------------------------------------------------------------------ */

const GRID_BATCH = 5;


/* "1. Cements" and "Cements" are the same row. */
function rowKey(text) {

    return String(text || "")
        .toLowerCase()
        .replace(/^[\s(]*[0-9]+[.)]?\s*/, "")
        .replace(/[^a-z0-9]/g, "");
}


function buildGridPrompt(question, rows) {

    const headers = question.grid.headers;

    const parts = [];

    if (question.context) {
        parts.push("Case study:\n" + question.context);
    }

    parts.push(questionHeading(question) + ". " + (question.text || ""));

    parts.push(
        "Answer for each item below, covering every column: " +
        headers.join(", ") + "."
    );

    parts.push(
        "Reply with one line per item and nothing else, in exactly " +
        "this format:\n" +
        "item | " +
        headers.map(head => head + ": your answer").join(" | ")
    );

    parts.push("Items:\n" + rows.join("\n"));

    parts.push(
        "Keep each column to one or two plain sentences in " +
        "Australian English. No markdown, no bullet points, and do " +
        "not add any other lines."
    );

    return parts.join("\n\n");
}


/*
 * Splits "1. Cements | Properties: ... | Applications: ..." back
 * into cells, and matches it to the row it belongs to. Anything
 * that cannot be matched is simply left out, so a stray line from
 * the AI never lands in the wrong row.
 */
function parseGridReply(reply, rows, headers) {

    const wanted = {};

    rows.forEach((row) => {
        wanted[rowKey(row)] = row;
    });

    const found = {};

    String(reply || "")
        .split("\n")
        .forEach((line) => {

            const clean = line
                .replace(/^\s*[-*\u2022]\s*/, "")
                .trim();

            if (clean.indexOf("|") === -1) {
                return;
            }

            const parts = clean.split("|").map(part => part.trim());

            const key = rowKey(parts[0]);

            if (!wanted[key] || found[key]) {
                return;
            }

            const cells = [];

            for (let i = 0; i < headers.length; i++) {

                const raw = parts[i + 1] || "";

                const head = headers[i]
                    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

                cells.push(
                    cleanAnswer(
                        raw.replace(
                            new RegExp("^\\s*" + head + "\\s*[:\\-]\\s*", "i"),
                            ""
                        )
                    )
                );
            }

            if (cells.some(cell => cell.length > 0)) {
                found[key] = cells;
            }
        });

    return found;
}


/*
 * Asks every row of a grid question and fills entry.grid. Returns
 * the same shape askTab does, so the caller treats both kinds of
 * question alike.
 */
async function askGrid(aiTabId, question, entry) {

    const headers = question.grid.headers;

    const rows = question.grid.rows;

    const answers = {};

    for (let start = 0; start < rows.length; start += GRID_BATCH) {

        if (stopRequested) {
            break;
        }

        const batch = rows.slice(start, start + GRID_BATCH);

        setStep(
            "Asking question " +
            question.number +
            " - rows " +
            (start + 1) +
            " to " +
            Math.min(start + batch.length, rows.length) +
            " of " +
            rows.length +
            "..."
        );

        let reply = null;

        try {

            reply = await askTab(
                aiTabId,
                {
                    type: "ask",
                    question: buildGridPrompt(question, batch),
                    options: { timeout: ANSWER_TIMEOUT }
                },
                { attempts: 1, delay: 0 }
            );

        } catch (error) {

            reply = null;
        }

        if (reply && reply.success) {

            const parsed = parseGridReply(reply.answer, batch, headers);

            Object.keys(parsed).forEach((key) => {
                answers[key] = parsed[key];
            });
        }

        await wait(1000);
    }

    /* One more go at any row the AI skipped or mangled. */
    const missed = rows.filter(row => !answers[rowKey(row)]);

    if (missed.length > 0 && !stopRequested) {

        setStep(
            "Asking question " +
            question.number +
            " - " +
            missed.length +
            " row" +
            (missed.length === 1 ? "" : "s") +
            " again..."
        );

        for (let start = 0; start < missed.length; start += GRID_BATCH) {

            if (stopRequested) {
                break;
            }

            const batch = missed.slice(start, start + GRID_BATCH);

            try {

                const reply = await askTab(
                    aiTabId,
                    {
                        type: "ask",
                        question: buildGridPrompt(question, batch),
                        options: { timeout: ANSWER_TIMEOUT }
                    },
                    { attempts: 1, delay: 0 }
                );

                if (reply && reply.success) {

                    const parsed =
                        parseGridReply(reply.answer, batch, headers);

                    Object.keys(parsed).forEach((key) => {
                        answers[key] = parsed[key];
                    });
                }

            } catch (error) {
                /* Leave that row empty rather than guess. */
            }

            await wait(1000);
        }
    }

    entry.grid = rows
        .filter(row => answers[rowKey(row)])
        .map(row => ({
            row: row,
            cells: answers[rowKey(row)]
        }));

    if (entry.grid.length === 0) {

        return {
            success: false,
            error: "The AI did not fill in the table."
        };
    }

    /* A readable copy, for the popup and for Copy all answers. */
    const lines = entry.grid.map((item) => {

        return item.row + " - " + item.cells
            .map((cell, i) => headers[i] + ": " + cell)
            .join(" ");
    });

    return {
        success: true,
        grid: true,
        answer: lines.join("\n")
    };
}


/* ------------------------------------------------------------------
 * The job
 * ------------------------------------------------------------------ */

/*
 * The answer placer.
 *
 * A small Google Apps Script, deployed once by the user as a web
 * app, that puts each answer into the blank box belonging to its
 * question - in any document in their Google account. One
 * deployment covers every workbook, so there is nothing to paste
 * into each new document and no menu to click afterwards.
 */
function parsePlacerUrl(url) {

    const text = String(url || "").trim();

    if (!text) {
        return "";
    }

    let parsed = null;

    try {
        parsed = new URL(text);
    } catch (error) {
        parsed = null;
    }

    if (
        !parsed ||
        parsed.hostname !== "script.google.com" ||
        !/\/exec\/?$/.test(parsed.pathname)
    ) {

        throw new Error(
            "The answer placer link must be the web app link from " +
            "Apps Script - it starts with " +
            "https://script.google.com/macros/s/ and ends with /exec."
        );
    }

    return parsed.toString();
}


async function placeAnswer(placerUrl, documentId, entry) {

    const response = await fetch(placerUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
            docId: documentId,
            answers: [
                {
                    label: entry.number,
                    grid: entry.grid || null,
                    text: entry.error
                        ? "[Not answered: " + entry.error + "]"
                        : entry.answer
                }
            ]
        })
    });

    if (!response.ok) {

        throw new Error(
            "The answer placer replied with an error (" +
            response.status +
            "). Check the web app is deployed, and that Chrome is " +
            "signed in to the Google account that owns it."
        );
    }

    const text = await response.text();

    /*
     * A sign-in page instead of the script's reply means the
     * deployment is not reachable as the signed-in user.
     */
    if (/<html/i.test(text.slice(0, 200))) {

        throw new Error(
            "The answer placer link opened a Google page instead of " +
            "running. Re-deploy it (Deploy -> Manage deployments -> " +
            "edit -> Version: New version) and check \"Who has " +
            "access\"."
        );
    }

    let result = null;

    try {
        result = JSON.parse(text);
    } catch (error) {
        result = null;
    }

    if (!result) {

        throw new Error(
            "The answer placer did not reply properly. Re-deploy it " +
            "and make sure \"Who has access\" lets you run it."
        );
    }

    if (!result.ok) {
        throw new Error(result.error || "The answer placer failed.");
    }

    return result;
}


async function runJob(
    docUrl,
    provider,
    writeToDoc,
    placerUrl
) {

    if (job.status === "running") {
        throw new Error("A job is already running.");
    }

    parseDocUrl(docUrl);

    let placer = parsePlacerUrl(placerUrl);

    if (!PROVIDER_URLS[provider]) {
        throw new Error("Please choose an AI.");
    }

    stopRequested = false;

    /*
     * Resume a run that was stopped or errored on the same Doc with
     * the same AI, as long as it produced at least one real answer.
     * The answers it already has - and, when writing to the Doc,
     * already pasted in - are carried over so they are neither asked
     * again nor written twice. A finished ("done") job is not
     * resumed: running it again is a deliberate fresh start.
     */
    const previous = job;

    const resumable =
        previous &&
        previous.docUrl === docUrl &&
        previous.provider === provider &&
        (previous.status === "stopped" || previous.status === "error") &&
        Array.isArray(previous.results) &&
        previous.results.some(r => r.answer && !r.error);

    job = emptyJob();

    job.status = "running";
    job.provider = provider;
    job.docUrl = docUrl;

    if (resumable) {

        /* Keep only the entries that actually got answered. */
        job.results = previous.results.filter(r => r.answer && !r.error);
        job.done = job.results.length;
        job.wroteToDoc = previous.wroteToDoc;
        job.resumed = true;
    }

    startKeepAlive();

    saveJob();

    let aiTab = null;

    let writer = null;

    /*
     * With the answer placer, the Doc is not typed into - it is
     * edited by the script. It is still opened, so the answers can
     * be watched arriving in their boxes.
     */
    let docTab = null;

    try {

        /*
         * 1. Read the questions --------------------------------
         *
         * Straight from the document's own text view. The Doc is
         * never opened in a tab - its on-screen text lives in a
         * <canvas> and cannot be read from the page.
         */

        setStep("Reading your Google Doc...");

        const doc = await readQuestionsFromDoc(docUrl);

        const questions = doc.questions;

        sendToPython({
            type: "google_doc_read",
            url: docUrl,
            title: doc.title,
            questions: questions.length
        });

        job.docTitle = doc.title || "";
        job.total = questions.length;

        setStep(
            "Found " +
            questions.length +
            " question" +
            (questions.length === 1 ? "" : "s") +
            "."
        );


        /* 2. Open the AI --------------------------------------- */

        setStep("Opening " + provider + "...");

        aiTab = await chrome.tabs.create({
            url: PROVIDER_URLS[provider],
            active: true
        });

        await waitForTabLoad(aiTab.id);

        setStep("Waiting for " + provider + " to be ready...");

        let ready = false;

        for (let i = 0; i < 30; i++) {

            if (stopRequested) {
                throw new Error("Stopped.");
            }

            let status = null;

            try {

                status = await askTab(
                    aiTab.id,
                    { type: "get_status" },
                    {
                        attempts: 1,
                        delay: 0,
                        files: PROVIDER_FILES[provider]
                    }
                );

            } catch (error) {
                status = null;
            }

            if (
                status &&
                status.status &&
                status.status.inputFound
            ) {
                ready = true;
                break;
            }

            if (i === 1) {
                await injectScripts(
                    aiTab.id,
                    PROVIDER_FILES[provider]
                );
            }

            await wait(2000);
        }

        if (!ready) {

            throw new Error(
                provider +
                " is not ready. Please make sure you are " +
                "signed in on that tab, then run again."
            );
        }


        /* 3. Open the Doc ready for writing -------------------- */

        if (writeToDoc && placer) {

            setStep("Opening your Google Doc...");

            try {

                const opened = await chrome.tabs.create({
                    url: docUrl,
                    active: true
                });

                docTab = opened.id;

                await waitForTabLoad(docTab);

            } catch (error) {

                /* Not fatal - placing the answers does not need it. */
                docTab = null;
            }

            setStep(
                "Answers will go straight into their boxes as they " +
                "arrive. Watch the Doc."
            );

        } else if (writeToDoc) {

            setStep(
                "Opening your Google Doc to write into. Without an " +
                "answer placer link, answers are collected in an " +
                "\"AI Answers\" section at the end."
            );

            try {

                writer = new DocWriter(docUrl);

                await writer.open();

                await injectScripts(writer.tabId, DOCS_FILES);

                /*
                 * The "AI Answers" heading is only written if an
                 * answer actually has to go to the end, so a run
                 * where every answer reaches its own box leaves no
                 * leftover section behind.
                 */
                writer.headingWritten = job.resumed === true;

            } catch (error) {

                job.writeError = error.message;

                writer = null;

                console.error(
                    "[Agent] Could not open the Doc for writing:",
                    error.message
                );
            }
        }


        /* 4. Ask each question, pasting as you go -------------- */

        /*
         * When resuming, these question numbers already have a good
         * answer (and, if writing, are already in the Doc), so they
         * are skipped rather than asked and pasted a second time.
         */
        const answered = new Set(
            job.results.map(r => String(r.number))
        );

        if (job.resumed) {

            setStep(
                "Resuming - " +
                answered.size +
                " answer" +
                (answered.size === 1 ? "" : "s") +
                " already done, carrying on from there..."
            );
        }

        for (let i = 0; i < questions.length; i++) {

            if (stopRequested) {
                break;
            }

            const question = questions[i];

            const questionNumber = String(question.number || i + 1);

            if (answered.has(questionNumber)) {
                /* Already answered on the earlier run. */
                continue;
            }

            setStep(
                "Asking question " +
                (question.number || i + 1) +
                " of " +
                questions.length +
                "..."
            );

            const prompt = buildPrompt(question);

            const entry = {
                number: questionNumber,
                question: prompt,
                answer: "",
                error: "",
                target: question.target || null
            };

            try {

                if (writer || docTab) {

                    await chrome.tabs.update(
                        aiTab.id,
                        { active: true }
                    );

                    await wait(400);
                }

                const isGrid =
                    question.kind === "grid" &&
                    question.grid &&
                    question.grid.rows.length > 0;

                const response = isGrid
                    ? await askGrid(aiTab.id, question, entry)
                    : await askTab(
                        aiTab.id,
                        {
                            type: "ask",
                            question: prompt,
                            options: { timeout: ANSWER_TIMEOUT }
                        },
                        { attempts: 1, delay: 0 }
                    );

                if (response.success) {

                    /* A grid's cells are already cleaned, one by one. */
                    entry.answer = response.grid
                        ? response.answer
                        : cleanAnswer(response.answer);

                    if (question.answer_type === "yesno") {

                        entry.answer =
                            asYesNo(entry.answer) || entry.answer;
                    }

                    sendToPython({
                        type: "answer",
                        provider: provider,
                        request_id: entry.number,
                        answer: entry.answer
                    });

                } else {

                    entry.error =
                        response.error ||
                        "The AI did not answer.";
                }

            } catch (error) {

                entry.error = error.message;
            }

            job.results.push(entry);

            job.done = job.results.length;

            saveJob();

            /*
             * Paste this answer into the Doc before moving on, so
             * the work done so far is never lost.
             */
            if (writeToDoc && placer) {

                setStep(
                    "Putting answer " +
                    entry.number +
                    " into its box in your Doc..."
                );

                try {

                    const placement = await placeAnswer(
                        placer,
                        doc.document_id,
                        entry
                    );

                    job.wroteToDoc = true;

                    if (placement.missing && placement.missing.length) {

                        job.writeError =
                            "No box was found in the Doc for " +
                            "answer " + entry.number + ".";
                    }

                    /*
                     * Bring the Doc forward so the answer can be
                     * seen appearing in its box. Google Docs picks
                     * the change up on its own within a second.
                     */
                    if (docTab) {

                        try {

                            await chrome.tabs.update(
                                docTab,
                                { active: true }
                            );

                            await wait(1200);

                        } catch (error) {
                            /* Tab closed - carry on placing. */
                            docTab = null;
                        }
                    }

                } catch (error) {

                    job.writeError = error.message;

                    console.error(
                        "[Agent] Placing answer " +
                        entry.number +
                        " failed:",
                        error.message
                    );

                    /*
                     * The placer is not working. Rather than lose
                     * the answers, switch over to typing them into
                     * the Doc for the rest of the run - they end up
                     * in an "AI Answers" section instead of in the
                     * boxes, which the Apps Script menu can then
                     * move for you.
                     */
                    placer = "";

                    try {

                        setStep(
                            "The answer placer failed (" +
                            error.message +
                            ") - typing the answers into the Doc " +
                            "instead..."
                        );

                        writer = new DocWriter(docUrl);

                        await writer.open();

                        await writer.writeHeading(provider);

                        await writer.writeAnswer(entry);

                        job.wroteToDoc = true;

                    } catch (fallbackError) {

                        job.writeError =
                            error.message +
                            " Typing into the Doc also failed: " +
                            fallbackError.message;

                        writer = null;
                    }
                }

            } else if (writer) {

                setStep(
                    "Writing answer " +
                    entry.number +
                    " into your Doc..."
                );

                try {

                    /*
                     * Into the space the question leaves for it
                     * when there is a route the writer can check;
                     * otherwise at the end of the document, where
                     * nothing can be damaged.
                     */
                    let inPlace = false;

                    if (entry.target && !entry.grid && entry.answer) {

                        try {

                            await writer.writeInPlace(
                                entry,
                                entry.target,
                                (target, probe) => confirmProbe(
                                    docUrl,
                                    target,
                                    probe
                                )
                            );

                            inPlace = true;

                        } catch (error) {

                            job.placeNotes = (job.placeNotes || [])
                                .concat(
                                    entry.number + ": " + error.message
                                );

                            console.warn(
                                "[Agent] " +
                                entry.number +
                                " went to the end of the Doc: " +
                                error.message
                            );
                        }
                    }

                    if (!inPlace) {

                        if (!writer.headingWritten) {

                            await writer.writeHeading(provider);

                            writer.headingWritten = true;
                        }

                        await writer.writeAnswer(entry);
                    }

                    job.wroteToDoc = true;

                } catch (error) {

                    job.writeError = error.message;

                    console.error(
                        "[Agent] Writing answer " +
                        entry.number +
                        " failed:",
                        error.message
                    );

                    /* Stop trying to write; keep answering. */
                    await writer.close();

                    writer = null;
                }
            }

            await wait(1200);
        }


        /*
         * Put the results back into the document's question order.
         * On a resume the carried-over answers are seeded first and
         * the freshly asked ones appended, so without this they can
         * appear out of sequence in the popup list.
         */
        const questionOrder = new Map(
            questions.map((q, i) => [String(q.number || i + 1), i])
        );

        job.results.sort((a, b) => {

            const ai = questionOrder.has(String(a.number))
                ? questionOrder.get(String(a.number))
                : Number.MAX_SAFE_INTEGER;

            const bi = questionOrder.has(String(b.number))
                ? questionOrder.get(String(b.number))
                : Number.MAX_SAFE_INTEGER;

            return ai - bi;
        });


        /* 5. Finish -------------------------------------------- */

        job.status = stopRequested ? "stopped" : "done";

        if (stopRequested) {

            job.step = "Stopped.";

        } else if (job.wroteToDoc && !job.writeError) {

            const stray = (job.placeNotes || []).length;

            job.step = stray === 0
                ? "Finished. Every answer went into the space under " +
                  "its own question."
                : "Finished. " +
                  stray +
                  " answer" +
                  (stray === 1 ? "" : "s") +
                  " could not reach a space and went to the " +
                  "\"AI Answers\" section at the end instead: " +
                  job.placeNotes.join("; ");

        } else if (job.wroteToDoc && job.writeError) {

            job.step =
                "Finished, but writing stopped part way: " +
                job.writeError +
                " The answers below are complete - use " +
                "Copy all answers for the rest.";

        } else if (job.writeError) {

            job.step =
                "Answers are ready below, but writing into the " +
                "Doc failed: " +
                job.writeError +
                " Use Copy all answers instead.";

        } else {

            job.step = "Finished. All answers are below.";
        }

        saveJob();

    } catch (error) {

        job.status = "error";

        job.error = error.message;

        job.step = "Stopped: " + error.message;

        saveJob();

    } finally {

        if (writer) {
            await writer.close();
        }

        stopKeepAlive();
    }

    return job;
}


/*
 * A tab kept open for the Word agent, so a run of twenty questions
 * uses one conversation rather than twenty.
 */
let helperTab = null;


async function askOneQuestion(provider, question, requestId) {

    if (!PROVIDER_URLS[provider]) {

        sendToPython({
            type: "answer",
            request_id: requestId,
            error: "Unknown AI: " + provider
        });

        return;
    }

    try {

        const tabId = await helperTabFor(provider);

        await chrome.tabs.update(tabId, { active: true });

        await wait(300);

        const response = await askTab(
            tabId,
            {
                type: "ask",
                question: question,
                options: { timeout: ANSWER_TIMEOUT }
            },
            { attempts: 1, delay: 0 }
        );

        if (!response || !response.success) {

            throw new Error(
                (response && response.error) ||
                "The AI did not answer."
            );
        }

        sendToPython({
            type: "answer",
            provider: provider,
            request_id: requestId,
            answer: cleanAnswer(response.answer)
        });

    } catch (error) {

        sendToPython({
            type: "answer",
            request_id: requestId,
            error: error.message
        });
    }
}


/* Opens the AI once, then reuses that tab for every question. */
async function helperTabFor(provider) {

    if (helperTab !== null) {

        try {

            await chrome.tabs.get(helperTab);

            return helperTab;

        } catch (error) {
            helperTab = null;
        }
    }

    const host = new URL(PROVIDER_URLS[provider]).hostname;

    const already = await findOpenTab((url) => {

        try {
            return new URL(url).hostname === host;
        } catch (error) {
            return false;
        }
    });

    helperTab = already !== null
        ? already
        : (await chrome.tabs.create({
            url: PROVIDER_URLS[provider],
            active: true
        })).id;

    await waitForTabLoad(helperTab);

    for (let i = 0; i < 30; i++) {

        let status = null;

        try {

            status = await askTab(
                helperTab,
                { type: "get_status" },
                {
                    attempts: 1,
                    delay: 0,
                    files: PROVIDER_FILES[provider]
                }
            );

        } catch (error) {
            status = null;
        }

        if (status && status.status && status.status.inputFound) {
            return helperTab;
        }

        if (i === 1) {
            await injectScripts(helperTab, PROVIDER_FILES[provider]);
        }

        await wait(2000);
    }

    throw new Error(
        provider + " is not ready - make sure you are signed in."
    );
}


/* ------------------------------------------------------------------
 * Optional Python bridge
 * ------------------------------------------------------------------ */

let pythonSocket = null;

let pythonRetryDelay = 5000;

/*
 * Always on: this extension exists to lend the agent the browser,
 * so it keeps trying to reach it in the background - nothing to
 * install beyond the extension itself, and nothing to switch on.
 *
 * When the agent is not running yet, the attempt is refused and
 * Chrome logs "WebSocket connection ... failed" - but only into
 * this service worker's own console, which nobody but a developer
 * ever opens. It is never shown to the user, and it does not mean
 * anything is broken; it means the agent has not started yet. The
 * retry below backs off so it happens less and less often while
 * that stays true.
 */
function connectToPython() {

    if (
        pythonSocket &&
        pythonSocket.readyState === WebSocket.OPEN
    ) {
        return;
    }

    try {

        pythonSocket = new WebSocket(PYTHON_WS_URL);

        pythonSocket.onopen = () => {

            console.log("[Agent] Python agent connected.");

            pythonRetryDelay = 5000;

            pythonSocket.send(
                JSON.stringify({
                    type: "hello",
                    provider: "chrome-extension"
                })
            );
        };

        pythonSocket.onmessage = (event) => {

            try {

                handlePythonMessage(
                    JSON.parse(event.data)
                );

            } catch (error) {

                console.warn("[Agent] Bad Python message.");
            }
        };

        pythonSocket.onerror = () => {
            /* Python is optional. Stay quiet. */
        };

        pythonSocket.onclose = () => {

            pythonSocket = null;

            /*
             * Backs off, but only up to 10 seconds - Chrome is the
             * one making the connection, so if the wait grew long
             * while nothing was running, starting the agent would
             * otherwise have to sit and wait for Chrome to get
             * around to trying again. Capped this low, the agent's
             * own short wait when it starts is always long enough
             * to catch the next attempt.
             */
            pythonRetryDelay =
                Math.min(pythonRetryDelay * 2, 10000);

            setTimeout(connectToPython, pythonRetryDelay);
        };

    } catch (error) {

        setTimeout(connectToPython, pythonRetryDelay);
    }
}


function sendToPython(message) {

    if (
        pythonSocket &&
        pythonSocket.readyState === WebSocket.OPEN
    ) {

        pythonSocket.send(JSON.stringify(message));

        return true;
    }

    return false;
}


async function handlePythonMessage(message) {

    if (!message) {
        return;
    }

    switch (message.type) {

        case "hello_response":

            /* The Word agent said hello back. Nothing to do. */

            break;

        case "ping":

            sendToPython({ type: "pong" });

            break;

        case "get_status":

            sendToPython({
                type: "status_response",
                connected: true,
                job: job
            });

            break;

        /*
         * Asked by the Word agent running on this computer.
         *
         * Google Docs is not involved: the agent has the questions
         * already, out of a .docx, and only needs the AI answered in
         * this browser - the one that is already signed in. The
         * answer goes straight back down the same connection.
         */
        case "ask_one":

            askOneQuestion(
                message.provider || "claude",
                message.question || "",
                message.request_id || null
            );

            break;

        case "run_job":

            runJob(
                message.url,
                message.provider || "claude",
                message.writeToDoc !== false,
                message.placerUrl || ""
            ).catch((error) => {

                sendToPython({
                    type: "error",
                    request_id: message.request_id || null,
                    error: error.message
                });
            });

            break;

        case "open_google_doc":

            try {

                parseDocUrl(message.url);

                await chrome.tabs.create({
                    url: message.url,
                    active: true
                });

            } catch (error) {

                sendToPython({
                    type: "error",
                    request_id: message.request_id || null,
                    error: error.message
                });
            }

            break;

        default:

            console.log("[Agent] Unknown Python message.");

            break;
    }
}


/* ------------------------------------------------------------------
 * Popup messages
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {

        if (!message) {

            sendResponse({
                success: false,
                error: "Empty message."
            });

            return;
        }

        /*
         * What the popup shows: whether the agent is connected right
         * now. There is nothing to switch on any more - the link is
         * always live.
         */
        if (message.type === "bridge_status") {

            sendResponse({
                success: true,
                enabled: true,
                connected: !!(
                    pythonSocket &&
                    pythonSocket.readyState === WebSocket.OPEN
                ),
                busy: job.status === "running",
                step: job.step || ""
            });

            return;
        }

        /* Opens a site so it can be signed in to, once. */
        if (message.type === "open_site") {

            chrome.tabs.create({
                url: message.url,
                active: true
            });

            sendResponse({ success: true });

            return;
        }

        if (message.type === "get_job") {

            sendResponse({ success: true, job: job });

            return;
        }

        if (message.type === "stop_job") {

            stopRequested = true;

            sendResponse({ success: true });

            return;
        }

        /*
         * Clears the last run - its answers, its progress and the
         * half-finished state a resume would pick up - so the next
         * Start begins from nothing. A run still going is stopped
         * first. The document link is a setting, not part of the
         * run, so it is kept.
         */
        if (message.type === "reset_job") {

            stopRequested = true;

            job = emptyJob();

            stopKeepAlive();

            saveJob();

            sendResponse({ success: true, job: job });

            return;
        }

        /*
         * A dry run: reads the document and reports what was found,
         * without asking the AI or writing anything. It is the way
         * to see what the agent makes of a document before letting
         * it near it.
         */
        if (message.type === "check_doc") {

            readQuestionsFromDoc(message.url)
                .then((doc) => {

                    sendResponse({
                        success: true,
                        title: doc.title,
                        questions: doc.questions.map(q => ({
                            number: q.number,
                            kind: q.kind,
                            answer_type: q.answer_type,
                            words: q.word_limit_min
                                ? q.word_limit_min + "-" + q.word_limit_max
                                : "",
                            rows: q.grid ? q.grid.rows.length : 0,
                            columns: q.grid ? q.grid.headers.length : 0,
                            space: q.target
                                ? q.target.kind
                                : (q.grid ? "table" : "none"),
                            downs: q.target ? q.target.downs : 0,
                            anchor: q.target ? q.target.anchor : "",
                            text: (q.text || "").slice(0, 120)
                        }))
                    });
                })
                .catch((error) => {

                    sendResponse({
                        success: false,
                        error: error.message
                    });
                });

            return true;
        }

        /*
         * A Word workbook, answered entirely inside Chrome: the
         * file comes from the popup, the questions are asked in the
         * tabs the user is signed in to, and the answered file is
         * downloaded.
         */
        if (message.type === "check_workbook") {

            checkWorkbook(message.file)
                .then((result) => {
                    sendResponse({ success: true, result: result });
                })
                .catch((error) => {
                    sendResponse({ success: false, error: error.message });
                });

            return true;
        }

        if (message.type === "run_workbook") {

            runWorkbook({
                file: message.file,
                fileName: message.fileName,
                provider: message.provider || "claude"
            }).catch((error) => {

                console.error("[Agent] Workbook run failed:", error);
            });

            sendResponse({ success: true });

            return;
        }

        if (message.type === "run_job") {

            /*
             * Reply straight away. Progress arrives through
             * job_update messages and chrome.storage.
             */
            runJob(
                message.url,
                message.provider,
                message.writeToDoc !== false,
                message.placerUrl || ""
            )
                .catch((error) => {

                    console.error(
                        "[Agent] Job failed:",
                        error.message
                    );
                });

            sendResponse({ success: true });

            return;
        }

        if (message.type === "open_google_doc") {

            try {

                parseDocUrl(message.url);

                chrome.tabs
                    .create({ url: message.url, active: true })
                    .then((tab) => {

                        sendResponse({
                            success: true,
                            tab_id: tab.id
                        });
                    })
                    .catch((error) => {

                        sendResponse({
                            success: false,
                            error: error.message
                        });
                    });

                return true;

            } catch (error) {

                sendResponse({
                    success: false,
                    error: error.message
                });

                return;
            }
        }

        sendResponse({
            success: false,
            error: "Unknown message type."
        });
    }
);


chrome.storage.local.get("job", (stored) => {

    if (
        stored &&
        stored.job &&
        stored.job.status !== "running"
    ) {
        job = stored.job;
    }
});


/*
 * Connecting is what this extension is for: the agent does the
 * work and borrows this browser, which is already signed in. There
 * is no setting to turn that off, and nothing else for the user to
 * do beyond having installed the extension.
 */
connectToPython();
