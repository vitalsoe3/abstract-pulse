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


/*
  Logo is intentionally
  rate-limited.

  Blockchain data can update
  as fast as needed, but the
  visual pulse happens at most
  once every 3 seconds.
*/

let lastPulseTime = 0;

const MIN_PULSE_INTERVAL = 3000;


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
   VISUAL PULSE
========================= */

function pulse(transactionCount = 0) {

  if (!heartElement) {
    return;
  }


  /*
    Transaction count affects
    ONLY pulse strength.

    It never creates extra
    pulses.
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


  /*
    Force browser to restart
    animation.
  */

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
   SAFE PULSE
========================= */

function triggerPulse(transactionCount) {

  const now =
    Date.now();


  /*
    Never pulse more often
    than once every 3 seconds.
  */

  if (
    now - lastPulseTime <
    MIN_PULSE_INTERVAL
  ) {

    return;

  }


  lastPulseTime =
    now;


  pulse(
    transactionCount
  );

}


/* =========================
   STORE BLOCK
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

    blockHistory.push(
      block
    );

  }

}


/* =========================
   ACTIVITY STATISTICS
========================= */

function updateActivity() {

  const now =
    Date.now();


  const minuteCutoff =
    now - 60000;


  const fiveMinuteCutoff =
    now - 300000;


  /*
    Keep only last
    five minutes.
  */

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
   INITIAL CONNECTION
========================= */

async function connect() {

  try {

    /*
      First get only the
      latest block number.
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
      Show connection
      immediately.
    */

    blockElement.textContent =
      `#${latestNumber.toLocaleString()}`;


    /*
      Get latest block details.
    */

    try {

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


        addBlock(
          block
        );


        updateActivity();


        updateHeartbeatTimer();

      }

    }

    catch (error) {

      console.warn(
        "Latest block details error:",
        error
      );

    }


    /*
      IMPORTANT:

      No pulse on page load.
    */


    /*
      Start live chain
      monitoring immediately.
    */

    startLivePolling();


    /*
      Historical statistics
      load separately.
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


    transactionsElement.textContent =
      "—";


    txMinuteElement.textContent =
      "—";


    txFiveMinutesElement.textContent =
      "—";


    heartbeatElement.textContent =
      "—";

  }

}


/* =========================
   LIVE BLOCK CHECK
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
      Nothing new.
    */

    if (
      latestNumber <=
      lastBlock
    ) {

      return;

    }


    /*
      Only fetch CURRENT
      newest block.

      We don't animate
      missed historical blocks.
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
      Update live state.
    */

    lastBlock =
      block.number;


    lastBlockTime =
      block.timestamp;


    /*
      Update visible data.
    */

    blockElement.textContent =
      `#${block.number.toLocaleString()}`;


    transactionsElement.textContent =
      block.transactions
        .toLocaleString();


    /*
      Store for statistics.
    */

    addBlock(
      block
    );


    updateActivity();


    /*
      VISUAL PULSE

      Only live current block
      can reach this function.

      History cannot.

      Maximum frequency:
      once every 3 seconds.
    */

    triggerPulse(
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

    isChecking =
      false;

  }

}


/* =========================
   START LIVE MONITORING
========================= */

function startLivePolling() {

  if (
    livePollingStarted
  ) {

    return;

  }


  livePollingStarted =
    true;


  /*
    Check current block
    every second.
  */

  setInterval(
    checkForNewBlock,
    1000
  );


  /*
    Update counters.
  */

  setInterval(
    () => {

      updateHeartbeatTimer();

      updateActivity();

    },

    1000
  );

}


/* =========================
   HISTORICAL STATISTICS
========================= */

async function loadHistory() {

  if (
    historyLoading ||
    lastBlock === null
  ) {

    return;

  }


  historyLoading =
    true;


  /*
    History starts behind
    current block.
  */

  let historyBlock =
    lastBlock - 1;


  const cutoff =
    Date.now() -
    300000;


  /*
    Safety limit.
  */

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

        console.warn(
          "History stopped:",
          error
        );

        break;

      }


      const block =
        parseBlock(
          rawBlock
        );


      if (!block) {
        break;
      }


      /*
        Stop after five
        minutes of history.
      */

      if (
        block.timestamp <
        cutoff
      ) {

        break;

      }


      /*
        HISTORY ONLY UPDATES
        STATISTICS.

        NO pulse()
        NO triggerPulse()
        NO heartbeat animation.
      */

      addBlock(
        block
      );


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

    historyLoading =
      false;


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
        )
        / 1000
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
   START ABSTRACT PULSE
========================= */

connect();
