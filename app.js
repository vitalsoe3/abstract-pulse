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


/* DAILY TX ATH */

const dailyAthTxElement =
  document.getElementById("dailyAthTx");

const dailyAthDateElement =
  document.getElementById("dailyAthDate");

const dailyAthStandingElement =
  document.getElementById("dailyAthStanding");

const dailyAthTrackedSinceElement =
  document.getElementById("dailyAthTrackedSince");


/* RECORD BOOK */

const hourlyAthTxElement =
  document.getElementById("hourlyAthTx");

const hourlyAthDateElement =
  document.getElementById("hourlyAthDate");

const hourlyAthStandingElement =
  document.getElementById("hourlyAthStanding");

const minuteAthTxElement =
  document.getElementById("minuteAthTx");

const minuteAthDateElement =
  document.getElementById("minuteAthDate");

const minuteAthStandingElement =
  document.getElementById("minuteAthStanding");

const tpsAthValueElement =
  document.getElementById("tpsAthValue");

const tpsAthDateElement =
  document.getElementById("tpsAthDate");

const tpsAthStandingElement =
  document.getElementById("tpsAthStanding");


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

const walletTxToday =
  document.getElementById("walletTxToday");


/* SHARE PULSE */

const sharePulse =
  document.getElementById("sharePulse");

const shareCard =
  document.getElementById("shareCard");

const copyShareImage =
  document.getElementById("copyShareImage");

const shareOnX =
  document.getElementById("shareOnX");

const shareMessage =
  document.getElementById("shareMessage");


/* =========================
   STATE
========================= */

let lastBlock = null;
let lastBlockTime = null;

let isCheckingBlock = false;
let walletChecking = false;

let currentShareTx =
  null;

let currentShareTier =
  null;


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

function getPulseProfile(
  transactionCount
) {

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


  if (transactionCount <= 3) {
    return {
      duration: 1800,
      strength: 1.09
    };
  }


  if (transactionCount <= 8) {
    return {
      duration: 1400,
      strength: 1.10
    };
  }


  if (transactionCount <= 15) {
    return {
      duration: 1100,
      strength: 1.11
    };
  }


  if (transactionCount <= 30) {
    return {
      duration: 850,
      strength: 1.12
    };
  }


  if (transactionCount <= 60) {
    return {
      duration: 650,
      strength: 1.13
    };
  }


  if (transactionCount <= 100) {
    return {
      duration: 500,
      strength: 1.14
    };
  }


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
  if (
    value === null ||
    typeof value ===
      "undefined"
  ) {
    return "COLLECTING...";
  }

  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return "COLLECTING...";
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


function formatTrackedSinceDate(value) {
  const date =
    new Date(
      `${value}T00:00:00Z`
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return value;
  }

  return date.toLocaleDateString(
    "en-US",
    {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC"
    }
  );
}


function renderDailyAth(dailyAth) {
  if (
    !dailyAth ||
    !Number.isFinite(
      Number(
        dailyAth.transactions
      )
    )
  ) {
    if (dailyAthTxElement) {
      dailyAthTxElement.textContent =
        "COLLECTING...";
    }

    if (dailyAthDateElement) {
      dailyAthDateElement.textContent =
        "—";
    }

    if (dailyAthStandingElement) {
      dailyAthStandingElement.textContent =
        "STANDING FOR — DAYS";
    }

    if (dailyAthTrackedSinceElement) {
      dailyAthTrackedSinceElement.textContent =
        "Tracked since —";
    }

    return;
  }

  const standingDays =
    Number(
      dailyAth.standingDays
    );

  if (dailyAthTxElement) {
    dailyAthTxElement.textContent =
      formatNumber(
        dailyAth.transactions
      );
  }

  if (dailyAthDateElement) {
    dailyAthDateElement.textContent =
      formatChartDate(
        dailyAth.date
      );
  }

  if (dailyAthStandingElement) {
    const days =
      Number.isFinite(
        standingDays
      )
        ? standingDays
        : 0;

    dailyAthStandingElement.textContent =
      `STANDING FOR ${days} ${
        days === 1
          ? "DAY"
          : "DAYS"
      }`;
  }

  if (
    dailyAthTrackedSinceElement
  ) {
    dailyAthTrackedSinceElement.textContent =
      dailyAth.trackedSince
        ? `Tracked since ${formatTrackedSinceDate(
            dailyAth.trackedSince
          )}`
        : "Tracked since —";
  }
}


function formatRecordTimestamp(value) {
  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "—";
  }

  return date.toLocaleString(
    [],
    {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }
  );
}


