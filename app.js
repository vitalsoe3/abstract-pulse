const RPC_URL =
  "https://api.mainnet.abs.xyz";


/* =========================
   ELEMENTS
   ========================= */

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

const heartbeatElement =
  document.getElementById(
    "heartbeat"
  );

const heartElement =
  document.getElementById(
    "heart"
  );


/* =========================
   STATE
   ========================= */

let lastBlock = null;

let lastBlockTime = null;


/*
  Stores transaction counts
  from blocks detected during
  the last 60 seconds.
*/

let recentBlocks = [];


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

            id: 1,

            method:
              method,

            params:
              params

          })

      }
    );


  if (!response.ok) {

    throw new Error(
      `RPC error: ${response.status}`
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
   HEARTBEAT
   ========================= */

function heartbeat(
  transactionCount
) {

  heartElement
    .classList
    .remove("beat");


  /*
    More transactions =
    stronger glow.

    Rhythm DOES NOT change.
  */

  let glow = 0.35;


  if (
    transactionCount >= 10
  ) {

    glow = 0.50;

  }


  if (
    transactionCount >= 50
  ) {

    glow = 0.70;

  }


  if (
    transactionCount >= 100
  ) {

    glow = 0.90;

  }


  heartElement
    .style
    .setProperty(
      "--glow-strength",
      glow
    );


  /*
    Restart CSS animation.
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
   TX / MIN
   ========================= */

function updateTxMinute() {

  const now =
    Date.now();


  /*
    Keep only blocks
    detected during the
    last 60 seconds.
  */

  recentBlocks =
    recentBlocks.filter(
      block =>
        now -
        block.time
        <= 60000
    );


  const total =
    recentBlocks.reduce(
      (
        sum,
        block
      ) =>
        sum +
        block.transactions,

      0
    );


  txMinuteElement.textContent =
    total.toLocaleString();

}


/* =========================
   NEW BLOCK
   ========================= */

async function checkAbstract() {

  try {

    const blockHex =
      await rpcCall(
        "eth_blockNumber"
      );


    const blockNumber =
      parseInt(
        blockHex,
        16
      );


    /*
      No new block.
    */

    if (
      lastBlock ===
      blockNumber
    ) {

      return;

    }


    /*
      Get number of
      transactions in block.
    */

    const transactionHex =
      await rpcCall(
        "eth_getBlockTransactionCountByNumber",
        [blockHex]
      );


    const transactionCount =
      parseInt(
        transactionHex,
        16
      );


    const now =
      Date.now();


    /*
      On initial page load
      show information but
      don't fake heartbeat.
    */

    if (
      lastBlock !== null
    ) {

      heartbeat(
        transactionCount
      );

    }


    /*
      Store this block for
      TX / MIN calculation.
    */

    recentBlocks.push({

      time:
        now,

      transactions:
        transactionCount

    });


    lastBlock =
      blockNumber;


    lastBlockTime =
      now;


    /* UI */

    blockElement.textContent =
      `#${blockNumber.toLocaleString()}`;


    transactionsElement.textContent =
      transactionCount
        .toLocaleString();


    updateTxMinute();

  }

  catch (error) {

    console.error(
      "Abstract RPC error:",
      error
    );


    blockElement.textContent =
      "Connection error";

  }

}


/* =========================
   HEARTBEAT TIMER
   ========================= */

function updateHeartbeatTimer() {

  if (
    !lastBlockTime
  ) {

    return;

  }


  const seconds =
    Math.floor(

      (
        Date.now() -
        lastBlockTime
      )

      / 1000

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

checkAbstract();


/*
  Poll Abstract once
  per second.
*/

setInterval(
  checkAbstract,
  1000
);


/*
  Refresh timers.
*/

setInterval(
  () => {

    updateHeartbeatTimer();

    updateTxMinute();

  },

  250
);
