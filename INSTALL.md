# AI Question Agent — Install & Run

This reads every question out of a Word document (`.docx`), asks an AI
to answer each one, and writes the answer into the space the document
already leaves for it. Your original file is never changed — the
answers go into a copy saved next to it, named
`<your file> - answered.docx`.

Nothing leaves your computer except what you already send to the AI
site yourself, in your own browser.

---

## What you need

- Windows, with **Google Chrome** installed.
- **Python 3.10 or newer.** If you don't have it, install it from
  <https://www.python.org/downloads/> — during install, tick
  **"Add python.exe to PATH"**.
- An account with at least one of ChatGPT, Claude or Gemini.

---

## Install (once)

### 1. Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right switch).
3. Click **Load unpacked**.
4. Choose the `chrome-extension` folder — the one inside this same
   folder you unzipped.
5. "AI Question Agent" now appears in the list. Click the puzzle-piece
   icon in Chrome's toolbar and pin it so it's always visible.

This extension is what lets the app use tabs in your own, already
signed-in Chrome. There is nothing to turn on inside it — installing
it is the whole job.

### 2. Set up the app

Double-click **`setup.cmd`**. It downloads and installs everything the
app needs (a couple of minutes, needs internet). You only do this
once. If it reports Python is missing, install Python first (see
above) and run it again.

---

## Before each run

Sign in, in your normal Chrome, to whichever of these you're using:

- ChatGPT — <https://chatgpt.com>
- Claude — <https://claude.ai>
- Gemini — <https://gemini.google.com>

---

## Run

1. Double-click **`Run AI Question Agent.cmd`**. The app window opens.
2. **Your workbook** — click **Choose .docx** and pick the assessment
   file.
3. **Which AI to use** — pick ChatGPT, Claude or Gemini, and leave
   **"My Chrome, already signed in"** selected (the other option opens
   a separate browser of its own, only useful if you'd rather sign in
   there once instead of using your everyday Chrome).
4. Optional: click **Check the document first** to see what the agent
   found without answering anything yet, or **Test Chrome link** to
   confirm the extension is reachable before a long run.
5. Click **Start**.

Chrome will switch to the AI's tab as it works — that's the agent
doing its job, not a problem. Leave that tab alone while it runs;
**don't type in it**.

The file is saved after every single answer, so **Stop** at any point
still keeps everything answered so far. **Reset** clears the log and
status to start over — it doesn't touch your file or AI choice. When
it finishes, click **Open** to open the answered file.

---

## What the agent reads out of your workbook

It reads **every** item that expects an answer, in order, however it's
labelled:

```
Question 1.        Question 2(a).     Q3.
Task 1.            Assessment Task 2. Activity 3.     Exercise 4.
Section A          Assignment 1       Part B          Module 2
```

If a document uses none of those headings, plain numbered lines are
read instead:

```
1. Define duty of care.
2. Give an example of a hazard.
```

Notes:

- `Question 2(a)`, `2(b)`, `11(e)`, `Task 1(a)` and so on all work.
- A **section, part or assignment heading** becomes background for the
  questions under it. A case-study heading that only introduces
  numbered parts is attached to each part as context rather than
  answered on its own.
- A line like `Answer must be 30-80 words.` or `(50-100 words)` sets
  that question's word limit.
- Marking guidance is skipped — `Satisfactory response`, `Sample
  answer`, `Answers must include…`, `Assessor…` — and tick boxes
  (`Yes ☐` / `No ☐`) are always left alone; they belong to the
  assessor.
- The blank box or blank line already left under a question is where
  the answer goes. If there isn't one, the answer is written directly
  under the question instead.
- **Tables are filled in cell by cell.** A question that gives a table
  — a header row, then a row per item with empty cells beside it —
  has each row answered in small batches, and only the empty cells are
  filled in; anything you've already typed by hand is left as-is.

---

## If something goes wrong

| Message | What to do |
| --- | --- |
| "Chrome did not connect." | Make sure Chrome is open with the extension installed and showing "Active" in its popup. If you just installed or updated the extension, reload it once at `chrome://extensions`. |
| "<AI> is not ready - make sure you are signed in." | Open that site in a Chrome tab yourself and sign in, then press Start again. |
| "<AI> did not answer in time." | The AI was slow for that one question. Press Start again - answered questions are kept, only the missing ones are retried. |
| "Choose your workbook first." / "That file does not exist." | Pick the `.docx` file with **Choose .docx**. |
| Nothing happens at all | Go to `chrome://extensions`, find AI Question Agent, click the reload arrow, then try again. |

---

## For developers only (optional)

The extension always tries to keep a connection open to the app on
`ws://127.0.0.1:8765` — that link is how the app drives your
already-signed-in tabs. There is nothing to switch on or configure;
installing the extension is the whole setup.

> If you open the service worker console (`chrome://extensions`,
> **service worker** under AI Question Agent) and see `WebSocket
> connection to 'ws://127.0.0.1:8765/' failed`, that just means the
> app isn't running yet. Nothing is broken — start the app and the
> extension picks up the connection on its own within a few seconds.

To run the app from a terminal instead of the shortcut:

```powershell
.venv\Scripts\python.exe -m docx_agent.app
```

Or headless, from the command line:

```powershell
.venv\Scripts\python.exe -m docx_agent.cli run "workbook.docx" --ai claude --through-chrome
```
