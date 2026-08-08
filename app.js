const RPC_URL = "https://api.mainnet.abs.xyz";

const blockElement = document.getElementById("blockNumber");
const transactionsElement = document.getElementById("transactions");
const heartbeatElement = document.getElementById("heartbeat");
const pulseElement = document.getElementById("pulse");

let lastBlock = null;
let lastHeartbeatTime = null;

async function rpcCall(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: method,
      params: params
    })
  });

  if (!response.ok) {
    throw new Error(`RPC error: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.result;
}

function triggerPulse(transactionCount) {
  pulseElement.classList.remove("beat");

  void pulseElement.offsetWidth;

  const strength = Math.min(1 + transactionCount / 100, 2);

  pulseElement.style.transform = `scale(${strength})`;
  pulseElement.classList.add("beat");

  setTimeout(() => {
    pulseElement.style.transform = "scale(1)";
    pulseElement.classList.remove("beat");
  }, 1200);
}

async function checkAbstract() {
  try {
    const blockHex = await rpcCall("eth_blockNumber");

    const blockNumber = parseInt(blockHex, 16);

    if (lastBlock === blockNumber) {
      return;
    }

    const transactionCountHex = await rpcCall(
      "eth_getBlockTransactionCountByNumber",
      [blockHex]
    );

    const transactionCount = parseInt(transactionCountHex, 16);

    lastBlock = blockNumber;
    lastHeartbeatTime = Date.now();

    blockElement.textContent = `#${blockNumber.toLocaleString()}`;
    transactionsElement.textContent = transactionCount.toLocaleString();

    triggerPulse(transactionCount);

  } catch (error) {
    console.error("Abstract RPC error:", error);

    blockElement.textContent = "Connection error";
  }
}

function updateHeartbeatTimer() {
  if (!lastHeartbeatTime) return;

  const seconds = Math.floor(
    (Date.now() - lastHeartbeatTime) / 1000
  );

  if (seconds < 1) {
    heartbeatElement.textContent = "NOW";
  } else {
    heartbeatElement.textContent = `${seconds}s ago`;
  }
}

checkAbstract();

setInterval(checkAbstract, 1000);
setInterval(updateHeartbeatTimer, 250);
