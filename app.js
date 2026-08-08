const RPC_URL = "https://api.mainnet.abs.xyz";


/* =========================
   ELEMENTS
========================= */

const blockElement =
  document.getElementById("blockNumber");

const transactionsElement =
  document.getElementById("transactions");

const txMinuteElement =
  document.getElementById("txMinute");

const txFiveMinutesElement =
  document.getElementById("txFiveMinutes");

const heartbeatElement =
  document.getElementById("heartbeat");

const heartElement =
  document.getElementById("heart");


/* =========================
   STATE
========================= */

let lastBlock = null;

let lastBlockTime = null;

let blockHistory = [];

let checkingBlock = false;

let historyLoading = false;


/* =========================
   RPC
========================= */

async function rpcCall(method, params = []) {

  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, 8000);


  try {

    const response =
      await fetch(RPC_URL, {

        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: method,
          params: params
        }),

        signal:
          controller.signal

      });


    if (!response.ok) {

      throw new Error(
        `RPC HTTP ${response.status}`
      );

    }


    const data =
      await response.json();


    if (data.error) {

      throw new Error(
        data.error.message
      );

    }


    return data.result;

  }

  finally {

    clearTimeout(timeout);

  }

}


/* =========================
   GET BLOCK
========================= */

async function getBlock(number) {

  const hex =
    "0x" +
    number.toString(16);


  return await rpcCall(
    "eth_getBlockByNumber",
    [
      hex,
      false
    ]
  );

}


/* =========================
   PARSE BLOCK
========================= */

function parseBlock(block) {

  if (!block) {
    return null;
  }


  return {

    number:
      parseInt(
        block.number,
        16
      ),

    timestamp:
      parseInt(
        block.timestamp,
        16
      ) * 1000,

    transactions:
      Array.isArray(
        block.transactions
      )
        ? block.transactions.length
        : 0

  };

}


/* =========================
   HEARTBEAT
========================= */

function heartbeat() {

  if (!heartElement) {
    return;
  }


  heartElement
    .classList
    .remove("beat");


  /*
    Force browser to restart
    animation.
  */

  void heartElement.offsetWidth;


  heartElement
    .classList
    .add("beat");


  setTimeout(() => {

    heartElement
      .classList
      .remove("beat");

  }, 850);

}


/* =========================
   DISPLAY LATEST BLOCK
========================= */

function displayBlock(block) {

  blockElement.textContent =
    `#${block.number.toLocaleString()}`;


  transactionsElement.textContent =
    block.transactions
      .toLocaleString();

}


/* =========================
   ADD BLOCK TO HISTORY
========================= */

function addBlockToHistory(block) {

  /*
    Prevent duplicate blocks.
  */

  const exists =
    blockHistory.some(
      item =>
        item.number ===
        block.number
    );


  if (!exists) {

    blockHistory.push(block);

  }


  blockHistory.sort(
    (a, b) =>
      b.number - a.number
  );

}


/* =========================
   ACTIVITY CALCULATION
========================= */

function updateActivity() {

  const now =
    Date.now();


  const oneMinuteAgo =
    now - 60000;


  const fiveMinutesAgo =
    now - 300000;


  /*
    Remove old blocks.
  */

  blockHistory =
    blockHistory.filter(
      block =>
        block.timestamp >=
        fiveMinutesAgo
    );


  let minuteTotal = 0;

  let fiveMinuteTotal = 0;


  for (
    const block
    of blockHistory
  ) {

    if (
      block.timestamp >=
      fiveMinutesAgo
    ) {

      fiveMinuteTotal +=
        block.transactions;

    }


    if (
      block.timestamp >=
      oneMinuteAgo
    ) {

      minuteTotal +=
        block.transactions;

    }

  }


  txMinuteElement.textContent =
    minuteTotal.toLocaleString();


  txFiveMinutesElement.textContent =
    fiveMinuteTotal.toLocaleString();

}


/* =========================
   INITIAL CURRENT BLOCK
========================= */

