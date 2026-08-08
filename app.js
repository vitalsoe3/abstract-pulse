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

let isChecking = false;
let historyLoading = false;


/* =========================
   RPC CALL
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
   HEARTBEAT
========================= */

function pulse() {

  if (!heartElement) {
    return;
  }


  heartElement
    .classList
    .remove("beat");


  /*
    Force browser to restart
    CSS animation.
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
   HISTORY STORAGE
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
   TX ACTIVITY
========================= */

function updateActivity() {

  const now =
    Date.now();


  const minuteCutoff =
    now - 60000;


  const fiveMinuteCutoff =
    now - 300000;


  /*
    Remove anything older
    than five minutes.
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


    if (
      block.timestamp >=
      fiveMinuteCutoff
    ) {

      txFiveMinutes +=
        block.transactions;

    }

  }


  txMinuteElement.textContent =
    txMinute.toLocaleString();


  txFiveMinutesElement.textContent =
    txFiveMinutes.toLocaleString();

}


/* =========================
   FAST INITIAL CONNECTION
========================= */

async function connect() {

  try {

    /*
      REQUEST #1

      Get block number first.

      We show this immediately.
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
      USER SEES CONNECTION
      AS SOON AS FIRST RPC
      CALL RETURNS.
    */

    blockElement.textContent =
      `#${latestNumber.toLocaleString()}`;


    /*
      Start live polling NOW.

      We do not wait for
      history.
    */

    startLivePolling();


    /*
      REQUEST #2

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


        addBlock(block);


        updateActivity();


        updateHeartbeatTimer();

      }

    }

    catch (error) {

      console.warn(
        "Latest block details failed:",
        error
      );

    }


    /*
      History is completely
      separate.

      It CANNOT delay the
      live website.
    */

    loadHistory();


  }

  catch (error) {

    console.error(
      "RPC connection failed:",
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

async function checkForNewBlocks() {

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
      Process every block
      that appeared since
      last check.
    */

    for (
      let number =
        lastBlock + 1;

      number <=
        latestNumber;

      number++
    ) {

      try {

        const rawBlock =
          await getBlock(
            number
          );


        const block =
          parseBlock(
            rawBlock
          );


        if (!block) {
          continue;
        }


        lastBlock =
          block.number;


        lastBlockTime =
          block.timestamp;


        blockElement.textContent =
          `#${block.number.toLocaleString()}`;


        transactionsElement.textContent =
          block.transactions
            .toLocaleString();


        addBlock(block);


        /*
          ONE REAL NEW BLOCK
          =
          ONE HEARTBEAT
        */

        pulse();


        updateActivity();

      }

      catch (error) {

        console.warn(
          `Block ${number} failed:`,
          error
        );

      }

    }

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
   START LIVE POLLING
========================= */

let livePollingStarted =
  false;


function startLivePolling() {

  if (livePollingStarted) {
    return;
  }


  livePollingStarted =
    true;


  /*
    Check Abstract every
    second.
  */

  setInterval(
    checkForNewBlocks,
    1000
  );


  /*
    Update UI timers.
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
   BACKGROUND HISTORY
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


  const fiveMinutesAgo =
    Date.now() - 300000;


  /*
    IMPORTANT:

    Save where history begins.

    Live polling may increase
    lastBlock while history
    is loading.
  */

  let number =
    lastBlock - 1;


  /*
    Safety cap.

    This prevents the browser
    from making unlimited RPC
    requests.
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
            number
          );

      }

      catch (error) {

        console.warn(
          "History request stopped:",
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
        We reached further
        back than five minutes.
      */

      if (
        block.timestamp <
        fiveMinutesAgo
      ) {

        break;

      }


      addBlock(block);


      /*
        Update values while
        history loads.

        User can see numbers
        filling in.
      */

      updateActivity();


      number--;

    }

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
   GO
========================= */

connect();
