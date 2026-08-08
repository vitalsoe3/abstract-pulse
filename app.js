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

const heartbeatElement =
  document.getElementById("heartbeat");

const heartElement =
  document.getElementById("heart");


/* CHECKER */

const walletForm =
  document.getElementById("walletForm");

const walletInput =
  document.getElementById("walletInput");

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

const walletType =
  document.getElementById("walletType");


/* =========================
   STATE
========================= */

let lastBlock = null;

let lastBlockTime = null;

let blockHistory = [];

let livePollingStarted = false;

let isChecking = false;

let historyLoading = false;

let lastPulseTime = 0;


/*
  Prevent the logo from
  pulsing constantly when
  Abstract produces blocks
  very quickly.
*/

const MIN_PULSE_INTERVAL =
  3000;


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

          body:
            JSON.stringify({
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
   BLOCK HELPERS
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
   PULSE
========================= */

function pulse(
  transactionCount = 0
) {

  if (!heartElement) {
    return;
  }


  /*
    Current block activity
    changes only the visual
    strength of the pulse.
  */

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


  heartElement
    .style
    .setProperty(
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


function triggerPulse(
  transactionCount
) {

  const now =
    Date.now();


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

    blockHistory.push(
      block
    );

  }

}


/* =========================
   ACTIVITY
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
      Fetch latest block data.
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


        transactionsElement
          .textContent =
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


    startLivePolling();


    /*
      History loads separately
      and never triggers pulse.
    */

    loadHistory();

  }

  catch (error) {

    console.error(
      "Abstract connection error:",
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


    if (
      latestNumber <=
      lastBlock
    ) {

      return;

    }


    /*
      Fetch only newest block.
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


    lastBlock =
      block.number;


    lastBlockTime =
      block.timestamp;


    blockElement.textContent =
      `#${block.number.toLocaleString()}`;


    transactionsElement
      .textContent =
      block.transactions
        .toLocaleString();


    addBlock(
      block
    );


    updateActivity();


    /*
      Only LIVE newest blocks
      can animate the logo.

      Historical TX / MIN data
      cannot trigger this.
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

    isChecking = false;

  }

}


/* =========================
   LIVE POLLING
========================= */

function startLivePolling() {

  if (
    livePollingStarted
  ) {

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
   HISTORY
========================= */

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
    Date.now() -
    300000;


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

      catch {

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
        Historical block:
        statistics only.
    */

      addBlock(
        block
      );


      updateActivity();


      historyBlock--;

    }

  }

  finally {

    historyLoading = false;

    updateActivity();

  }

}


/* =========================
   HEARTBEAT TIMER
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
   ADDRESS VALIDATION
========================= */

function isValidAddress(
  address
) {

  return /^0x[a-fA-F0-9]{40}$/
    .test(address);

}


/* =========================
   FORMAT ETH
========================= */

function weiHexToEth(
  hexValue
) {

  /*
    RPC returns balance
    as hexadecimal Wei.

    BigInt prevents precision
    loss for large balances.
  */

  const wei =
    BigInt(hexValue);


  const divisor =
    10n ** 18n;


  const whole =
    wei / divisor;


  const remainder =
    wei % divisor;


  let decimals =
    remainder
      .toString()
      .padStart(
        18,
        "0"
      );


  /*
    Show up to six decimals.
  */

  decimals =
    decimals
      .slice(0, 6)
      .replace(
        /0+$/,
        ""
      );


  if (
    decimals.length === 0
  ) {

    return whole.toString();

  }


  return (
    whole.toString() +
    "." +
    decimals
  );

}


/* =========================
   SHORT ADDRESS
========================= */

function shortAddress(
  address
) {

  return (
    address.slice(0, 8) +
    "..." +
    address.slice(-6)
  );

}


/* =========================
   ADDRESS CHECKER
========================= */

walletForm.addEventListener(
  "submit",

  async function(event) {

    event.preventDefault();


    const address =
      walletInput
        .value
        .trim();


    /*
      Clear previous state.
    */

    checkerMessage
      .classList
      .remove("error");


    walletResult
      .classList
      .add("hidden");


    if (
      !isValidAddress(
        address
      )
    ) {

      checkerMessage
        .textContent =
        "Enter a valid 0x address.";


      checkerMessage
        .classList
        .add("error");


      return;

    }


    const button =
      walletForm
        .querySelector("button");


    button.disabled =
      true;


    button.textContent =
      "CHECKING...";


    checkerMessage
      .textContent =
      "Reading Abstract Mainnet...";


    try {

      /*
        Run all three independent
        RPC requests together.
      */

      const [
        balanceHex,
        nonceHex,
        code
      ] =
        await Promise.all([

          rpcCall(
            "eth_getBalance",
            [
              address,
              "latest"
            ]
          ),

          rpcCall(
            "eth_getTransactionCount",
            [
              address,
              "latest"
            ]
          ),

          rpcCall(
            "eth_getCode",
            [
              address,
              "latest"
            ]
          )

        ]);


      /*
        BALANCE
      */

      const ethBalance =
        weiHexToEth(
          balanceHex
        );


      /*
        ACCOUNT NONCE
      */

      const nonce =
        parseInt(
          nonceHex,
          16
        );


      /*
        ADDRESS TYPE

        Empty code = normal
        externally controlled
        address.

        Non-empty code =
        contract code exists
        at address.
      */

      const isContract =
        code &&
        code !== "0x" &&
        code !== "0x0";


      /*
        DISPLAY
      */

      checkedAddress.textContent =
        shortAddress(
          address
        );


      checkedAddress.title =
        address;


      walletBalance.textContent =
        `${ethBalance} ETH`;


      walletNonce.textContent =
        nonce.toLocaleString();


      walletType.textContent =
        isContract
          ? "CONTRACT"
          : "WALLET";


      checkerMessage.textContent =
        "";


      walletResult
        .classList
        .remove("hidden");

    }

    catch (error) {

      console.error(
        "Address checker error:",
        error
      );


      checkerMessage.textContent =
        "Could not read this address. Try again.";


      checkerMessage
        .classList
        .add("error");

    }

    finally {

      button.disabled =
        false;


      button.textContent =
        "CHECK";

    }

  }
);


/* =========================
   START
========================= */

connect();
