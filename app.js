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


/* EXTENDED NETWORK ACTIVITY */

const txTodayElement =
  document.getElementById("txToday");

const txYesterdayElement =
  document.getElementById("txYesterday");

const avgTxMinuteElement =
  document.getElementById("avgTxMinute");

const avgTxBlockElement =
  document.getElementById("avgTxBlock");

const networkTpsElement =
  document.getElementById("networkTps");

const activityChartElement =
  document.getElementById("activityChart");


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
   CONTINUOUS NETWORK PULSE
========================= */

/*
  Transaction count does NOT equal
  number of beats.

  The logo pulses continuously.

  Only the speed and slight pulse
  strength change depending on the
  number of transactions in the
  latest observed block.
*/

function getPulseProfile(
  transactionCount
) {

  /*
    0 TX
    Very quiet network activity.
  */

  if (
    !Number.isFinite(
      transactionCount
    ) ||
    transactionCount <= 0
  ) {
    return {
      duration: 2600,
      strength: 1.06
    };
  }


  /*
    1–3 TX
    Normal heartbeat.
  */

  if (transactionCount <= 3) {
    return {
      duration: 1800,
      strength: 1.09
    };
  }


  /*
    4–8 TX
  */

  if (transactionCount <= 8) {
    return {
      duration: 1400,
      strength: 1.10
    };
  }


  /*
    9–15 TX
  */

  if (transactionCount <= 15) {
    return {
      duration: 1100,
      strength: 1.11
    };
  }


  /*
    16–30 TX
  */

  if (transactionCount <= 30) {
    return {
      duration: 850,
      strength: 1.12
    };
  }


  /*
    31–60 TX
  */

  if (transactionCount <= 60) {
    return {
      duration: 650,
      strength: 1.13
    };
  }


  /*
    61–100 TX
  */

  if (transactionCount <= 100) {
    return {
      duration: 500,
      strength: 1.14
    };
  }


  /*
    101+ TX
  */

  return {
    duration: 400,
    strength: 1.15
  };
}


function updateNetworkPulse(
  transactionCount
) {
  if (!heartElement) {
    return;
  }

  const profile =
    getPulseProfile(
      transactionCount
    );

  heartElement.style.setProperty(
    "--network-pulse-duration",
    `${profile.duration}ms`
  );

  heartElement.style.setProperty(
    "--pulse-strength",
    profile.strength
  );

  if (
    !heartElement.classList.contains(
      "network-pulse"
    )
  ) {
    heartElement.classList.add(
      "network-pulse"
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
   NUMBER FORMAT
========================= */

function formatNumber(value) {
  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return "—";
  }

  return number.toLocaleString();
}


function formatDecimal(
  value,
  decimals = 2
) {
  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return "—";
  }

  return number.toLocaleString(
    undefined,
    {
      minimumFractionDigits: 0,
      maximumFractionDigits:
        decimals
    }
  );
}


/* =========================
   DATE FORMAT
========================= */

function formatChartDate(value) {
  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return value;
  }

  return date.toLocaleDateString(
    [],
    {
      month: "short",
      day: "numeric"
    }
  );
}


/* =========================
   7-DAY ACTIVITY CHART
========================= */

