const RPC_URL = "https://api.mainnet.abs.xyz";

/* =========================
   ELEMENTS
========================= */

const blockElement = document.getElementById("blockNumber");
const transactionsElement = document.getElementById("transactions");

const txMinuteElement = document.getElementById("txMinute");
const txFiveMinutesElement = document.getElementById("txFiveMinutes");

const minuteCountdownElement =
  document.getElementById("minuteCountdown");

const fiveMinuteCountdownElement =
  document.getElementById("fiveMinuteCountdown");

const heartbeatElement =
  document.getElementById("heartbeat");

const heartElement =
  document.getElementById("heart");


/* WALLET CHECKER */

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

let isCheckingBlock = false;
let walletChecking = false;

let trackedBlocks = [];

/*
  We remember when this browser
  started watching the chain.
*/

const trackingStartedAt = Date.now();


/*
  Current boundaries.
*/

let currentMinuteStart =
  getMinuteStart();

let currentFiveMinuteStart =
  getFiveMinuteStart();


/*
  Pulse protection.
*/

let lastPulseTime = 0;

const MIN_PULSE_INTERVAL = 2500;


/* =========================
   TIME HELPERS
========================= */

function getMinuteStart(time = Date.now()) {

  const date = new Date(time);

  date.setSeconds(0, 0);

  return date.getTime();
}


function getFiveMinuteStart(time = Date.now()) {

  const date = new Date(time);

  const minute =
    Math.floor(
      date.getMinutes() / 5
    ) * 5;

  date.setMinutes(
    minute,
    0,
    0
  );

  return date.getTime();
}


/* =========================
   RPC
========================= */

async function rpcCall(method, params = []) {

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      8000
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
                  1000000000
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


    return data.result;

  }

  finally {

    clearTimeout(timeout);

  }
}


/* =========================
   BLOCK
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


function parseBlock(block) {

  if (!block) {
    return null;
  }


  return {

    number:
      Number(
        BigInt(block.number)
      ),

    timestamp:
      Number(
        BigInt(block.timestamp)
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
   STORE LIVE BLOCK
========================= */

function storeBlock(block) {

  if (!block) {
    return;
  }


  const exists =
    trackedBlocks.some(
      item =>
        item.number ===
        block.number
    );


  if (exists) {
    return;
  }


  trackedBlocks.push(block);


  /*
    We never need blocks older
    than about 6 minutes.
  */

  const cutoff =
    Date.now() -
    360000;


  trackedBlocks =
    trackedBlocks.filter(
      item =>
        item.timestamp >=
        cutoff
    );

}


/* =========================
   SUM INTERVAL
========================= */

function sumTransactions(
  start,
  end
) {

  let total = 0;


  for (
    const block
    of trackedBlocks
  ) {

    if (
      block.timestamp >= start &&
      block.timestamp < end
    ) {

      total +=
        block.transactions;

    }

  }


  return total;

}


/* =========================
   TIME FORMAT
========================= */

function formatTime(timestamp) {

  const date =
    new Date(timestamp);


  return date.toLocaleTimeString(
    [],
    {
      hour: "2-digit",
      minute: "2-digit"
    }
  );

}


/* =========================
   FINALIZE LAST MINUTE
========================= */

function finalizeMinute(
  finishedMinuteStart
) {

  const end =
    finishedMinuteStart +
    60000;


  /*
    Critical:

    We only show this result if
    this browser was already
    tracking BEFORE the minute
    started.

    Otherwise it would be
    incomplete.
  */

  if (
    trackingStartedAt >
    finishedMinuteStart
  ) {

    txMinuteElement.textContent =
      "WAITING";

    if (
      minuteCountdownElement
    ) {

      minuteCountdownElement.textContent =
        "FOR FULL INTERVAL";

    }

    return;
  }


  const total =
    sumTransactions(
      finishedMinuteStart,
      end
    );


  txMinuteElement.textContent =
    total.toLocaleString();


  if (
    minuteCountdownElement
  ) {

    minuteCountdownElement.textContent =
      `${formatTime(
        finishedMinuteStart
      )} – ${formatTime(end)}`;

  }

}


/* =========================
   FINALIZE LAST 5 MIN
========================= */

function finalizeFiveMinutes(
  finishedStart
) {

  const end =
    finishedStart +
    300000;


  /*
    Same protection:

    Never show an incomplete
    five-minute result.
  */

  if (
    trackingStartedAt >
    finishedStart
  ) {

    txFiveMinutesElement.textContent =
      "WAITING";

    if (
      fiveMinuteCountdownElement
    ) {

      fiveMinuteCountdownElement.textContent =
        "FOR FULL INTERVAL";

    }

    return;
  }


  const total =
    sumTransactions(
      finishedStart,
      end
    );


  txFiveMinutesElement.textContent =
    total.toLocaleString();


  if (
    fiveMinuteCountdownElement
  ) {

    fiveMinuteCountdownElement.textContent =
      `${formatTime(
        finishedStart
      )} – ${formatTime(end)}`;

  }

}


/* =========================
   PERIOD WATCHER
========================= */

function checkTimeBoundaries() {

  const newMinuteStart =
    getMinuteStart();


  const newFiveMinuteStart =
    getFiveMinuteStart();


  /*
    MINUTE CHANGED
  */

  if (
    newMinuteStart !==
    currentMinuteStart
  ) {

    const finishedMinute =
      newMinuteStart -
      60000;


    finalizeMinute(
      finishedMinute
    );


    currentMinuteStart =
      newMinuteStart;

  }


  /*
    FIVE-MINUTE PERIOD CHANGED
  */

  if (
    newFiveMinuteStart !==
    currentFiveMinuteStart
  ) {

    const finishedFive =
      newFiveMinuteStart -
      300000;


    finalizeFiveMinutes(
      finishedFive
    );


    currentFiveMinuteStart =
      newFiveMinuteStart;

  }

}


