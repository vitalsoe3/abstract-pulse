const RPC_URL = "https://api.mainnet.abs.xyz";

const REDIS_URL =
  process.env.STORAGE_KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  "";

const REDIS_TOKEN =
  process.env.STORAGE_KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  "";

const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 300_000;
const DAY_MS = 86_400_000;

const PREFIX = "abstract:v3";

/*
  QStash runs every 2 minutes.

  Normally there will only be ~2 missing minutes.
  Limit protects the free RPC/function if QStash
  has been offline for some time.
*/
const MAX_MINUTES_PER_REFRESH = 4;
const BLOCK_FETCH_CONCURRENCY = 8;


/* =========================
   RPC
========================= */

async function rpc(method, params = []) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    10_000
  );

  try {
    const response = await fetch(
      RPC_URL,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Math.floor(
            Math.random() * 1_000_000_000
          ),
          method,
          params
        }),

        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(
        `RPC HTTP ${response.status}`
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


async function getBlock(number) {
  const block =
    await rpc(
      "eth_getBlockByNumber",
      [
        "0x" +
          number.toString(16),
        false
      ]
    );

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
   REDIS
========================= */

function redisAvailable() {
  return Boolean(
    REDIS_URL &&
    REDIS_TOKEN
  );
}


async function redisCommand(command) {
  if (!redisAvailable()) {
    return null;
  }

  const response =
    await fetch(
      REDIS_URL,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${REDIS_TOKEN}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(command)
      }
    );

  if (!response.ok) {
    throw new Error(
      `Redis HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (
    data &&
    data.error
  ) {
    throw new Error(
      data.error
    );
  }

  return data
    ? data.result
    : null;
}


/* =========================
   TIME
========================= */

function getMinuteStart(time) {
  return (
    Math.floor(
      time / MINUTE_MS
    ) *
    MINUTE_MS
  );
}


function getFiveMinuteStart(time) {
  return (
    Math.floor(
      time / FIVE_MINUTES_MS
    ) *
    FIVE_MINUTES_MS
  );
}


function getUtcDayStart(time) {
  const date =
    new Date(time);

  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );
}


function dayKeyFromStart(dayStart) {
  return new Date(dayStart)
    .toISOString()
    .slice(0, 10);
}


function minuteIndexInDay(
  minuteStart
) {
  const dayStart =
    getUtcDayStart(
      minuteStart
    );

  return Math.floor(
    (
      minuteStart -
      dayStart
    ) /
    MINUTE_MS
  );
}


/* =========================
   KEYS
========================= */

function minuteHashKey(dayKey) {
  return (
    `${PREFIX}:minutes:${dayKey}`
  );
}


function daySummaryKey(dayKey) {
  return (
    `${PREFIX}:day:${dayKey}`
  );
}


function liveMinuteKey(start) {
  return (
    `${PREFIX}:live:minute:${start}`
  );
}


function liveFiveKey(start) {
  return (
    `${PREFIX}:live:five:${start}`
  );
}


function dayStartBlockKey(dayKey) {
  return (
    `${PREFIX}:day-start-block:${dayKey}`
  );
}


const NEXT_MINUTE_KEY =
  `${PREFIX}:collector:nextMinute`;

const COLLECTOR_STARTED_KEY =
  `${PREFIX}:collector:startedAt`;

const FIRST_FULL_DAY_KEY =
  `${PREFIX}:collector:firstFullDay`;

const DAILY_ATH_KEY =
  `${PREFIX}:ath:daily`;


/* =========================
   FIND BLOCK BY TIME
========================= */

async function findFirstBlockAtOrAfter(
  targetTime,
  latestNumber
) {
  let upperNumber =
    latestNumber;

  let upperBlock =
    await getBlock(
      upperNumber
    );

  if (!upperBlock) {
    throw new Error(
      "Latest block unavailable"
    );
  }

  if (
    upperBlock.timestamp <
    targetTime
  ) {
    return latestNumber + 1;
  }

  let step = 64;

  let lowerNumber =
    upperNumber;

  let lowerBlock =
    upperBlock;

  while (
    lowerNumber > 0 &&
    lowerBlock.timestamp >=
      targetTime
  ) {
    upperNumber =
      lowerNumber;

    lowerNumber =
      Math.max(
        0,
        lowerNumber - step
      );

    lowerBlock =
      await getBlock(
        lowerNumber
      );

    if (!lowerBlock) {
      throw new Error(
        "Historical block unavailable"
      );
    }

    step *= 2;
  }

  let left =
    lowerNumber;

  let right =
    upperNumber;

  while (
    left + 1 < right
  ) {
    const middle =
      Math.floor(
        (left + right) / 2
      );

    const block =
      await getBlock(
        middle
      );

    if (!block) {
      throw new Error(
        "Block unavailable during search"
      );
    }

    if (
      block.timestamp <
      targetTime
    ) {
      left = middle;
    } else {
      right = middle;
    }
  }

  const leftBlock =
    await getBlock(left);

  if (
    leftBlock &&
    leftBlock.timestamp >=
      targetTime
  ) {
    return left;
  }

  return right;
}


/* =========================
   INTERVAL CALCULATION
========================= */

async function calculateInterval(
  start,
  end,
  latestNumber
) {
  const firstBlock =
    await findFirstBlockAtOrAfter(
      start,
      latestNumber
    );

  const afterEnd =
    await findFirstBlockAtOrAfter(
      end,
      latestNumber
    );

  const finalBlock =
    Math.min(
      latestNumber,
      afterEnd - 1
    );

  if (
    firstBlock > finalBlock
  ) {
    return {
      transactions: 0,
      blocks: 0,
      start,
      end
    };
  }

  let transactions = 0;
  let blocks = 0;

  for (
    let batchStart =
      firstBlock;

    batchStart <=
      finalBlock;

    batchStart +=
      BLOCK_FETCH_CONCURRENCY
  ) {
    const batchEnd =
      Math.min(
        finalBlock,
        batchStart +
          BLOCK_FETCH_CONCURRENCY -
          1
      );

    const promises = [];

    for (
      let number =
        batchStart;

      number <=
        batchEnd;

      number++
    ) {
      promises.push(
        getBlock(number)
      );
    }

    const result =
      await Promise.all(
        promises
      );

    for (const block of result) {
      if (!block) {
        continue;
      }

      if (
        block.timestamp >= start &&
        block.timestamp < end
      ) {
        transactions +=
          block.transactions;

        blocks += 1;
      }
    }
  }

  return {
    transactions,
    blocks,
    start,
    end
  };
}


/* =========================
   LIVE MINUTE
========================= */

async function getLiveMinute(
  start,
  latestNumber
) {
  if (redisAvailable()) {
    const stored =
      await redisCommand([
        "GET",
        liveMinuteKey(start)
      ]);

    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
      }
    }
  }

  const result =
    await calculateInterval(
      start,
      start + MINUTE_MS,
      latestNumber
    );

  if (redisAvailable()) {
    await redisCommand([
      "SET",
      liveMinuteKey(start),
      JSON.stringify(result),
      "EX",
      "172800"
    ]);
  }

  return result;
}


/* =========================
   LIVE FIVE MINUTES
========================= */

async function getLiveFiveMinutes(
  start,
  latestNumber
) {
  if (redisAvailable()) {
    const stored =
      await redisCommand([
        "GET",
        liveFiveKey(start)
      ]);

    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
      }
    }
  }

  const result =
    await calculateInterval(
      start,
      start +
        FIVE_MINUTES_MS,
      latestNumber
    );

  if (redisAvailable()) {
    await redisCommand([
      "SET",
      liveFiveKey(start),
      JSON.stringify(result),
      "EX",
      "172800"
    ]);
  }

  return result;
}


/* =========================
   STORE COMPLETED MINUTE
========================= */

async function storeCompletedMinute(
  minuteStart,
  result
) {
  const dayStart =
    getUtcDayStart(
      minuteStart
    );

  const dayKey =
    dayKeyFromStart(
      dayStart
    );

  const field =
    minuteIndexInDay(
      minuteStart
    ).toString();

  await redisCommand([
    "HSET",
    minuteHashKey(dayKey),
    field,
    JSON.stringify(result)
  ]);
}


/* =========================
   INITIALIZE COLLECTOR
========================= */

async function initializeCollector(now) {
  let nextMinute =
    await redisCommand([
      "GET",
      NEXT_MINUTE_KEY
    ]);

  if (
    nextMinute !== null &&
    nextMinute !== undefined
  ) {
    const parsed =
      Number(nextMinute);

    if (
      Number.isFinite(parsed)
    ) {
      return parsed;
    }
  }

  const currentMinute =
    getMinuteStart(now);

  const nextFullDay =
    getUtcDayStart(now) +
    DAY_MS;

  await redisCommand([
    "SET",
    COLLECTOR_STARTED_KEY,
    now.toString()
  ]);

  await redisCommand([
    "SET",
    FIRST_FULL_DAY_KEY,
    nextFullDay.toString()
  ]);

  await redisCommand([
    "SET",
    NEXT_MINUTE_KEY,
    currentMinute.toString()
  ]);

  return currentMinute;
}
