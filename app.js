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

let blockHistory = [];

let livePollingStarted = false;

let isCheckingBlock = false;

let historyLoading = false;

let lastPulseTime = 0;


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
      8000
    );


  try {

    const response =
      await fetch(
        RPC_URL,
        {

          method: "POST",

          mode: "cors",

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
              method: method,
              params: params
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


    if (
      data.error
    ) {

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

  }

  finally {

    clearTimeout(timeout);

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
      Number(
        BigInt(
          block.number
        )
      ),

    timestamp:
      Number(
        BigInt(
          block.timestamp
        )
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
   BLOCK HISTORY
========================= */

function addBlock(
  block
) {

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
   TX ACTIVITY
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


  let txMinute =
    0;


  let txFiveMinutes =
    0;


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
   CONNECT
========================= */

async function connect() {

  try {

    const latestHex =
      await rpcCall(
        "eth_blockNumber"
      );


    const latestNumber =
      Number(
        BigInt(
          latestHex
        )
      );


    lastBlock =
      latestNumber;


    blockElement.textContent =
      `#${latestNumber.toLocaleString()}`;


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
        "Latest block error:",
        error
      );

    }


    startLivePolling();


    loadHistory();

  }

  catch (error) {

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
   LIVE BLOCK
========================= */

async function checkForNewBlock() {

  if (
    isCheckingBlock ||
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
        BigInt(
          latestHex
        )
      );


    if (
      latestNumber <=
      lastBlock
    ) {

      return;

    }


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


    triggerPulse(
      block.transactions
    );

  }

  catch (error) {

    console.warn(
      "Live block error:",
      error
    );

  }

  finally {

    isCheckingBlock =
      false;

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


  livePollingStarted =
    true;


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


  historyLoading =
    true;


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


      addBlock(
        block
      );


      updateActivity();


      historyBlock--;

    }

  }

  finally {

    historyLoading =
      false;


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

  return (
    /^0x[a-fA-F0-9]{40}$/
      .test(
        address
      )
  );

}


/* =========================
   FORMAT ETH
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
      );


  /*
    Keep up to 8 decimal
    places without using
    floating point math.
  */

  fraction =
    fraction
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


    /*
      Validate before
      sending RPC request.
    */

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


    checkButton.disabled =
      true;


    checkButton.textContent =
      "CHECKING...";


    checkerMessage.textContent =
      "Reading Abstract Mainnet...";


    try {

      /*
        Only TWO RPC requests.

        No eth_getCode.
        No third metric.
      */

      const results =
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
          )

        ]);


      const balanceHex =
        results[0];


      const nonceHex =
        results[1];


      /*
        Convert real
        on-chain values.
      */

      const ethBalance =
        formatEthBalance(
          balanceHex
        );


      const nonce =
        BigInt(
          nonceHex
        );


      /*
        Display result.
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
        nonce.toLocaleString(
          "en-US"
        );


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
        "Wallet checker RPC error:",
        error
      );


      checkerMessage.textContent =
        "Abstract RPC could not read this address. Try again.";


      checkerMessage
        .classList
        .add(
          "error"
        );

    }

    finally {

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

connect();
