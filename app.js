const RPC_URL =
  "https://api.mainnet.abs.xyz";


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

const minuteCountdownElement =
  document.getElementById("minuteCountdown");

const fiveMinuteCountdownElement =
  document.getElementById("fiveMinuteCountdown");

const heartbeatElement =
  document.getElementById("heartbeat");

const heartElement =
  document.getElementById("heart");


/* WALLET */

const walletForm =
  document.getElementById("walletForm");

const walletInput =
  document.getElementById("walletInput");

const checkButton =
  document.getElementById("checkButton");

const walletResult =
  document.getElementById("walletResult");

const checkerMessage =
  document.getElementById("checkerMessage");

const checkedAddress =
  document.getElementById("checkedAddress");

const walletBalance =
  document.getElementById("walletBalance");

const walletNonce =
  document.getElementById("walletNonce");


/* =========================
   STATE
========================= */

let lastBlock = null;
let lastBlockTime = null;

let intervalBlocks = [];

let initialSyncComplete = false;
let syncRunning = false;
let pollingRunning = false;
let liveCheckRunning = false;
let walletChecking = false;

let lastPulseTime = 0;

const MIN_PULSE_INTERVAL = 2500;


/* =========================
   GENERAL HELPERS
========================= */

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );

}


function getMinuteStart() {

  const now =
    new Date();

  now.setSeconds(
    0,
    0
  );

  return now.getTime();

}


function getFiveMinuteStart() {

  const now =
    new Date();

  const minute =
    now.getMinutes();

  const intervalMinute =
    Math.floor(
      minute / 5
    ) * 5;

  now.setMinutes(
    intervalMinute,
    0,
    0
  );

  return now.getTime();

}


/* =========================
   RPC
========================= */

async function rpcCall(
  method,
  params = []
) {

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      10000
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

          body:
            JSON.stringify({
              jsonrpc: "2.0",
              id:
                Math.floor(
                  Math.random() *
                  10000000
                ),
              method,
              params
            }),

          signal:
            controller.signal

        }
      );


    if (!response.ok) {

      throw new Error(
        `HTTP ${response.status}`
      );

    }


    const data =
      await response.json();


    if (data.error) {

      throw new Error(
        data.error.message ||
        "RPC error"
      );

    }


    if (
      typeof data.result ===
      "undefined"
    ) {

      throw new Error(
        "No RPC result"
      );

    }


    return data.result;

  }

  finally {

    clearTimeout(
      timeout
    );

  }

}


/* =========================
   BLOCK
========================= */