function formatStandingDays(value) {
  const days =
    Number(value);

  if (!Number.isFinite(days)) {
    return "STANDING FOR — DAYS";
  }

  return (
    `STANDING FOR ${days} ${
      days === 1
        ? "DAY"
        : "DAYS"
    }`
  );
}


function renderRecordBook(recordBook) {
  const hourly =
    recordBook &&
    recordBook.hourly;

  const minute =
    recordBook &&
    recordBook.minute;

  const tps =
    recordBook &&
    recordBook.tps;


  if (hourlyAthTxElement) {
    hourlyAthTxElement.textContent =
      hourly &&
      Number.isFinite(
        Number(hourly.value)
      )
        ? formatNumber(
            hourly.value
          )
        : "COLLECTING...";
  }

  if (hourlyAthDateElement) {
    hourlyAthDateElement.textContent =
      hourly &&
      hourly.timestamp
        ? formatRecordTimestamp(
            hourly.timestamp
          )
        : "—";
  }

  if (hourlyAthStandingElement) {
    hourlyAthStandingElement.textContent =
      hourly
        ? formatStandingDays(
            hourly.standingDays
          )
        : "STANDING FOR — DAYS";
  }


  if (minuteAthTxElement) {
    minuteAthTxElement.textContent =
      minute &&
      Number.isFinite(
        Number(minute.value)
      )
        ? formatNumber(
            minute.value
          )
        : "COLLECTING...";
  }

  if (minuteAthDateElement) {
    minuteAthDateElement.textContent =
      minute &&
      minute.timestamp
        ? formatRecordTimestamp(
            minute.timestamp
          )
        : "—";
  }

  if (minuteAthStandingElement) {
    minuteAthStandingElement.textContent =
      minute
        ? formatStandingDays(
            minute.standingDays
          )
        : "STANDING FOR — DAYS";
  }


  if (tpsAthValueElement) {
    const value =
      tps &&
      Number(tps.value);

    tpsAthValueElement.textContent =
      Number.isFinite(value)
        ? value.toLocaleString(
            undefined,
            {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            }
          )
        : "COLLECTING...";
  }

  if (tpsAthDateElement) {
    tpsAthDateElement.textContent =
      tps &&
      tps.timestamp
        ? formatRecordTimestamp(
            tps.timestamp
          )
        : "—";
  }

  if (tpsAthStandingElement) {
    tpsAthStandingElement.textContent =
      tps
        ? formatStandingDays(
            tps.standingDays
          )
        : "STANDING FOR — DAYS";
  }
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
      '<div class="activity-chart-loading">COLLECTING DATA...</div>';

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
      '<div class="activity-chart-loading">COLLECTING DATA...</div>';

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


    /* EXISTING STATS */

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


    /* TX TODAY */

    if (txTodayElement) {
      if (
        data.today &&
        Number.isFinite(
          Number(
            data.today.transactions
          )
        )
      ) {
        txTodayElement.textContent =
          formatNumber(
            data.today.transactions
          );
      } else {
        txTodayElement.textContent =
          "COLLECTING...";
      }
    }


    /* TX YESTERDAY */

    if (txYesterdayElement) {
      if (
        data.yesterday &&
        Number.isFinite(
          Number(
            data.yesterday.transactions
          )
        )
      ) {
        txYesterdayElement.textContent =
          formatNumber(
            data.yesterday
              .transactions
          );
      } else {
        txYesterdayElement.textContent =
          "COLLECTING...";
      }
    }


    /* AVG TX / MIN */

    if (
      avgTxMinuteElement
    ) {
      avgTxMinuteElement.textContent =
        formatDecimal(
          data.avgTxPerMinute,
          1
        );
    }


    /* AVG TX / BLOCK */

    if (
      avgTxBlockElement
    ) {
      avgTxBlockElement.textContent =
        formatDecimal(
          data.avgTxPerBlock,
          2
        );
    }


    /* TPS */

    if (
      networkTpsElement
    ) {
      const tps =
        Number(
          data.tps
        );

      networkTpsElement.textContent =
        Number.isFinite(tps)
          ? tps.toLocaleString(
              undefined,
              {
                minimumFractionDigits:
                  0,
                maximumFractionDigits:
                  2
              }
            )
          : "—";
    }


    /* 7-DAY CHART */

    renderActivityChart(
      data.sevenDays
    );


    /* DAILY TX ATH */

    renderDailyAth(
      data.dailyAth
    );


    /* RECORD BOOK */

    renderRecordBook(
      data.recordBook
    );


  } catch (error) {
    console.error(
      "Stats error:",
      error
    );


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


    if (
      txTodayElement &&
      (
        txTodayElement.textContent ===
          "LOADING..." ||
        txTodayElement.textContent ===
          ""
      )
    ) {
      txTodayElement.textContent =
        "COLLECTING...";
    }


    if (
      txYesterdayElement &&
      (
        txYesterdayElement.textContent ===
          "LOADING..." ||
        txYesterdayElement.textContent ===
          ""
      )
    ) {
      txYesterdayElement.textContent =
        "COLLECTING...";
    }


    if (
      avgTxMinuteElement &&
      (
        avgTxMinuteElement.textContent ===
          "LOADING..." ||
        avgTxMinuteElement.textContent ===
          ""
      )
    ) {
      avgTxMinuteElement.textContent =
        "COLLECTING...";
    }


    if (
      avgTxBlockElement &&
      (
        avgTxBlockElement.textContent ===
          "LOADING..." ||
        avgTxBlockElement.textContent ===
          ""
      )
    ) {
      avgTxBlockElement.textContent =
        "COLLECTING...";
    }


    if (
      networkTpsElement &&
      networkTpsElement.textContent ===
        "LOADING..."
    ) {
      networkTpsElement.textContent =
        "—";
    }


    if (
      activityChartElement &&
      activityChartElement
        .querySelector(
          ".activity-chart-loading"
        )
    ) {
      activityChartElement.innerHTML =
        '<div class="activity-chart-loading">COLLECTING DATA...</div>';
    }


    if (
      dailyAthTxElement &&
      (
        dailyAthTxElement.textContent ===
          "LOADING..." ||
        dailyAthTxElement.textContent ===
          ""
      )
    ) {
      dailyAthTxElement.textContent =
        "COLLECTING...";
    }


    if (
      hourlyAthTxElement &&
      hourlyAthTxElement.textContent ===
        "LOADING..."
    ) {
      hourlyAthTxElement.textContent =
        "COLLECTING...";
    }


    if (
      minuteAthTxElement &&
      minuteAthTxElement.textContent ===
        "LOADING..."
    ) {
      minuteAthTxElement.textContent =
        "COLLECTING...";
    }


    if (
      tpsAthValueElement &&
      tpsAthValueElement.textContent ===
        "LOADING..."
    ) {
      tpsAthValueElement.textContent =
        "COLLECTING...";
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
   WALLET TODAY STATS
========================= */

async function getWalletTodayStats(
  address
) {
  const response =
    await fetch(
      `/api/stats?wallet=${encodeURIComponent(address)}`,
      {
        cache: "no-store"
      }
    );

  if (!response.ok) {
    throw new Error(
      `Wallet stats HTTP ${response.status}`
    );
  }

  return response.json();
}


/* =========================
   ABSTRACT PULSE TIER
========================= */

function getAbstractPulseTier(
  transactionCount
) {
  const tx =
    typeof transactionCount === "bigint"
      ? transactionCount
      : BigInt(transactionCount);

  if (tx <= 999n) {
    return "SHRIMP";
  }

  if (tx <= 2499n) {
    return "PLANKTON";
  }

  if (tx <= 4999n) {
    return "SARDINE";
  }

  if (tx <= 9999n) {
    return "SEA BASS";
  }

  if (tx <= 14999n) {
    return "TUNA";
  }

  if (tx <= 19999n) {
    return "SWORDFISH";
  }

  if (tx <= 24999n) {
    return "GREAT WHITE";
  }

  if (tx <= 100000n) {
    return "ORCA";
  }

  return "BLUE WHALE";
}


/* =========================
   SHARE CARD DRAWING
========================= */

function roundRectPath(
  context,
  x,
  y,
  width,
  height,
  radius
) {
  const r =
    Math.min(
      radius,
      width / 2,
      height / 2
    );

  context.beginPath();

  context.moveTo(
    x + r,
    y
  );

  context.arcTo(
    x + width,
    y,
    x + width,
    y + height,
    r
  );

  context.arcTo(
    x + width,
    y + height,
    x,
    y + height,
    r
  );

  context.arcTo(
    x,
    y + height,
    x,
    y,
    r
  );

  context.arcTo(
    x,
    y,
    x + width,
    y,
    r
  );

  context.closePath();
}


function drawCenteredText(
  context,
  text,
  x,
  y,
  font,
  color,
  shadowBlur = 0
) {
  context.save();

  context.font =
    font;

  context.textAlign =
    "center";

  context.textBaseline =
    "middle";

  context.fillStyle =
    color;

  if (shadowBlur > 0) {
    context.shadowColor =
      "#00ff85";

    context.shadowBlur =
      shadowBlur;
  }

  context.fillText(
    text,
    x,
    y
  );

  context.restore();
}


function loadShareLogo() {
  return new Promise(
    (resolve, reject) => {
      const image =
        new Image();

      image.onload =
        () => resolve(image);

      image.onerror =
        reject;

      image.src =
        "./abstract-logo.jpg";
    }
  );
}


async function renderShareCard(
  transactionCount,
  tier
) {
  if (!shareCard) {
    return;
  }

  const context =
    shareCard.getContext(
      "2d"
    );

  if (!context) {
    return;
  }

  const width =
    shareCard.width;

  const height =
    shareCard.height;

  const green =
    "#00ff85";

  const white =
    "#ffffff";

  const muted =
    "rgba(255,255,255,0.56)";

  const rightCenterX =
    845;


  /* BACKGROUND */

  context.clearRect(
    0,
    0,
    width,
    height
  );

  const background =
    context.createRadialGradient(
      330,
      335,
      40,
      330,
      335,
      620
    );

  background.addColorStop(
    0,
    "#062417"
  );

  background.addColorStop(
    0.42,
    "#02110b"
  );

  background.addColorStop(
    1,
    "#010705"
  );

  context.fillStyle =
    background;

  context.fillRect(
    0,
    0,
    width,
    height
  );


  /* BORDER */

  context.save();

  context.shadowColor =
    green;

  context.shadowBlur =
    22;

  context.strokeStyle =
    green;

  context.lineWidth =
    3;

  roundRectPath(
    context,
    15,
    15,
    width - 30,
    height - 30,
    22
  );

  context.stroke();

  context.restore();


  /* LEFT GLOW */

  const glow =
    context.createRadialGradient(
      300,
      337,
      80,
      300,
      337,
      285
    );

  glow.addColorStop(
    0,
    "rgba(0,255,133,0.16)"
  );

  glow.addColorStop(
    1,
    "rgba(0,255,133,0)"
  );

  context.fillStyle =
    glow;

  context.fillRect(
    50,
    90,
    500,
    500
  );


  /* LOGO */

  try {
    const logo =
      await loadShareLogo();

    const logoSize =
      255;

    const logoX =
      300;

    const logoY =
      337;

    context.save();

    context.beginPath();

    context.arc(
      logoX,
      logoY,
      logoSize / 2,
      0,
      Math.PI * 2
    );

    context.closePath();

    context.clip();

    context.drawImage(
      logo,
      logoX -
        logoSize / 2,
      logoY -
        logoSize / 2,
      logoSize,
      logoSize
    );

    context.restore();


    context.save();

    context.strokeStyle =
      "rgba(0,255,133,0.28)";

    context.lineWidth =
      2;

    context.shadowColor =
      green;

    context.shadowBlur =
      26;

    context.beginPath();

    context.arc(
      logoX,
      logoY,
      logoSize / 2 + 18,
      0,
      Math.PI * 2
    );

    context.stroke();

    context.restore();

  } catch (error) {
    console.warn(
      "Share logo could not be loaded:",
      error
    );
  }


  /* DIVIDER */

  const divider =
    context.createLinearGradient(
      555,
      120,
      555,
      555
    );

  divider.addColorStop(
    0,
    "rgba(0,255,133,0)"
  );

  divider.addColorStop(
    0.5,
    "rgba(0,255,133,0.17)"
  );

  divider.addColorStop(
    1,
    "rgba(0,255,133,0)"
  );

  context.fillStyle =
    divider;

  context.fillRect(
    554,
    120,
    1,
    435
  );


  /* RIGHT TEXT — CENTERED */

  drawCenteredText(
    context,
    "MY ABSTRACT PULSE",
    rightCenterX,
    155,
    "700 28px Arial, Helvetica, sans-serif",
    white
  );

  drawCenteredText(
    context,
    tier,
    rightCenterX,
    260,
    "800 76px Arial, Helvetica, sans-serif",
    green,
    18
  );

  drawCenteredText(
    context,
    `${transactionCount.toLocaleString("en-US")} TX`,
    rightCenterX,
    365,
    "800 58px Arial, Helvetica, sans-serif",
    white
  );

  drawCenteredText(
    context,
    "LIFETIME ON ABSTRACT",
    rightCenterX,
    425,
    "700 20px Arial, Helvetica, sans-serif",
    green
  );


  /* TAGLINE */

  context.save();

  context.fillStyle =
    "rgba(0,255,133,0.16)";

  context.fillRect(
    675,
    495,
    340,
    1
  );

  context.restore();

  drawCenteredText(
    context,
    "ABSTRACT IS ALIVE",
    rightCenterX,
    535,
    "700 18px Arial, Helvetica, sans-serif",
    muted
  );
}


/* =========================
   SHARE IMAGE
========================= */

function getShareText() {
  if (
    currentShareTx === null ||
    !currentShareTier
  ) {
    return "";
  }

  return (
    "This is my Abstract Pulse.\n\n" +
    currentShareTx
      .toLocaleString("en-US") +
    " lifetime transactions on @AbstractChain.\n\n" +
    currentShareTier +
    " tier."
  );
}


function canvasToBlob(
  canvas
) {
  return new Promise(
    resolve => {
      canvas.toBlob(
        resolve,
        "image/png"
      );
    }
  );
}


async function copyPulseImage() {
  if (!shareCard) {
    return;
  }

  if (shareMessage) {
    shareMessage.textContent =
      "";
  }

  try {
    const blob =
      await canvasToBlob(
        shareCard
      );

    if (!blob) {
      throw new Error(
        "Could not create image."
      );
    }

    if (
      navigator.clipboard &&
      window.ClipboardItem
    ) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "image/png": blob
        })
      ]);

      if (shareMessage) {
        shareMessage.textContent =
          "IMAGE COPIED";
      }

      return;
    }

    throw new Error(
      "Image clipboard is not supported."
    );

  } catch (error) {
    console.warn(
      "Copy image failed:",
      error
    );

    if (shareMessage) {
      shareMessage.textContent =
        "COPY IMAGE IS NOT SUPPORTED BY THIS BROWSER";
    }
  }
}


