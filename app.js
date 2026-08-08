const RPC_URL = "https://api.mainnet.abs.xyz";

const blockElement = document.getElementById("blockNumber");
const transactionsElement = document.getElementById("transactions");
const heartbeatElement = document.getElementById("heartbeat");
const heartElement = document.getElementById("heart");

let lastBlock = null;
let lastBlockTime = null;

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
    throw new Error(`RPC error ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.result;
}

function heartbeat() {
  heartElement.classList.remove("beat");

  // prisili browser da ponovno pokrene animaciju
  void heartElement.offsetWidth;

  heartElement.classList.add("beat");

  setTimeout(() => {
    heartElement.classList.remove("beat");
  }, 900);
}

async function checkAbstract() {
  try {
    const blockHex = await rpcCall("eth_blockNumber");
    const blockNumber = parseInt(blockHex, 16);

    // nema novog blocka
    if (lastBlock === blockNumber) {
      return;
    }

    const txHex = await rpcCall(
      "eth_getBlockTransactionCountByNumber",
      [blockHex]
    );

    const tx = parseInt(txHex, 16);

    // prvi load stranice samo prikaže podatke
    // ne glumi da je upravo stigao novi block
    if (lastBlock !== null) {
      heartbeat();
    }

    lastBlock = blockNumber;
    lastBlockTime = Date.now();

    blockElement.textContent =
      `#${blockNumber.toLocaleString()}`;

    transactionsElement.textContent =
      tx.toLocaleString();

  } catch (error) {
    console.error("Abstract RPC error:", error);

    blockElement.textContent = "Connection error";
  }
}

function updateLastBlock() {
  if (!lastBlockTime) return;

  const seconds = Math.floor(
    (Date.now() - lastBlockTime) / 1000
  );

  if (seconds < 1) {
    heartbeatElement.textContent = "NOW";
  } else {
    heartbeatElement.textContent = `${seconds}s ago`;
  }
}

checkAbstract();

setInterval(checkAbstract, 1000);
setInterval(updateLastBlock, 250);
