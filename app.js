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


/* RPC REQUEST */

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
            method: method,
            params: params
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


/* HEARTBEAT ANIMATION */

function heartbeat() {

  heartElement
    .classList
    .remove("beat");


  /*
    Forces browser to restart
    the CSS animation.
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

    900
  );

}


/* CHECK ABSTRACT */

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
      Same block:
      nothing happens.
    */

    if (
      lastBlock ===
      blockNumber
    ) {

      return;

    }


    /*
      Get transaction count
      from newest block.
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


    /*
      Do NOT heartbeat
      on initial page load.

      Only heartbeat when
      a genuinely new block
      appears afterwards.
    */

    if (
      lastBlock !== null
    ) {

      heartbeat();

    }


    lastBlock =
      blockNumber;


    lastBlockTime =
      Date.now();


    blockElement.textContent =
      `#${blockNumber.toLocaleString()}`;


    transactionsElement.textContent =
      transactionCount.toLocaleString();


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


/* LAST BLOCK TIMER */

function updateHeartbeatTimer() {

  if (!lastBlockTime) {
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


  if (seconds < 1) {

    heartbeatElement.textContent =
      "NOW";

  }

  else {

    heartbeatElement.textContent =
      `${seconds}s ago`;

  }

}


/* START */

checkAbstract();


/*
  Check once per second
  for a new Abstract block.
*/

setInterval(
  checkAbstract,
  1000
);


/*
  Update timer display.
*/

setInterval(
  updateHeartbeatTimer,
  250
);