function sharePulseOnX() {
  if (
    currentShareTx === null ||
    !currentShareTier
  ) {
    return;
  }

  const text =
    getShareText();

  const url =
    "https://twitter.com/intent/tweet?text=" +
    encodeURIComponent(
      text
    );

  window.open(
    url,
    "_blank",
    "noopener,noreferrer"
  );

  if (shareMessage) {
    shareMessage.textContent =
      "X OPENED — COPY IMAGE AND PASTE IT INTO YOUR POST";
  }
}


/* =========================
   SHARE ACTIONS
========================= */

if (copyShareImage) {
  copyShareImage.addEventListener(
    "click",
    copyPulseImage
  );
}


if (shareOnX) {
  shareOnX.addEventListener(
    "click",
    sharePulseOnX
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

      if (sharePulse) {
        sharePulse
          .classList
          .add("hidden");
      }

      currentShareTx =
        null;

      currentShareTier =
        null;

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
        const [
          balanceHex,
          nonceHex,
          walletTodayStats
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

            getWalletTodayStats(
              address
            )
          ]);

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

        if (walletTxToday) {
          const todayCount =
            Number(
              walletTodayStats &&
              walletTodayStats.txSentToday
            );

          walletTxToday.textContent =
            Number.isFinite(
              todayCount
            )
              ? todayCount.toLocaleString(
                  "en-US"
                )
              : "—";
        }

        checkerMessage.textContent =
          "";

        walletResult
          .classList
          .remove("hidden");


        /* SHARE PULSE */

        currentShareTx =
          nonce;

        currentShareTier =
          getAbstractPulseTier(
            nonce
          );

        await renderShareCard(
          nonce,
          currentShareTier
        );

        if (sharePulse) {
          sharePulse
            .classList
            .remove("hidden");
        }


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
    "COLLECTING...";
}

