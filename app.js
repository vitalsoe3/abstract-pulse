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

let lastPulseTime = 0;

const MIN_PULSE_INTERVAL = 2500;


/* =========================
   RPC
========================= */

async function rpcCall(method, params = []) {
  const controller = new AbortController();

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

          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Math.floor(
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

  } finally {
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
   PULSE
========================= */

function pulse(transactionCount = 0) {
  if (!heartElement) {
    return;
  }

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

  heartElement.classList.remove(
    "beat"
  );

  void heartElement.offsetWidth;

  heartElement.classList.add(
    "beat"
  );

  setTimeout(() => {
    heartElement.classList.remove(
      "beat"
    );
  }, 850);
}


function triggerPulse(transactionCount) {
  const now = Date.now();

  if (
    now - lastPulseTime <
    MIN_PULSE_INTERVAL
  ) {
    return;
  }

  lastPulseTime = now;

  pulse(transactionCount);
}


/* =========================
   PERIOD FORMAT
========================= */

function formatTime(timestamp) {
  const date =
    new Date(timestamp);

  return date.toLocaleTimeString(
    [],
    {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }
  );
}


function formatPeriod(start, end) {
  return (
    formatTime(start) +
    " – " +
    formatTime(end)
  );
}


/* =========================
   SERVER STATS
========================= */

async function loadStats() {
  try {
    const response =
      await fetch(
        "/api/stats",
        {
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        `Stats HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data.lastMinute ||
      !data.lastFiveMinutes
    ) {
      throw new Error(
        "Invalid stats response"
      );
    }

    /*
      LAST COMPLETED MINUTE
    */

    txMinuteElement.textContent =
      Number(
        data.lastMinute.transactions
      ).toLocaleString();

    if (minuteCountdownElement) {
      minuteCountdownElement.textContent =
        formatPeriod(
          data.lastMinute.start,
          data.lastMinute.end
        );
    }

    /*
      LAST COMPLETED 5 MINUTES
    */

    txFiveMinutesElement.textContent =
      Number(
        data.lastFiveMinutes.transactions
      ).toLocaleString();

    if (fiveMinuteCountdownElement) {
      fiveMinuteCountdownElement.textContent =
        formatPeriod(
          data.lastFiveMinutes.start,
          data.lastFiveMinutes.end
        );
    }

  } catch (error) {
    console.error(
      "Stats error:",
      error
    );

    /*
      Do not replace a previously valid
      value if one refresh fails.
    */

    if (
      txMinuteElement.textContent ===
      "LOADING..."
    ) {
      txMinuteElement.textContent =
        "—";
    }

    if (
      txFiveMinutesElement.textContent ===
      "LOADING..."
    ) {
      txFiveMinutesElement.textContent =
        "—";
    }
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
        ) /
        1000
      )
    );

  if (seconds === 0) {
    heartbeatElement.textContent =
      "NOW";

  } else if (seconds === 1) {
    heartbeatElement.textContent =
      "1s ago";

  } else {
    heartbeatElement.textContent =
      `${seconds}s ago`;
  }
}


/* =========================
   INITIAL CONNECTION
========================= */

async function connect() {
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
      parseBlock(rawBlock);

    if (block) {
      lastBlockTime =
        block.timestamp;

      transactionsElement.textContent =
        block.transactions
          .toLocaleString();

      updateHeartbeatTimer();
    }

  } catch (error) {
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
   LIVE BLOCKS
========================= */

async function checkForNewBlocks() {
  if (
    isCheckingBlock ||
    walletChecking ||
    lastBlock === null
  ) {
    return;
  }

  isCheckingBlock = true;

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
      Fetch every block missed
      between polls.
    */

    for (
      let number = lastBlock + 1;
      number <= latestNumber;
      number++
    ) {
      let rawBlock;

      try {
        rawBlock =
          await getBlock(number);

      } catch (error) {
        console.warn(
          "Block fetch failed:",
          number,
          error
        );

        break;
      }

      const block =
        parseBlock(rawBlock);

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
        Only genuinely new blocks
        trigger the logo pulse.
      */

      triggerPulse(
        block.transactions
      );
    }

  } catch (error) {
    console.warn(
      "Live polling error:",
      error
    );

  } finally {
    isCheckingBlock = false;
  }
}


/* =========================
   ADDRESS
========================= */

function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/
    .test(address);
}


/* =========================
   ETH FORMAT
========================= */

function formatEthBalance(balanceHex) {
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

function shortAddress(address) {
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
          BigInt(nonceHex);

        checkedAddress.textContent =
          shortAddress(address);

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

      } catch (error) {
        console.error(
          "Wallet checker error:",
          error
        );

        checkerMessage.textContent =
          "Could not read this address. Try again.";

        checkerMessage
          .classList
          .add("error");

      } finally {
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

txMinuteElement.textContent =
  "LOADING...";

txFiveMinutesElement.textContent =
  "LOADING...";


/*
  Load independent parts immediately.
*/

connect();

loadStats();


/*
  Live blockchain.
*/

setInterval(
  checkForNewBlocks,
  1500
);


/*
  Heartbeat timer.
*/

setInterval(
  updateHeartbeatTimer,
  1000
);


/*
  Refresh finished statistics
  every 30 seconds.

  Server cache prevents every visitor
  from independently hammering RPC.
*/

setInterval(
  loadStats,
  30000
);
