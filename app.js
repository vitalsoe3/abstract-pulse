const RPC_URL = "https://api.mainnet.abs.xyz";

/* =========================
   ELEMENTS
========================= */

const blockElement = document.getElementById("blockNumber");
const transactionsElement = document.getElementById("transactions");
const txMinuteElement = document.getElementById("txMinute");
const txFiveMinutesElement = document.getElementById("txFiveMinutes");
const heartbeatElement = document.getElementById("heartbeat");
const heartElement = document.getElementById("heart");

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
let walletChecking = false;

let lastPulseTime = 0;

const MIN_PULSE_INTERVAL = 3000;

/* =========================
   RPC
========================= */

async function rpcCall(method, params = []) {

  const response = await fetch(RPC_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(
      data.error.message || "Abstract RPC error"
    );
  }

  if (data.result === undefined) {
    throw new Error("No result returned by RPC");
  }

  return data.result;
}

/* =========================
   BLOCK HELPERS
========================= */

async function getBlock(number) {

  const hex = "0x" + number.toString(16);

  return rpcCall(
    "eth_getBlockByNumber",
    [hex, false]
  );
}

function parseBlock(block) {

  if (!block) return null;

  return {
    number: parseInt(block.number, 16),

    timestamp:
      parseInt(block.timestamp, 16) * 1000,

    transactions:
      Array.isArray(block.transactions)
        ? block.transactions.length
        : 0
  };
}

/* =========================
   PULSE
========================= */

function pulse(transactionCount = 0) {

  if (!heartElement) return;

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

  heartElement.classList.remove("beat");

  void heartElement.offsetWidth;

  heartElement.classList.add("beat");

  setTimeout(() => {
    heartElement.classList.remove("beat");
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
   BLOCK HISTORY
========================= */

function addBlock(block) {

  if (!block) return;

  const exists = blockHistory.some(
    item => item.number === block.number
  );

  if (!exists) {
    blockHistory.push(block);
  }
}

/* =========================
   ACTIVITY
========================= */

function updateActivity() {

  const now = Date.now();

  const minuteCutoff =
    now - 60000;

  const fiveMinuteCutoff =
    now - 300000;

  blockHistory = blockHistory.filter(
    block =>
      block.timestamp >= fiveMinuteCutoff
  );

  let txMinute = 0;
  let txFiveMinutes = 0;

  for (const block of blockHistory) {

    if (
      block.timestamp >= minuteCutoff
    ) {
      txMinute += block.transactions;
    }

    txFiveMinutes += block.transactions;
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

    const latestHex =
      await rpcCall("eth_blockNumber");

    const latestNumber =
      parseInt(latestHex, 16);

    lastBlock = latestNumber;

    blockElement.textContent =
      "#" + latestNumber.toLocaleString();

    const rawBlock =
      await getBlock(latestNumber);

    const block =
      parseBlock(rawBlock);

    if (block) {

      lastBlockTime =
        block.timestamp;

      transactionsElement.textContent =
        block.transactions.toLocaleString();

      addBlock(block);

      updateActivity();
      updateHeartbeatTimer();
    }

    startLivePolling();

    /*
      Wait before history scanning.

      This gives the live network
      and wallet checker priority.
    */

    setTimeout(
      loadHistory,
      2500
    );

  } catch (error) {

    console.error(
      "Abstract connection error:",
      error
    );

    blockElement.textContent =
      "RPC ERROR";
  }
}

/* =========================
   LIVE BLOCKS
========================= */

async function checkForNewBlock() {

  /*
    Wallet checker gets priority.
  */

  if (
    walletChecking ||
    isCheckingBlock ||
    lastBlock === null
  ) {
    return;
  }

  isCheckingBlock = true;

  try {

    const latestHex =
      await rpcCall("eth_blockNumber");

    const latestNumber =
      parseInt(latestHex, 16);

    if (latestNumber <= lastBlock) {
      return;
    }

    const rawBlock =
      await getBlock(latestNumber);

    const block =
      parseBlock(rawBlock);

    if (!block) return;

    lastBlock =
      block.number;

    lastBlockTime =
      block.timestamp;

    blockElement.textContent =
      "#" +
      block.number.toLocaleString();

    transactionsElement.textContent =
      block.transactions.toLocaleString();

    addBlock(block);

    updateActivity();

    triggerPulse(
      block.transactions
    );

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
   LIVE POLLING
========================= */

function startLivePolling() {

  if (livePollingStarted) return;

  livePollingStarted = true;

  /*
    2 seconds is more than enough
    for this visualizer and reduces
    RPC pressure.
  */

  setInterval(
    checkForNewBlock,
    2000
  );

  setInterval(() => {

    updateHeartbeatTimer();
    updateActivity();

  }, 1000);
}

/* =========================
   HISTORY
========================= */

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

async function loadHistory() {

  if (
    historyLoading ||
    lastBlock === null
  ) {
    return;
  }

  historyLoading = true;

  let historyBlock =
    lastBlock - 1;

  const cutoff =
    Date.now() - 300000;

  /*
    Safety limit only.
    We stop once we pass 5 min.
  */

  const MAX_BLOCKS = 300;

  try {

    for (
      let i = 0;
      i < MAX_BLOCKS;
      i++
    ) {

      /*
        Pause history scanning while
        someone is checking a wallet.
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
          "History request stopped:",
          error
        );

        break;
      }

      const block =
        parseBlock(rawBlock);

      if (!block) break;

      if (
        block.timestamp < cutoff
      ) {
        break;
      }

      addBlock(block);

      /*
        Don't hammer the public RPC.
      */

      await sleep(80);

      historyBlock--;
    }

  } finally {

    historyLoading = false;

    updateActivity();
  }
}

/* =========================
   HEARTBEAT
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

  } else if (seconds === 1) {

    heartbeatElement.textContent =
      "1s ago";

  } else {

    heartbeatElement.textContent =
      `${seconds}s ago`;
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

function formatEthBalance(hex) {

  const wei =
    BigInt(hex);

  const unit =
    1000000000000000000n;

  const whole =
    wei / unit;

  const remainder =
    wei % unit;

  let fraction =
    remainder
      .toString()
      .padStart(18, "0")
      .slice(0, 8)
      .replace(/0+$/, "");

  if (!fraction) {
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

walletForm.addEventListener(
  "submit",
  async event => {

    event.preventDefault();

    const address =
      walletInput.value.trim();

    checkerMessage.classList.remove(
      "error"
    );

    checkerMessage.textContent = "";

    walletResult.classList.add(
      "hidden"
    );

    if (!isValidAddress(address)) {

      checkerMessage.textContent =
        "Enter a valid 0x address.";

      checkerMessage.classList.add(
        "error"
      );

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
        IMPORTANT:
        sequential requests.

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
        Small gap before nonce.
      */

      await sleep(150);

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
        shortAddress(address);

      checkedAddress.title =
        address;

      walletBalance.textContent =
        `${balance} ETH`;

      walletNonce.textContent =
        nonce.toLocaleString();

      checkerMessage.textContent =
        "";

      walletResult.classList.remove(
        "hidden"
      );

    } catch (error) {

      /*
        This will also show the
        actual RPC problem in
        browser DevTools.
      */

      console.error(
        "ADDRESS CHECK FAILED:",
        error
      );

      checkerMessage.textContent =
        "Could not read this address. Try again.";

      checkerMessage.classList.add(
        "error"
      );

    } finally {

      walletChecking = false;

      checkButton.disabled = false;

      checkButton.textContent =
        "CHECK";
    }
  }
);

/* =========================
   START
========================= */

connect();