if (txYesterdayElement) {
  txYesterdayElement.textContent =
    "COLLECTING...";
}

if (avgTxMinuteElement) {
  avgTxMinuteElement.textContent =
    "COLLECTING...";
}

if (avgTxBlockElement) {
  avgTxBlockElement.textContent =
    "COLLECTING...";
}

if (networkTpsElement) {
  networkTpsElement.textContent =
    "LOADING...";
}


if (
  activityChartElement
) {
  activityChartElement.innerHTML =
    '<div class="activity-chart-loading">COLLECTING DATA...</div>';
}


if (dailyAthTxElement) {
  dailyAthTxElement.textContent =
    "LOADING...";
}

if (dailyAthDateElement) {
  dailyAthDateElement.textContent =
    "—";
}

if (dailyAthStandingElement) {
  dailyAthStandingElement.textContent =
    "STANDING FOR — DAYS";
}

if (dailyAthTrackedSinceElement) {
  dailyAthTrackedSinceElement.textContent =
    "Tracked since —";
}


if (hourlyAthTxElement) {
  hourlyAthTxElement.textContent =
    "LOADING...";
}

if (hourlyAthDateElement) {
  hourlyAthDateElement.textContent =
    "—";
}

if (hourlyAthStandingElement) {
  hourlyAthStandingElement.textContent =
    "STANDING FOR — DAYS";
}

if (minuteAthTxElement) {
  minuteAthTxElement.textContent =
    "LOADING...";
}

if (minuteAthDateElement) {
  minuteAthDateElement.textContent =
    "—";
}

if (minuteAthStandingElement) {
  minuteAthStandingElement.textContent =
    "STANDING FOR — DAYS";
}

if (tpsAthValueElement) {
  tpsAthValueElement.textContent =
    "LOADING...";
}

if (tpsAthDateElement) {
  tpsAthDateElement.textContent =
    "—";
}

if (tpsAthStandingElement) {
  tpsAthStandingElement.textContent =
    "STANDING FOR — DAYS";
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


/* Start live Abstract connection. */

connect();


/* Load statistics. */

loadStats();


/* Poll for new live blocks. */

setInterval(
  checkForNewBlocks,
  1500
);


/* Last heartbeat clock. */

setInterval(
  updateHeartbeatTimer,
  1000
);


/* Refresh server statistics. */

setInterval(
  loadStats,
  30000
);