function renderActivityChart(days) {
  if (!activityChartElement) {
    return;
  }

  if (
    !Array.isArray(days) ||
    days.length === 0
  ) {
    activityChartElement.innerHTML =
      '<div class="activity-chart-loading">DATA UNAVAILABLE</div>';

    return;
  }

  const cleanDays =
    days
      .filter(day =>
        day &&
        Number.isFinite(
          Number(
            day.transactions
          )
        )
      )
      .slice(-7);

  if (cleanDays.length === 0) {
    activityChartElement.innerHTML =
      '<div class="activity-chart-loading">DATA UNAVAILABLE</div>';

    return;
  }

  const maximum =
    Math.max(
      ...cleanDays.map(
        day =>
          Number(
            day.transactions
          )
      ),
      1
    );

  activityChartElement.innerHTML =
    "";

  cleanDays.forEach(day => {
    const transactions =
      Number(
        day.transactions
      );

    const percentage =
      Math.max(
        2,
        (
          transactions /
          maximum
        ) *
        100
      );


    const item =
      document.createElement(
        "div"
      );

    item.className =
      "activity-bar-item";


    const value =
      document.createElement(
        "div"
      );

    value.className =
      "activity-bar-value";

    value.textContent =
      transactions
        .toLocaleString();


    const track =
      document.createElement(
        "div"
      );

    track.className =
      "activity-bar-track";


    const bar =
      document.createElement(
        "div"
      );

    bar.className =
      "activity-bar";

    bar.style.height =
      `${percentage}%`;


    const date =
      document.createElement(
        "div"
      );

    date.className =
      "activity-bar-date";

    date.textContent =
      formatChartDate(
        day.date
      );


    track.appendChild(
      bar
    );

    item.appendChild(
      value
    );

    item.appendChild(
      track
    );

    item.appendChild(
      date
    );

    activityChartElement
      .appendChild(
        item
      );
  });
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


    /*
      EXISTING STATS
    */

    if (
      data.lastMinute &&
      txMinuteElement
    ) {
      txMinuteElement.textContent =
        formatNumber(
          data.lastMinute
            .transactions
        );

      if (
        minuteCountdownElement
      ) {
        minuteCountdownElement
          .textContent =
            formatPeriod(
              data.lastMinute.start,
              data.lastMinute.end
            );
      }
    }


    if (
      data.lastFiveMinutes &&
      txFiveMinutesElement
    ) {
      txFiveMinutesElement.textContent =
        formatNumber(
          data.lastFiveMinutes
            .transactions
        );

      if (
        fiveMinuteCountdownElement
      ) {
        fiveMinuteCountdownElement
          .textContent =
            formatPeriod(
              data.lastFiveMinutes.start,
              data.lastFiveMinutes.end
            );
      }
    }


    /*
      EXTENDED STATS
    */

    if (
      txTodayElement &&
      data.today
    ) {
      txTodayElement.textContent =
        formatNumber(
          data.today.transactions
        );
    }


    if (
      txYesterdayElement &&
      data.yesterday
    ) {
      txYesterdayElement.textContent =
        formatNumber(
          data.yesterday.transactions
        );
    }


    if (
      avgTxMinuteElement
    ) {
      avgTxMinuteElement.textContent =
        formatDecimal(
          data.avgTxPerMinute,
          1
        );
    }


    if (
      avgTxBlockElement
    ) {
      avgTxBlockElement.textContent =
        formatDecimal(
          data.avgTxPerBlock,
          2
        );
    }


    if (
      networkTpsElement
    ) {
      networkTpsElement.textContent =
        formatDecimal(
          data.tps,
          2
        );
    }


    if (
      Array.isArray(
        data.sevenDays
      )
    ) {
      renderActivityChart(
        data.sevenDays
      );
    }


  } catch (error) {
    console.error(
      "Stats error:",
      error
    );


    /*
      Existing values only change
      to unavailable if they have
      never successfully loaded.
    */

    if (
      txMinuteElement &&
      txMinuteElement.textContent ===
        "LOADING..."
    ) {
      txMinuteElement.textContent =
        "—";
    }


    if (
      txFiveMinutesElement &&
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


    /*
      New values.
    */

    const extendedElements = [
      txTodayElement,
      txYesterdayElement,
      avgTxMinuteElement,
      avgTxBlockElement,
      networkTpsElement
    ];

    extendedElements.forEach(
      element => {
        if (
          element &&
          element.textContent
            .toUpperCase() ===
            "LOADING..."
        ) {
          element.textContent =
            "—";
        }
      }
    );


    if (
      activityChartElement &&
      activityChartElement
        .querySelector(
          ".activity-chart-loading"
        )
    ) {
      activityChartElement.innerHTML =
        '<div class="activity-chart-loading">DATA UNAVAILABLE</div>';
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

      /*
        Start continuous pulse immediately
        using the current latest block.
      */

      updateNetworkPulse(
        block.transactions
      );

      updateHeartbeatTimer();
    }

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
        Latest block TX count changes
        pulse SPEED only.

        It does NOT create one beat
        per transaction.
      */

      updateNetworkPulse(
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

if (txMinuteElement) {
  txMinuteElement.textContent =
    "LOADING...";
}

if (txFiveMinutesElement) {
  txFiveMinutesElement.textContent =
    "LOADING...";
}

if (txTodayElement) {
  txTodayElement.textContent =
    "LOADING...";
}

if (txYesterdayElement) {
  txYesterdayElement.textContent =
    "LOADING...";
}

if (avgTxMinuteElement) {
  avgTxMinuteElement.textContent =
    "LOADING...";
}

if (avgTxBlockElement) {
  avgTxBlockElement.textContent =
    "LOADING...";
}

if (networkTpsElement) {
  networkTpsElement.textContent =
    "LOADING...";
}


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
  Load completed intervals
  and extended network stats.
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
  Refresh server statistics.
*/

setInterval(
  loadStats,
  30000
);
