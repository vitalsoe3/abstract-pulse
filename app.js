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

let livePollingStarted = false;
let isChecking = false;
let historyLoading = false;


/* =========================
   RPC
========================= */

async function rpcCall(method, params = []) {

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      5000
    );

  try {

    const response =
      await fetch(
        RPC_URL,
        {
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
        }
      );


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


  return rpcCall(
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
   ONE PULSE ONLY
========================= */

function pulse(transactionCount = 0) {

  if (!heartElement) {
    return;
  }


  /*
    TX count affects ONLY
    pulse strength.

    It does NOT create
    additional beats.
  */

  let strength = 1.10;


  if (transactionCount >= 5) {
    strength = 1.12;
  }


  if (transactionCount >= 20) {
    strength = 1.14;
  }


  if (transactionCount >= 50) {
    strength = 1.17;
  }


  if (transactionCount >= 100) {
    strength = 1.20;
  }


  heartElement.style.setProperty(
    "--pulse-strength",
    strength
  );


  heartElement
    .classList
    .remove("beat");


  void heartElement.offsetWidth;


  heartElement
    .classList
    .add("beat");


  setTimeout(
    () => {

      heartElement
        .classList
        .remove("beat");

    },
    850
  );

}


/* =========================
   HISTORY
========================= */

function addBlock(block) {

  if (!block) {
    return;
  }


  const exists =
    blockHistory.some(
      item =>
        item.number ===
        block.number
    );


  if (!exists) {

    blockHistory.push(block);

  }

}


/* =========================
   TX / MIN + 5 MIN
========================= */

function updateActivity() {

  const now =
    Date.now();


  const minuteCutoff =
    now - 60000;


  const fiveMinuteCutoff =
    now - 300000;


  blockHistory =
    blockHistory.filter(
      block =>
        block.timestamp >=
        fiveMinuteCutoff
    );


  let txMinute = 0;

  let txFiveMinutes = 0;


  for (
    const block
    of blockHistory
  ) {

    /*
      STATISTICS ONLY.

      Absolutely no pulse()
      calls happen here.
    */


    if (
      block.timestamp >=
      minuteCutoff
    ) {

      txMinute +=
        block.transactions;

    }


    txFiveMinutes +=
      block.transactions;

  }


  txMinuteElement.textContent =
    txMinute.toLocaleString();


  txFiveMinutesElement.textContent =
    txFiveMinutes.toLocaleString();

}


/* =========================
   CONNECT
========================= */

async function connect() {

  try {

    /*
      Get latest block number.
    */

    const latestHex =
      await rpcCall(
        "eth_blockNumber"
      );


    const latestNumber =
      parseInt(
        latestHex,
        16
      );


    lastBlock =
      latestNumber;


    /*
      Show block immediately.
    */

    blockElement.textContent =
      `#${latestNumber.toLocaleString()}`;


    /*
      Get current block details.
    */

    const rawBlock =
      await getBlock(
        latestNumber
      );


    const block =
      parseBlock(
        rawBlock
      );


    if (block) {

      lastBlockTime =
        block.timestamp;


      transactionsElement.textContent =
        block.transactions
          .toLocaleString();


      addBlock(block);


      updateActivity();

    }


    /*
      IMPORTANT:

      We DO NOT pulse when
      page initially loads.
    */


    startLivePolling();


    /*
      History loads separately.
    */

    loadHistory();

  }

  catch (error) {

    console.error(
      "Connection error:",
      error
    );


    blockElement.textContent =
      "RPC ERROR";

  }

}


/* =========================
   LIVE BLOCK
========================= */

async function checkForNewBlock() {

  if (
    isChecking ||
    lastBlock === null
  ) {

    return;

  }


  isChecking = true;


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


    /*
      No new block.
    */

    if (
      latestNumber <=
      lastBlock
    ) {

      return;

    }


    /*
      IMPORTANT:

      We only fetch the
      CURRENT newest block.

      We do NOT animate
      every missed block.
    */

    const rawBlock =
      await getBlock(
        latestNumber
      );


    const block =
      parseBlock(
        rawBlock
      );


    if (!block) {
      return;
    }


    /*
      Update state first.
    */

    lastBlock =
      block.number;


    lastBlockTime =
      block.timestamp;


    /*
      Update UI.
    */

    blockElement.textContent =
      `#${block.number.toLocaleString()}`;


    transactionsElement.textContent =
      block.transactions
        .toLocaleString();


    addBlock(block);


    updateActivity();


    /*
      EXACTLY ONE PULSE.

      TX / MIN and TX / 5 MIN
      have ZERO influence here.

      Only TX IN BLOCK is
      passed to the animation.
    */

    pulse(
      block.transactions
    );

  }

  catch (error) {

    console.warn(
      "Live polling error:",
      error
    );

  }

  finally {

    isChecking = false;

  }

}


/* =========================
   LIVE POLLING
========================= */

function startLivePolling() {

  if (livePollingStarted) {
    return;
  }


  livePollingStarted = true;


  setInterval(
    checkForNewBlock,
    1000
  );


  setInterval(
    () => {

      updateHeartbeatTimer();

      updateActivity();

    },
    1000
  );

}


/* =========================
   BACKGROUND HISTORY
========================= */

async function loadHistory() {

  if (
    historyLoading ||
    lastBlock === null
  ) {

    return;

  }


  historyLoading = true;


  /*
    Save starting point.

    History must NEVER modify
    lastBlock.
  */

  let historyBlock =
    lastBlock - 1;


  const cutoff =
    Date.now() - 300000;


  const MAX_BLOCKS =
    300;


  try {

    for (
      let i = 0;
      i < MAX_BLOCKS;
      i++
    ) {

      let rawBlock;


      try {

        rawBlock =
          await getBlock(
            historyBlock
          );

      }

      catch (error) {

        break;

      }


      const block =
        parseBlock(
          rawBlock
        );


      if (!block) {
        break;
      }


      if (
        block.timestamp <
        cutoff
      ) {

        break;

      }


      /*
        History ONLY enters
        statistics storage.
      */

      addBlock(block);


      /*
        NO pulse() HERE.
      */


      updateActivity();


      historyBlock--;

    }

  }

  catch (error) {

    console.warn(
      "History error:",
      error
    );

  }

  finally {

    historyLoading = false;

    updateActivity();

  }

}


/* =========================
   LAST HEARTBEAT
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


  if (seconds === 0) {

    heartbeatElement.textContent =
      "NOW";

  }

  else if (seconds === 1) {

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

connect();