async function getBlock(
  number
) {

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


function parseBlock(
  block
) {

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
   BLOCK STORAGE
========================= */

function addBlock(
  block
) {

  if (!block) {
    return;
  }


  const exists =
    intervalBlocks.some(
      item =>
        item.number ===
        block.number
    );


  if (!exists) {

    intervalBlocks.push(
      block
    );

  }

}


function removeOldBlocks() {

  const start =
    getFiveMinuteStart();


  intervalBlocks =
    intervalBlocks.filter(
      block =>
        block.timestamp >=
        start
    );

}


/* =========================
   COUNTERS
========================= */

function updateCounters() {

  if (
    !initialSyncComplete
  ) {

    txMinuteElement.textContent =
      "SYNCING...";

    txFiveMinutesElement.textContent =
      "SYNCING...";

    return;

  }


  removeOldBlocks();


  const minuteStart =
    getMinuteStart();

  const fiveStart =
    getFiveMinuteStart();


  let minuteTotal = 0;

  let fiveMinuteTotal = 0;


  for (
    const block
    of intervalBlocks
  ) {

    if (
      block.timestamp >=
      fiveStart
    ) {

      fiveMinuteTotal +=
        block.transactions;

    }


    if (
      block.timestamp >=
      minuteStart
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
   COUNTDOWN
========================= */

function updateCountdowns() {

  const now =
    Date.now();


  /* MINUTE */

  const nextMinute =
    getMinuteStart() +
    60000;


  let minuteSeconds =
    Math.ceil(
      (
        nextMinute -
        now
      ) / 1000
    );


  minuteSeconds =
    Math.max(
      0,
      minuteSeconds
    );


  minuteCountdownElement.textContent =
    `RESET IN ${minuteSeconds}s`;


  /* FIVE MINUTES */

  const nextFive =
    getFiveMinuteStart() +
    300000;


  let fiveSeconds =
    Math.ceil(
      (
        nextFive -
        now
      ) / 1000
    );


  fiveSeconds =
    Math.max(
      0,
      fiveSeconds
    );


  const mins =
    Math.floor(
      fiveSeconds /
      60
    );


  const secs =
    fiveSeconds %
    60;


  if (
    mins > 0
  ) {

    fiveMinuteCountdownElement.textContent =
      `RESET IN ${mins}m ${secs}s`;

  }

  else {

    fiveMinuteCountdownElement.textContent =
      `RESET IN ${secs}s`;

  }

}


/* =========================
   HEARTBEAT ANIMATION
========================= */

function pulse(
  transactionCount = 0
) {

  if (!heartElement) {
    return;
  }


  let strength =
    1.10;


  if (
    transactionCount >= 5
  ) {

    strength =
      1.12;

  }


  if (
    transactionCount >= 20
  ) {

    strength =
      1.14;

  }


  if (
    transactionCount >= 50
  ) {

    strength =
      1.17;

  }


  if (
    transactionCount >= 100
  ) {

    strength =
      1.20;

  }


  heartElement.style.setProperty(
    "--pulse-strength",
    strength
  );


  heartElement.classList.remove(
    "beat"
  );


  void heartElement.offsetWidth;


  heartElement.classList.add(
    "beat"
  );


  setTimeout(
    () => {

      heartElement
        .classList
        .remove(
          "beat"
        );

    },
    850
  );

}


function triggerPulse(
  transactionCount
) {

  const now =
    Date.now();


  if (
    now -
    lastPulseTime <
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
   INITIAL SYNC
========================= */

async function initialSync() {

  if (
    syncRunning
  ) {
    return;
  }


  syncRunning =
    true;


  initialSyncComplete =
    false;


  txMinuteElement.textContent =
    "SYNCING...";


  txFiveMinutesElement.textContent =
    "SYNCING...";


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


    lastBlock =
      latestNumber;


    blockElement.textContent =
      "#" +
      latestNumber.toLocaleString();


    const fiveStart =
      getFiveMinuteStart();


    intervalBlocks = [];


    let currentBlockNumber =
      latestNumber;


    const MAX_BLOCKS =
      500;


    for (
      let i = 0;
      i < MAX_BLOCKS;
      i++
    ) {

      const rawBlock =
        await getBlock(
          currentBlockNumber
        );


      const block =
        parseBlock(
          rawBlock
        );


      if (!block) {
        break;
      }


      /*
        Latest block
      */

      if (
        currentBlockNumber ===
        latestNumber
      ) {

        lastBlockTime =
          block.timestamp;


        transactionsElement
          .textContent =
          block.transactions
            .toLocaleString();

      }


      /*
        We've reached a block
        before current 5-minute
        interval.
      */

      if (
        block.timestamp <
        fiveStart
      ) {

        break;

      }


      addBlock(
        block
      );


      currentBlockNumber--;


      /*
        Protect free public RPC.
      */

      await sleep(
        45
      );

    }


    initialSyncComplete =
      true;


    updateCounters();


    updateHeartbeatTimer();

  }

  catch (error) {

    console.error(
      "INITIAL SYNC ERROR:",
      error
    );


    txMinuteElement.textContent =
      "SYNC ERROR";


    txFiveMinutesElement.textContent =
      "SYNC ERROR";


    if (
      lastBlock === null
    ) {

      blockElement.textContent =
        "RPC ERROR";

    }

  }

  finally {

    syncRunning =
      false;

  }

}


/* =========================
   LIVE BLOCKS
========================= */

async function checkNewBlocks() {

  if (
    syncRunning ||
    liveCheckRunning ||
    walletChecking ||
    lastBlock === null
  ) {

    return;

  }


  liveCheckRunning =
    true;


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
      Fetch every missing block,
      not just the newest one.
    */

    const firstNew =
      lastBlock + 1;


    for (
      let number = firstNew;
      number <= latestNumber;
      number++
    ) {

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
        "#" +
        block.number.toLocaleString();


      transactionsElement
        .textContent =
        block.transactions
          .toLocaleString();


      /*
        Only blocks in current
        5-minute interval are
        relevant to counters.
      */

      if (
        block.timestamp >=
        getFiveMinuteStart()
      ) {

        addBlock(
          block
        );

      }


      updateCounters();


      /*
        Only genuinely new blocks
        trigger the visual heartbeat.
      */

      triggerPulse(
        block.transactions
      );

    }

  }

  catch (error) {

    console.warn(
      "LIVE BLOCK ERROR:",
      error
    );

  }

  finally {

    liveCheckRunning =
      false;

  }

}


/* =========================
   TIME BOUNDARIES
========================= */

let previousMinute =
  getMinuteStart();


let previousFiveMinute =
  getFiveMinuteStart();


function detectTimeBoundary() {

  const minute =
    getMinuteStart();


  const fiveMinute =
    getFiveMinuteStart();


  /*
    New minute.
  */

  if (
    minute !==
    previousMinute
  ) {

    previousMinute =
      minute;


    updateCounters();

  }


  /*
    New fixed 5-minute period.
  */

  if (
    fiveMinute !==
    previousFiveMinute
  ) {

    previousFiveMinute =
      fiveMinute;


    removeOldBlocks();


    updateCounters();

  }

}


/* =========================
   LAST HEARTBEAT
========================= */

function updateHeartbeatTimer() {

  if (
    !lastBlockTime
  ) {

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
        ) /
        1000
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
   POLLING
========================= */

function startPolling() {

  if (
    pollingRunning
  ) {
    return;
  }


  pollingRunning =
    true;


  /*
    Blockchain check.
  */

  setInterval(
    checkNewBlocks,
    2000
  );


  /*
    UI timers.
  */

  setInterval(
    () => {

      updateCountdowns();

      detectTimeBoundary();

      updateHeartbeatTimer();

    },
    250
  );

}


/* =========================
   ADDRESS VALIDATION
========================= */

function isValidAddress(
  address
) {

  return (
    /^0x[a-fA-F0-9]{40}$/
      .test(
        address
      )
  );

}


/* =========================
   ETH FORMAT
========================= */

function formatEthBalance(
  balanceHex
) {

  const wei =
    BigInt(
      balanceHex
    );


  const WEI_PER_ETH =
    1000000000000000000n;


  const whole =
    wei /
    WEI_PER_ETH;


  const remainder =
    wei %
    WEI_PER_ETH;


  let fraction =
    remainder
      .toString()
      .padStart(
        18,
        "0"
      )
      .slice(
        0,
        8
      )
      .replace(
        /0+$/,
        ""
      );


  if (
    fraction.length === 0
  ) {

    return whole.toString();

  }


  return (
    whole.toString() +
    "." +
    fraction
  );

}


/* =========================
   SHORT ADDRESS
========================= */

function shortAddress(
  address
) {

  return (
    address.slice(
      0,
      10
    ) +
    "..." +
    address.slice(
      -8
    )
  );

}


/* =========================
   WALLET CHECKER
========================= */

walletForm.addEventListener(
  "submit",

  async event => {

    event.preventDefault();


    const address =
      walletInput
        .value
        .trim();


    checkerMessage
      .classList
      .remove(
        "error"
      );


    checkerMessage.textContent =
      "";


    walletResult
      .classList
      .add(
        "hidden"
      );


    if (
      !isValidAddress(
        address
      )
    ) {

      checkerMessage.textContent =
        "Enter a valid 0x address.";


      checkerMessage
        .classList
        .add(
          "error"
        );


      return;

    }


    walletChecking =
      true;


    checkButton.disabled =
      true;


    checkButton.textContent =
      "CHECKING...";


    checkerMessage.textContent =
      "Reading Abstract Mainnet...";


    try {

      /*
        Balance first.
      */

      const balanceHex =
        await rpcCall(
          "eth_getBalance",
          [
            address,
            "latest"
          ]
        );


      /*
        Don't hit public RPC with
        both requests simultaneously.
      */

      await sleep(
        150
      );


      /*
        Nonce.
      */

      const nonceHex =
        await rpcCall(
          "eth_getTransactionCount",
          [
            address,
            "latest"
          ]
        );


      const balance =
        formatEthBalance(
          balanceHex
        );


      const nonce =
        parseInt(
          nonceHex,
          16
        );


      checkedAddress.textContent =
        shortAddress(
          address
        );


      checkedAddress.title =
        address;


      walletBalance.textContent =
        `${balance} ETH`;


      walletNonce.textContent =
        nonce.toLocaleString();


      checkerMessage.textContent =
        "";


      walletResult
        .classList
        .remove(
          "hidden"
        );

    }

    catch (error) {

      console.error(
        "ADDRESS CHECK FAILED:",
        error
      );


      checkerMessage.textContent =
        "Could not read this address. Try again.";


      checkerMessage
        .classList
        .add(
          "error"
        );

    }

    finally {

      walletChecking =
        false;


      checkButton.disabled =
        false;


      checkButton.textContent =
        "CHECK";

    }

  }
);


/* =========================
   START
========================= */

async function start() {

  /*
    Countdown appears immediately.
  */

  updateCountdowns();


  /*
    Reconstruct the current
    fixed 5-minute interval.
  */

  await initialSync();


  /*
    Then switch to live mode.
  */

  startPolling();

}


start();
