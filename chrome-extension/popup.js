/*
 * The popup is a status light, nothing more.
 *
 * Everything that used to be set here - the document, the AI,
 * Start - now lives in the AI Question Agent app.
 * All this has to say is whether the agent can reach this browser,
 * and offer the sites a quick way to be signed in to, once. There is
 * nothing to turn on: installing the extension is the whole setup.
 */

const state = document.getElementById("state");
const dot = document.getElementById("dot");
const stateText = document.getElementById("stateText");
const detail = document.getElementById("detail");


function show(status) {

    if (status && status.busy) {

        state.className = "on";
        stateText.textContent = "Working";
        detail.textContent = status.step ||
            "The agent is using this browser now.";

        return;
    }

    if (status && status.connected) {

        state.className = "on";
        stateText.textContent = "Active - agent connected";
        detail.textContent =
            "Your signed-in tabs are available to the agent. Start "
            + "your run in the app.";

        return;
    }

    state.className = "";
    stateText.textContent = "Active - waiting for the agent";
    detail.textContent =
        "This browser is ready. Open the AI Question Agent app and "
        + "press Start, and this will turn green.";
}


async function refresh() {

    try {

        const status = await chrome.runtime.sendMessage({
            type: "bridge_status"
        });

        show(status);

    } catch (error) {

        /* The worker is asleep; opening the popup wakes it. */
        state.className = "";
        stateText.textContent = "Starting...";
        detail.textContent = "";
    }
}


document.querySelectorAll(".sites button").forEach((button) => {

    button.addEventListener("click", () => {

        chrome.runtime.sendMessage({
            type: "open_site",
            url: button.dataset.url
        });

        window.close();
    });
});


refresh();

/* While the popup is open, keep the light honest. */
setInterval(refresh, 1500);
