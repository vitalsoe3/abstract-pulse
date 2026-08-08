const RPC_URL = "https://api.mainnet.abs.xyz";


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

const minuteCountdownElement =
  document.getElementById("minuteCountdown");

const fiveMinuteCountdownElement =
  document.getElementById("fiveMinuteCountdown");

const heartbeatElement =
  document.getElementById("heartbeat");

const heartElement =
  document.getElementById("heart");


/* WALLET CHECKER */

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

let isCheckingBlock = false;
let walletChecking = false;

let pulseSequenceId = 0;


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
              method,
              params
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
   BLOCK
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
      Number(
        BigInt(block.number)
      ),

    timestamp:
      Number(
        BigInt(block.timestamp)
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
   LIVE TRANSACTION PULSE
========================= */

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


function getPulseProfile(
  transactionCount
) {

  /*
    0 TX = no heartbeat

    More transactions in the
    newly observed live block
    create more and faster beats.
  */

  if (transactionCount <= 0) {
    return null;
  }


  /* 1 TX */

  if (transactionCount === 1) {
    return {
      beats: 1,
      strength: 1.09,
      duration: 700,
      gap: 0
    };
  }


  /* 2–3 TX */

  if (transactionCount <= 3) {
    return {
      beats: 2,
      strength: 1.11,
      duration: 600,
      gap: 180
    };
  }


  /* 4–7 TX */

  if (transactionCount <= 7) {
    return {
      beats: 3,
      strength: 1.14,
      duration: 520,
      gap: 140
    };
  }


  /* 8–15 TX */

  if (transactionCount <= 15) {
    return {
      beats: 4,
      strength: 1.18,
      duration: 430,
      gap: 100
    };
  }


  /* 16+ TX */

  return {
    beats: 5,
    strength: 1.22,
    duration: 350,
    gap: 70
  };
}


async function playSingleBeat(
  strength,
  duration,
  sequenceId
) {
  if (
    !heartElement ||
    sequenceId !== pulseSequenceId
  ) {
    return;
  }

  heartElement.style.setProperty(
    "--pulse-strength",
    strength
  );

  heartElement.style.animationDuration =
    `${duration}ms`;

  heartElement.classList.remove(
    "beat"
  );

  /*
    Force animation restart.
  */

  void heartElement.offsetWidth;

  if (
    sequenceId !== pulseSequenceId
  ) {
    return;
  }

  heartElement.classList.add(
    "beat"
  );

  await sleep(
    duration
  );

  if (
    sequenceId !== pulseSequenceId
  ) {
    return;
  }

  heartElement.classList.remove(
    "beat"
  );
}


async function triggerPulse(
  transactionCount
) {

  /*
    Only transactions from a
    genuinely new live block
    reach this function.
  */

  if (
    !Number.isFinite(
      transactionCount
    ) ||
    transactionCount <= 0 ||
    !heartElement
  ) {
    return;
  }

  const profile =
    getPulseProfile(
      transactionCount
    );

  if (!profile) {
    return;
  }


  /*
    Starting a new live block
    cancels any old pulse sequence.
  */

  pulseSequenceId += 1;

  const thisSequence =
    pulseSequenceId;


  for (
    let beat = 0;
    beat < profile.beats;
    beat++
  ) {

    if (
      thisSequence !==
      pulseSequenceId
    ) {
      return;
    }

    await playSingleBeat(
      profile.strength,
      profile.duration,
      thisSequence
    );


    /*
      Gap between individual beats.
    */

    if (
      beat <
      profile.beats - 1
    ) {
      await sleep(
        profile.gap
      );
    }
  }


  if (
    thisSequence ===
    pulseSequenceId
  ) {
    heartElement.classList.remove(
      "beat"
    );

    heartElement.style
      .removeProperty(
        "animation-duration"
      );
  }
}


/* =========================
   PERIOD FORMAT
========================= */

function formatTime(timestamp) {
  const date =
    new Date(timestamp);

  return date.toLocaleTimeString(
    [],
    {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }
  );
}


function formatPeriod(
  start,
  end
) {
  return (
    formatTime(start) +
    " – " +
    formatTime(end)
  );
}


/* =========================
   SERVER STATS
========================= */

async function loadStats() {
  try {
    const response =
      await fetch(
        "/api/stats",
        {
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        `Stats HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data.lastMinute ||
      !data.lastFiveMinutes
    ) {
      throw new Error(
        "Invalid stats response"
      );
    }


    /*
      LAST COMPLETED MINUTE
    */

    txMinuteElement.textContent =
      Number(
        data.lastMinute.transactions
      ).toLocaleString();

    if (
      minuteCountdownElement
    ) {
      minuteCountdownElement.textContent =
        formatPeriod(
          data.lastMinute.start,
          data.lastMinute.end
        );
    }


    /*
      LAST COMPLETED
      5-MINUTE INTERVAL
    */

    txFiveMinutesElement.textContent =
      Number(
        data.lastFiveMinutes.transactions
      ).toLocaleString();

    if (
      fiveMinuteCountdownElement
    ) {
      fiveMinuteCountdownElement.textContent =
        formatPeriod(
          data.lastFiveMinutes.start,
          data.lastFiveMinutes.end
        );
    }

  } catch (error) {
    console.error(
      "Stats error:",
      error
    );

    if (
      txMinuteElement.textContent ===
      "LOADING..."
    ) {
      txMinuteElement.textContent =
        "—";
    }

    if (
      txFiveMinutesElement.textContent ===
      "LOADING..."
    ) {
      txFiveMinutesElement.textContent =
        "—";
    }

    if (
      minuteCountdownElement &&
      minuteCountdownElement.textContent ===
        "LOADING DATA"
    ) {
      minuteCountdownElement.textContent =
        "DATA UNAVAILABLE";
    }

    if (
      fiveMinuteCountdownElement &&
      fiveMinuteCountdownElement.textContent ===
        "LOADING DATA"
    ) {
      fiveMinuteCountdownElement.textContent =
        "DATA UNAVAILABLE";
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

  if (
    seconds === 0
  ) {
    heartbeatElement.textContent =
      "NOW";

  } else if (
    seconds === 1
  ) {
    heartbeatElement.textContent =
      "1s ago";

  } else {
    heartbeatElement.textContent =
      `${seconds}s ago`;
  }
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
        BigInt(latestHex)
      );

    lastBlock =
      latestNumber;

    blockElement.textContent =
      "#" +
      latestNumber.toLocaleString();

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

      transactionsElement.textContent =
        block.transactions
          .toLocaleString();

      updateHeartbeatTimer();
    }


    /*
      Do NOT pulse here.

      This is the block that already
      existed when the visitor opened
      the site.
    */

  } catch (error) {
    console.error(
      "Connection error:",
      error
    );

    blockElement.textContent =
      "RPC ERROR";

    transactionsElement.textContent =
      "—";
  }
}


/* =========================
   LIVE BLOCKS
========================= */

async function checkForNewBlocks() {
  if (
    isCheckingBlock ||
    walletChecking ||
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
        BigInt(latestHex)
      );

    if (
      latestNumber <=
      lastBlock
    ) {
      return;
    }


    /*
      Read every new block since
      the previous poll.
    */

    for (
      let number =
        lastBlock + 1;

      number <=
        latestNumber;

      number++
    ) {
      let rawBlock;

      try {
        rawBlock =
          await getBlock(
            number
          );

      } catch (error) {
        console.warn(
          "Block fetch failed:",
          number,
          error
        );

        break;
      }

      const block =
        parseBlock(
          rawBlock
        );

      if (!block) {
        break;
      }

      lastBlock =
        block.number;

      lastBlockTime =
        block.timestamp;

      blockElement.textContent =
        "#" +
        block.number
          .toLocaleString();

      transactionsElement.textContent =
        block.transactions
          .toLocaleString();


      /*
        ONLY LIVE TX IN THIS BLOCK
        CONTROL THE HEARTBEAT.

        0 TX      = 0 beats
        1 TX      = 1 beat
        2–3 TX    = 2 beats
        4–7 TX    = 3 beats
        8–15 TX   = 4 beats
        16+ TX    = 5 beats
      */

      triggerPulse(
        block.transactions
      );
    }

  } catch (error) {
    console.warn(
      "Live polling error:",
      error
    );

  } finally {
    isCheckingBlock =
      false;
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
   ETH FORMAT
========================= */

function formatEthBalance(
  balanceHex
) {
  const wei =
    BigInt(balanceHex);

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

function shortAddress(
  address
) {
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

      walletChecking =
        true;

      checkButton.disabled =
        true;

      checkButton.textContent =
        "CHECKING...";

      checkerMessage.textContent =
        "Reading Abstract Mainnet...";

      try {
        const balanceHex =
          await rpcCall(
            "eth_getBalance",
            [
              address,
              "latest"
            ]
          );

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
          BigInt(
            nonceHex
          );

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
          .remove("hidden");

      } catch (error) {
        console.error(
          "Wallet checker error:",
          error
        );

        checkerMessage.textContent =
          "Could not read this address. Try again.";

        checkerMessage
          .classList
          .add("error");

      } finally {
        walletChecking =
          false;

        checkButton.disabled =
          false;

        checkButton.textContent =
          "CHECK";
      }
    }
  );
}


/* =========================
   START
========================= */

txMinuteElement.textContent =
  "LOADING...";

txFiveMinutesElement.textContent =
  "LOADING...";

if (
  minuteCountdownElement
) {
  minuteCountdownElement.textContent =
    "LOADING DATA";
}

if (
  fiveMinuteCountdownElement
) {
  fiveMinuteCountdownElement.textContent =
    "LOADING DATA";
}


/*
  Start live Abstract connection.
*/

connect();


/*
  Load completed intervals.
*/

loadStats();


/*
  Poll for new live blocks.
*/

setInterval(
  checkForNewBlocks,
  1500
);


/*
  Last heartbeat clock.
*/

setInterval(
  updateHeartbeatTimer,
  1000
);


/*
  Refresh completed
  server statistics.
*/

setInterval(
  loadStats,
  30000
);
