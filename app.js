const RPC_URL =
  "https://api.mainnet.abs.xyz";


const blockElement =
  document.getElementById(
    "blockNumber"
  );

const transactionsElement =
  document.getElementById(
    "transactions"
  );

const txMinuteElement =
  document.getElementById(
    "txMinute"
  );

const txFiveMinutesElement =
  document.getElementById(
    "txFiveMinutes"
  );

const heartbeatElement =
  document.getElementById(
    "heartbeat"
  );

const heartElement =
  document.getElementById(
    "heart"
  );


let lastBlock = null;

let lastBlockTime = null;

let blockHistory = [];

let initialized = false;


/* =========================
   RPC
   ========================= */

async function rpcCall(
  method,
  params = []
) {

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

          })

      }
    );


  if (!response.ok) {

    throw new Error(
      `RPC error ${response.status}`
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


/* =========================
   GET BLOCK
   ========================= */

async function getBlock(
  blockNumber
) {

  const hex =
    "0x" +
    blockNumber
      .toString(16);


  return await rpcCall(

    "eth_getBlockByNumber",

    [
      hex,
      false
    ]

  );
}


/* =========================
   BLOCK DATA
   ========================= */

function parseBlock(
  block
) {

  if (!block) {
    return null;
  }


  const number =
    parseInt(
      block.number,
      16
    );


  const timestamp =
    parseInt(
      block.timestamp,
      16
    ) * 1000;


  const transactions =
    Array.isArray(
      block.transactions
    )
      ? block.transactions.length
      : 0;


  return {

    number:
      number,

    timestamp:
      timestamp,

    transactions:
      transactions

  };
}


/* =========================
   INITIAL HISTORY
   ========================= */

async function loadHistory() {

  txMinuteElement.textContent =
    "...";


  txFiveMinutesElement.textContent =
    "...";


  const latestHex =
    await rpcCall(
      "eth_blockNumber"
    );


  const latestNumber =
    parseInt(
      latestHex,
      16
    );


  const now =
    Date.now();


  const cutoff =
    now -
    300000;


  let current =
    latestNumber;


  const history = [];


  /*
    Walk backwards through
    real blocks until reaching
    five minutes ago.

    Safety limit prevents an
    accidental endless request
    loop.
  */

  const MAX_BLOCKS =
    1000;


  for (
    let i = 0;
    i < MAX_BLOCKS;
    i++
  ) {

    const rawBlock =
      await getBlock(
        current
      );


    const block =
      parseBlock(
        rawBlock
      );


    if (!block) {
      break;
    }


    history.push(
      block
    );


    if (
      block.timestamp <
      cutoff
    ) {

      break;
    }


    current--;

  }


  blockHistory =
    history;


  const latest =
    history[0];


  if (latest) {

    lastBlock =
      latest.number;


    lastBlockTime =
      latest.timestamp;


    blockElement.textContent =
      `#${latest.number.toLocaleString()}`;


    transactionsElement.textContent =
      latest.transactions
        .toLocaleString();

  }


  initialized =
    true;


  updateActivity();

}


/* =========================
   ACTIVITY
   ========================= */

function updateActivity() {

  const now =
    Date.now();


  const oneMinuteAgo =
    now -
    60000;


  const fiveMinutesAgo =
    now -
    300000;


  let txMinute =
    0;


  let txFiveMinutes =
    0;


  blockHistory =
    blockHistory.filter(

      block =>
        block.timestamp >=
        fiveMinutesAgo

    );


  for (
    const block
    of blockHistory
  ) {

    if (
      block.timestamp >=
      fiveMinutesAgo
    ) {

      txFiveMinutes +=
        block.transactions;

    }


    if (
      block.timestamp >=
      oneMinuteAgo
    ) {

      txMinute +=
        block.transactions;

    }

  }


  txMinuteElement.textContent =
    txMinute.toLocaleString();


  txFiveMinutesElement.textContent =
    txFiveMinutes.toLocaleString();

}


/* =========================
   HEARTBEAT
   ========================= */

function heartbeat() {

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
   CHECK NEW BLOCK
   ========================= */

async function checkAbstract() {

  if (!initialized) {
    return;
  }


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
      More than one block may
      have appeared between
      polling requests.

      Process every missing
      block so TX counts stay
      accurate.
    */

    for (

      let number =
        lastBlock + 1;

      number <=
        latestNumber;

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


      blockHistory.unshift(
        block
      );


      lastBlock =
        block.number;


      lastBlockTime =
        block.timestamp;


      blockElement.textContent =
        `#${block.number.toLocaleString()}`;


      transactionsElement.textContent =
        block.transactions
          .toLocaleString();


      /*
        One actual block =
        one heartbeat.
      */

      heartbeat();

    }


    updateActivity();

  }

  catch (error) {

    console.error(
      "Abstract RPC error:",
      error
    );

  }

}


/* =========================
   LAST HEARTBEAT
   ========================= */

function updateHeartbeatTimer() {

  if (!lastBlockTime) {
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
    seconds < 1
  ) {

    heartbeatElement.textContent =
      "NOW";

  }

  else {

    heartbeatElement.textContent =
      `${seconds}s ago`;

  }

}


/* =========================
   START
   ========================= */

async function start() {

  try {

    await loadHistory();


    updateHeartbeatTimer();


    setInterval(
      checkAbstract,
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

  catch (error) {

    console.error(
      "Failed to initialize Abstract Pulse:",
      error
    );


    blockElement.textContent =
      "Connection error";


    txMinuteElement.textContent =
      "—";


    txFiveMinutesElement.textContent =
      "—";

  }

}


start();
