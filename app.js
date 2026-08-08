const RPC_URL = "https://api.mainnet.abs.xyz";

/* =========================
   ELEMENTS
========================= */

const blockElement = document.getElementById("blockNumber");
const transactionsElement = document.getElementById("transactions");
const txMinuteElement = document.getElementById("txMinute");
const txFiveMinutesElement = document.getElementById("txFiveMinutes");
const minuteCountdownElement = document.getElementById("minuteCountdown");
const fiveMinuteCountdownElement = document.getElementById("fiveMinuteCountdown");
const heartbeatElement = document.getElementById("heartbeat");
const heartElement = document.getElementById("heart");

/* CHECKER */

const walletForm = document.getElementById("walletForm");
const walletInput = document.getElementById("walletInput");
const checkButton = document.getElementById("checkButton");
const walletResult = document.getElementById("walletResult");
const checkerMessage = document.getElementById("checkerMessage");
const checkedAddress = document.getElementById("checkedAddress");
const walletBalance = document.getElementById("walletBalance");
const walletNonce = document.getElementById("walletNonce");

/* =========================
   STATE
========================= */

let lastBlock = null;
let lastBlockTime = null;

let blockHistory = [];

let livePollingStarted = false;
let isCheckingBlock = false;
let historyLoading = false;
let historyReady = false;
let walletChecking = false;

let lastPulseTime = 0;

const MIN_PULSE_INTERVAL = 3000;

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
    Math.floor(date.getMinutes() / 5) * 5;

  date.setMinutes(minute, 0, 0);

  return date.getTime();
}

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

/* =========================
   RPC
========================= */

async function rpcCall(method, params = []) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    8000
  );

  try {
    const response = await fetch(
      RPC_URL,
      {
        method: "POST",
        mode: "cors",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Math.floor(
            Math.random() * 1000000000
          ),
          method,
          params
        }),

        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data = await response.json();

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
        "RPC returned no result"
      );
    }

    return data.result;

  } finally {
    clearTimeout(timeout);
  }
}

/* =========================
   BLOCK HELPERS
========================= */

async function getBlock(number) {
  const hex =
    "0x" + number.toString(16);

  return rpcCall(
    "eth_getBlockByNumber",
    [hex, false]
  );
}

function parseBlock(block) {
  if (!block) {
    return null;
  }

  return {
    number:
      Number(BigInt(block.number)),

    timestamp:
      Number(BigInt(block.timestamp)) *
      1000,

    transactions:
      Array.isArray(block.transactions)
        ? block.transactions.length
        : 0
  };
}

/* =========================
   BLOCK STORAGE
========================= */

function addBlock(block) {
  if (!block) {
    return;
  }

  const exists =
    blockHistory.some(
      item =>
        item.number === block.number
    );

  if (!exists) {
    blockHistory.push(block);
  }
}

/* =========================
   HEARTBEAT ANIMATION
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

function triggerPulse(
  transactionCount
) {
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
   TRANSACTION COUNTERS
========================= */