/* =========================
   HEARTBEAT
========================= */

function pulse(
  transactionCount = 0
) {

  if (!heartElement) {
    return;
  }


  let strength = 1.10;


  if (
    transactionCount >= 5
  ) {

    strength = 1.12;

  }


  if (
    transactionCount >= 20
  ) {

    strength = 1.14;

  }


  if (
    transactionCount >= 50
  ) {

    strength = 1.17;

  }


  if (
    transactionCount >= 100
  ) {

    strength = 1.20;

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
        .remove("beat");

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
   HEARTBEAT TIME
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
   INITIAL CONNECTION
========================= */

async function connect() {

  /*
    These are intentionally NOT
    fake historical values.
  */

  txMinuteElement.textContent =
    "WAITING";

  txFiveMinutesElement.textContent =
    "WAITING";


  if (
    minuteCountdownElement
  ) {

    minuteCountdownElement.textContent =
      "FOR FULL INTERVAL";

  }


  if (
    fiveMinuteCountdownElement
  ) {

    fiveMinuteCountdownElement.textContent =
      "FOR FULL INTERVAL";

  }


  try {

    const latestHex =
      await rpcCall(
        "eth_blockNumber"
      );


    const latestNumber =
      Number(
        BigInt(latestHex)
      );


    lastBlock =
      latestNumber;


    blockElement.textContent =
      "#" +
      latestNumber.toLocaleString();


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


      /*
        Do NOT store latest historical
        block as tracked live activity.

        We start counting from new
        blocks after connection.
      */

      updateHeartbeatTimer();

    }

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

  }

}


/* =========================
   LIVE BLOCK CHECK
========================= */

async function checkForNewBlocks() {

  if (
    isCheckingBlock ||
    walletChecking ||
    lastBlock === null
  ) {

    return;

  }


  isCheckingBlock =
    true;


  try {

    const latestHex =
      await rpcCall(
        "eth_blockNumber"
      );


    const latestNumber =
      Number(
        BigInt(latestHex)
      );


    if (
      latestNumber <=
      lastBlock
    ) {

      return;

    }


    /*
      Load every missing block.
    */

    for (
      let number = lastBlock + 1;
      number <= latestNumber;
      number++
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
          "Block fetch failed:",
          number,
          error
        );

        /*
          Do not skip missing block.
          We'll retry next poll.
        */

        break;

      }


      const block =
        parseBlock(
          rawBlock
        );


      if (!block) {
        break;
      }


      lastBlock =
        block.number;


      lastBlockTime =
        block.timestamp;


      blockElement.textContent =
        "#" +
        block.number.toLocaleString();


      transactionsElement.textContent =
        block.transactions
          .toLocaleString();


      /*
        This is a genuinely observed
        live block.
      */

      storeBlock(block);


      triggerPulse(
        block.transactions
      );

    }

  }

  catch (error) {

    console.warn(
      "Live polling error:",
      error
    );

  }

  finally {

    isCheckingBlock =
      false;

  }

}


/* =========================
   ADDRESS VALIDATION
========================= */

function isValidAddress(
  address
) {

  return /^0x[a-fA-F0-9]{40}$/
    .test(address);

}


/* =========================
   ETH FORMAT
========================= */

function formatEthBalance(
  balanceHex
) {

  const wei =
    BigInt(balanceHex);


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
      .padStart(18, "0")
      .slice(0, 8)
      .replace(/0+$/, "");


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
    address.slice(0, 10) +
    "..." +
    address.slice(-8)
  );

}


/* =========================
   WALLET CHECKER
========================= */

if (walletForm) {

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
        .remove("error");


      checkerMessage.textContent =
        "";


      walletResult
        .classList
        .add("hidden");


      if (
        !isValidAddress(address)
      ) {

        checkerMessage.textContent =
          "Enter a valid 0x address.";


        checkerMessage
          .classList
          .add("error");


        return;

      }


      walletChecking = true;


      checkButton.disabled = true;


      checkButton.textContent =
        "CHECKING...";


      checkerMessage.textContent =
        "Reading Abstract Mainnet...";


      try {

        const balanceHex =
          await rpcCall(
            "eth_getBalance",
            [
              address,
              "latest"
            ]
          );


        const nonceHex =
          await rpcCall(
            "eth_getTransactionCount",
            [
              address,
              "latest"
            ]
          );


        const ethBalance =
          formatEthBalance(
            balanceHex
          );


        const nonce =
          BigInt(
            nonceHex
          );


        checkedAddress.textContent =
          shortAddress(
            address
          );


        checkedAddress.title =
          address;


        walletBalance.textContent =
          `${ethBalance} ETH`;


        walletNonce.textContent =
          nonce.toLocaleString(
            "en-US"
          );


        checkerMessage.textContent =
          "";


        walletResult
          .classList
          .remove("hidden");

      }

      catch (error) {

        console.error(
          "Wallet checker error:",
          error
        );


        checkerMessage.textContent =
          "Could not read this address. Try again.";


        checkerMessage
          .classList
          .add("error");

      }

      finally {

        walletChecking = false;


        checkButton.disabled = false;


        checkButton.textContent =
          "CHECK";

      }

    }
  );

}


/* =========================
   START
========================= */

connect();


/*
  Live Abstract blocks.
*/

setInterval(
  checkForNewBlocks,
  1500
);


/*
  Detect minute / five-minute
  boundaries accurately.
*/

setInterval(
  checkTimeBoundaries,
  500
);


/*
  Update LAST HEARTBEAT.
*/

setInterval(
  updateHeartbeatTimer,
  1000
);
