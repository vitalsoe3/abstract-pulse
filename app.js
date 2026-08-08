const RPC_URL = "https://api.mainnet.abs.xyz";

const blockElement =
  document.getElementById("blockNumber");

const transactionsElement =
  document.getElementById("transactions");

const heartbeatElement =
  document.getElementById("heartbeat");

const bpmElement =
  document.getElementById("bpm");

const heartElement =
  document.getElementById("heart");


let lastBlock = null;
let lastBlockTime = null;

let currentBPM = 40;

let heartbeatTimer = null;


/* ---------------- RPC ---------------- */

async function rpcCall(method, params = []) {

  const response = await fetch(
    RPC_URL,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params
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


/* ---------------- BPM ---------------- */

function calculateBPM(tx) {

  if (tx <= 2) {
    return 40;
  }

  if (tx <= 10) {
    return 55;
  }

  if (tx <= 25) {
    return 70;
  }

  if (tx <= 50) {
    return 90;
  }

  if (tx <= 100) {
    return 110;
  }

  return 140;
}


/* ---------------- HEART ---------------- */

function beat() {

  heartElement.classList.remove("beat");

  void heartElement.offsetWidth;

  heartElement.classList.add("beat");

  setTimeout(() => {

    heartElement.classList.remove("beat");

  }, 550);
}


/* ---------------- HEART ENGINE ---------------- */

function startHeartbeat() {

  if (heartbeatTimer) {

    clearInterval(
      heartbeatTimer
    );

  }

  beat();

  const interval =
    60000 / currentBPM;

  heartbeatTimer =
    setInterval(
      beat,
      interval
    );
}


/* ---------------- UPDATE BPM ---------------- */

function setBPM(newBPM) {

  if (newBPM === currentBPM) {
    return;
  }

  currentBPM = newBPM;

  bpmElement.textContent =
    `${currentBPM} BPM`;

  startHeartbeat();
}


/* ---------------- BLOCK CHECK ---------------- */

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


    if (lastBlock === blockNumber) {
      return;
    }


    const txHex =
      await rpcCall(
        "eth_getBlockTransactionCountByNumber",
        [blockHex]
      );


    const tx =
      parseInt(
        txHex,
        16
      );


    lastBlock =
      blockNumber;

    lastBlockTime =
      Date.now();


    blockElement.textContent =
      `#${blockNumber.toLocaleString()}`;

    transactionsElement.textContent =
      tx.toLocaleString();


    const bpm =
      calculateBPM(tx);

    setBPM(bpm);


  } catch (error) {

    console.error(
      "Abstract RPC error:",
      error
    );

    blockElement.textContent =
      "Connection error";

  }

}


/* ---------------- TIMER ---------------- */

function updateLastBlock() {

  if (!lastBlockTime) {
    return;
  }

  const seconds =
    Math.floor(
      (
        Date.now() -
        lastBlockTime
      ) / 1000
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


/* ---------------- START ---------------- */

bpmElement.textContent =
  `${currentBPM} BPM`;

startHeartbeat();

checkAbstract();


setInterval(
  checkAbstract,
  1000
);


setInterval(
  updateLastBlock,
  250
);