function updateActivity() {
  /*
    Do not display partial
    historical results.
  */

  if (!historyReady) {
    txMinuteElement.textContent =
      "SYNCING...";

    txFiveMinutesElement.textContent =
      "SYNCING...";

    return;
  }

  const now = Date.now();

  const minuteStart =
    getMinuteStart(now);

  const fiveMinuteStart =
    getFiveMinuteStart(now);

  /*
    Remove blocks from previous
    five-minute intervals.
  */

  blockHistory =
    blockHistory.filter(
      block =>
        block.timestamp >=
        fiveMinuteStart
    );

  let txMinute = 0;
  let txFiveMinutes = 0;

  for (const block of blockHistory) {
    /*
      Current calendar minute.
    */

    if (
      block.timestamp >=
      minuteStart
    ) {
      txMinute +=
        block.transactions;
    }

    /*
      Current fixed 5-minute
      interval.
    */

    if (
      block.timestamp >=
      fiveMinuteStart
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
   COUNTDOWNS
========================= */

function updateCountdowns() {
  const now = Date.now();

  /*
    NEXT CALENDAR MINUTE
  */

  const nextMinute =
    getMinuteStart(now) +
    60000;

  let minuteSeconds =
    Math.ceil(
      (nextMinute - now) /
      1000
    );

  minuteSeconds =
    Math.max(
      0,
      minuteSeconds
    );

  if (minuteCountdownElement) {
    minuteCountdownElement.textContent =
      `RESET IN ${minuteSeconds}s`;
  }

  /*
    NEXT FIXED 5-MINUTE
    BOUNDARY
  */

  const nextFive =
    getFiveMinuteStart(now) +
    300000;

  let totalSeconds =
    Math.ceil(
      (nextFive - now) /
      1000
    );

  totalSeconds =
    Math.max(
      0,
      totalSeconds
    );

  const minutes =
    Math.floor(
      totalSeconds / 60
    );

  const seconds =
    totalSeconds % 60;

  if (fiveMinuteCountdownElement) {
    if (minutes > 0) {
      fiveMinuteCountdownElement.textContent =
        `RESET IN ${minutes}m ${seconds}s`;
    } else {
      fiveMinuteCountdownElement.textContent =
        `RESET IN ${seconds}s`;
    }
  }
}

/* =========================
   CONNECT TO ABSTRACT
========================= */

async function connect() {
  /*
    IMPORTANT:

    Start UI timers immediately.

    The page does NOT wait for
    historical sync.
  */

  startLivePolling();

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

    /*
      Get latest block.
    */

    try {
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

        addBlock(block);

        updateHeartbeatTimer();
      }

    } catch (error) {
      console.warn(
        "Latest block error:",
        error
      );
    }

    /*
      Start historical sync
      separately.

      Live UI keeps working.
    */

    loadHistory();

  } catch (error) {
    console.error(
      "Abstract RPC connection failed:",
      error
    );

    blockElement.textContent =
      "RPC ERROR";

    transactionsElement.textContent =
      "—";
  }
}

/* =========================
   HISTORY SYNC
========================= */

async function loadHistory() {
  if (
    historyLoading ||
    lastBlock === null
  ) {
    return;
  }

  historyLoading = true;
  historyReady = false;

  txMinuteElement.textContent =
    "SYNCING...";

  txFiveMinutesElement.textContent =
    "SYNCING...";

  /*
    Snapshot the current fixed
    5-minute interval.

    We must reach a block older
    than this timestamp before
    declaring the data complete.
  */

  const cutoff =
    getFiveMinuteStart();

  let historyBlock =
    lastBlock - 1;

  const MAX_BLOCKS = 500;

  let reachedStart = false;

  try {
    for (
      let i = 0;
      i < MAX_BLOCKS;
      i++
    ) {
      /*
        Give wallet requests
        priority.
      */

      while (walletChecking) {
        await sleep(250);
      }

      let rawBlock;

      try {
        rawBlock =
          await getBlock(
            historyBlock
          );

      } catch (error) {
        console.warn(
          "History request failed:",
          error
        );

        break;
      }

      const block =
        parseBlock(rawBlock);

      if (!block) {
        break;
      }

      /*
        We have now crossed the
        beginning of the current
        5-minute interval.

        That proves the history
        is complete.
      */

      if (
        block.timestamp <
        cutoff
      ) {
        reachedStart = true;
        break;
      }

      /*
        Store silently.

        IMPORTANT:
        do NOT update the visible
        counters while old blocks
        are being loaded.
      */

      addBlock(block);

      historyBlock--;

      /*
        Small delay to avoid
        hammering public RPC.
      */

      await sleep(25);
    }

    if (reachedStart) {
      /*
        NOW the values are complete.

        Show them all at once.
      */

      historyReady = true;

      updateActivity();

    } else {
      /*
        Never present incomplete
        data as a valid total.
      */

      console.warn(
        "Could not completely reconstruct the current five-minute interval."
      );

      txMinuteElement.textContent =
        "SYNC ERROR";

      txFiveMinutesElement.textContent =
        "SYNC ERROR";
    }

  } catch (error) {
    console.error(
      "History sync error:",
      error
    );

    txMinuteElement.textContent =
      "SYNC ERROR";

    txFiveMinutesElement.textContent =
      "SYNC ERROR";

  } finally {
    historyLoading = false;
  }
}

/* =========================
   LIVE BLOCKS
========================= */

async function checkForNewBlock() {
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
      Fetch every block that
      appeared since last poll.

      This prevents missing blocks.
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
          `Could not fetch block ${number}:`,
          error
        );

        /*
          Stop here.

          We do NOT skip the block,
          because that could make
          transaction totals wrong.
        */

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

      addBlock(block);

      /*
        Visible counters update
        only after initial history
        has been completely synced.
      */

      if (historyReady) {
        updateActivity();
      }

      /*
        Historical loading never
        triggers pulse.

        Only genuinely new blocks.
      */

      triggerPulse(
        block.transactions
      );
    }

  } catch (error) {
    console.warn(
      "Live block error:",
      error
    );

  } finally {
    isCheckingBlock = false;
  }
}

/* =========================
   PERIOD CHANGE
========================= */

let previousMinuteStart =
  getMinuteStart();

let previousFiveMinuteStart =
  getFiveMinuteStart();

function detectPeriodChange() {
  const currentMinuteStart =
    getMinuteStart();

  const currentFiveMinuteStart =
    getFiveMinuteStart();

  /*
    NEW MINUTE
  */

  if (
    currentMinuteStart !==
    previousMinuteStart
  ) {
    previousMinuteStart =
      currentMinuteStart;

    if (historyReady) {
      updateActivity();
    }
  }

  /*
    NEW 5-MINUTE PERIOD
  */

  if (
    currentFiveMinuteStart !==
    previousFiveMinuteStart
  ) {
    previousFiveMinuteStart =
      currentFiveMinuteStart;

    /*
      Remove previous period.
    */

    blockHistory =
      blockHistory.filter(
        block =>
          block.timestamp >=
          currentFiveMinuteStart
      );

    /*
      We are already live.

      No historical reconstruction
      is needed because we've been
      watching every new block.
    */

    if (historyReady) {
      updateActivity();
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
   LIVE POLLING
========================= */

function startLivePolling() {
  if (livePollingStarted) {
    return;
  }

  livePollingStarted = true;

  /*
    Countdown begins instantly.
  */

  updateCountdowns();

  /*
    Check Abstract for new blocks.
  */

  setInterval(
    checkForNewBlock,
    1500
  );

  /*
    UI clock.
  */

  setInterval(() => {
    updateCountdowns();

    detectPeriodChange();

    updateHeartbeatTimer();

  }, 1000);
}

/* =========================
   ADDRESS VALIDATION
========================= */

function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/
    .test(address);
}

/* =========================
   ETH BALANCE FORMAT
========================= */

function formatEthBalance(
  balanceHex
) {
  const wei =
    BigInt(balanceHex);

  const WEI_PER_ETH =
    1000000000000000000n;

  const whole =
    wei / WEI_PER_ETH;

  const remainder =
    wei % WEI_PER_ETH;

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
          Small pause between
          public RPC calls.
        */

        await sleep(120);

        /*
          Account nonce.
        */

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
          "Abstract RPC could not read this address. Try again.";

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

connect();