async function loadCurrentBlock() {

  try {

    const latestHex =
      await rpcCall(
        "eth_blockNumber"
      );


    const latestNumber =
      parseInt(
        latestHex,
        16
      );


    const rawBlock =
      await getBlock(
        latestNumber
      );


    const block =
      parseBlock(
        rawBlock
      );


    if (!block) {

      throw new Error(
        "Latest block unavailable"
      );

    }


    lastBlock =
      block.number;


    lastBlockTime =
      block.timestamp;


    displayBlock(block);

    addBlockToHistory(block);

    updateActivity();


    return true;

  }

  catch (error) {

    console.error(
      "Initial block error:",
      error
    );


    blockElement.textContent =
      "RPC ERROR";


    return false;

  }

}


/* =========================
   CHECK NEW BLOCKS
========================= */

async function checkNewBlock() {

  if (
    checkingBlock ||
    lastBlock === null
  ) {

    return;

  }


  checkingBlock = true;


  try {

    const latestHex =
      await rpcCall(
        "eth_blockNumber"
      );


    const latestNumber =
      parseInt(
        latestHex,
        16
      );


    if (
      latestNumber <=
      lastBlock
    ) {

      return;

    }


    /*
      Process every block
      missed between polls.
    */

    for (
      let number =
        lastBlock + 1;

      number <=
        latestNumber;

      number++
    ) {

      const rawBlock =
        await getBlock(number);


      const block =
        parseBlock(rawBlock);


      if (!block) {
        continue;
      }


      addBlockToHistory(block);


      lastBlock =
        block.number;


      lastBlockTime =
        block.timestamp;


      displayBlock(block);


      /*
        ACTUAL NEW BLOCK =
        ONE PULSE
      */

      heartbeat();

    }


    updateActivity();

  }

  catch (error) {

    console.error(
      "Block polling error:",
      error
    );

  }

  finally {

    checkingBlock = false;

  }

}


/* =========================
   HISTORY
========================= */

async function loadRecentHistory() {

  if (
    historyLoading ||
    lastBlock === null
  ) {

    return;

  }


  historyLoading = true;


  try {

    const cutoff =
      Date.now() - 300000;


    /*
      Start one block behind
      the already loaded block.
    */

    let number =
      lastBlock - 1;


    /*
      Safety limit.

      We do NOT allow history
      loading to block the app.
    */

    const MAX_HISTORY_BLOCKS =
      300;


    for (
      let i = 0;
      i < MAX_HISTORY_BLOCKS;
      i++
    ) {

      const rawBlock =
        await getBlock(number);


      const block =
        parseBlock(rawBlock);


      if (!block) {
        break;
      }


      /*
        We've reached beyond
        five minutes.
      */

      if (
        block.timestamp <
        cutoff
      ) {

        break;
      }


      addBlockToHistory(block);

      updateActivity();


      number--;

    }

  }

  catch (error) {

    /*
      History failure should
      NEVER kill live Pulse.
    */

    console.warn(
      "History loading stopped:",
      error
    );

  }

  finally {

    historyLoading = false;

    updateActivity();

  }

}


/* =========================
   LAST HEARTBEAT TIMER
========================= */

function updateHeartbeatTimer() {

  if (!lastBlockTime) {

    heartbeatElement.textContent =
      "—";

    return;

  }


  const seconds =
    Math.max(
      0,
      Math.floor(
        (
          Date.now() -
          lastBlockTime
        ) / 1000
      )
    );


  if (
    seconds === 0
  ) {

    heartbeatElement.textContent =
      "NOW";

  }

  else if (
    seconds === 1
  ) {

    heartbeatElement.textContent =
      "1s ago";

  }

  else {

    heartbeatElement.textContent =
      `${seconds}s ago`;

  }

}


/* =========================
   START
========================= */

async function start() {

  /*
    First priority:
    get Pulse working.
  */

  const connected =
    await loadCurrentBlock();


  if (!connected) {

    txMinuteElement.textContent =
      "—";

    txFiveMinutesElement.textContent =
      "—";

    return;

  }


  updateHeartbeatTimer();


  /*
    Live block detection starts
    IMMEDIATELY.
  */

  setInterval(
    checkNewBlock,
    1000
  );


  setInterval(
    () => {

      updateHeartbeatTimer();

      updateActivity();

    },
    1000
  );


  /*
    Historical activity loads
    separately.

    It cannot stop live blocks
    or heartbeat.
  */

  loadRecentHistory();

}


start();
