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
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const PREFIX = "abstract:v3";
const MAX_MINUTES_PER_REFRESH = 4;
const BLOCK_FETCH_CONCURRENCY = 8;

const NEXT_MINUTE_KEY = `${PREFIX}:collector:nextMinute`;
const COLLECTOR_STARTED_KEY = `${PREFIX}:collector:startedAt`;
const FIRST_FULL_DAY_KEY = `${PREFIX}:collector:firstFullDay`;
const DAILY_ATH_KEY = `${PREFIX}:ath:daily`;
const RECORD_BOOK_KEY = `${PREFIX}:ath:recordBook`;


/* =========================
   RPC
========================= */

async function rpc(
  method,
  params = [],
  timeoutMs = 20_000
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      timeoutMs
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
                  1_000_000_000
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


async function getLatestBlockNumber() {
  const latestHex =
    await rpc(
      "eth_blockNumber"
    );

  return Number(
    BigInt(latestHex)
  );
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


function parseStoredNumber(value) {
  if (
    value === null ||
    typeof value ===
      "undefined" ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
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


async function safeRedisCommand(
  command,
  fallback = null
) {
  try {
    const result =
      await redisCommand(
        command
      );

    return typeof result ===
      "undefined"
        ? fallback
        : result;

  } catch (error) {
    console.warn(
      "Redis read error:",
      error
    );

    return fallback;
  }
}


/* =========================
   TIME + KEYS
========================= */

function getMinuteStart(time) {
  return (
    Math.floor(
      time /
      MINUTE_MS
    ) *
    MINUTE_MS
  );
}


function getFiveMinuteStart(time) {
  return (
    Math.floor(
      time /
      FIVE_MINUTES_MS
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


function dayKeyFromStart(
  dayStart
) {
  return new Date(
    dayStart
  )
    .toISOString()
    .slice(
      0,
      10
    );
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


function minuteHashKey(
  dayKey
) {
  return (
    `${PREFIX}:minutes:${dayKey}`
  );
}


function daySummaryKey(
  dayKey
) {
  return (
    `${PREFIX}:day:${dayKey}`
  );
}


function liveMinuteKey(
  start
) {
  return (
    `${PREFIX}:live:minute:${start}`
  );
}


function liveFiveKey(
  start
) {
  return (
    `${PREFIX}:live:five:${start}`
  );
}


function dayStartBlockKey(
  dayKey
) {
  return (
    `${PREFIX}:day-start-block:${dayKey}`
  );
}


/* =========================
   BLOCK BOUNDARY SEARCH
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
    return (
      latestNumber +
      1
    );
  }

  let step =
    64;

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
        lowerNumber -
          step
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
    left + 1 <
    right
  ) {
    const middle =
      Math.floor(
        (
          left +
          right
        ) /
        2
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
      left =
        middle;

    } else {
      right =
        middle;
    }
  }

  const leftBlock =
    await getBlock(
      left
    );

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
    firstBlock >
    finalBlock
  ) {
    return {
      transactions: 0,
      blocks: 0,
      start,
      end
    };
  }

  let transactions =
    0;

  let blocks =
    0;

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

    const numbers =
      [];

    for (
      let number =
        batchStart;

      number <=
        batchEnd;

      number++
    ) {
      numbers.push(
        number
      );
    }

    const result =
      await Promise.all(
        numbers.map(
          number =>
            getBlock(
              number
            )
        )
      );

    for (
      const block of
        result
    ) {
      if (!block) {
        continue;
      }

      if (
        block.timestamp >=
          start &&
        block.timestamp <
          end
      ) {
        transactions +=
          block.transactions;

        blocks +=
          1;
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
   STORED MINUTES
========================= */

async function readStoredMinute(
  minuteStart
) {
  if (!redisAvailable()) {
    return null;
  }

  const dayKey =
    dayKeyFromStart(
      getUtcDayStart(
        minuteStart
      )
    );

  const field =
    minuteIndexInDay(
      minuteStart
    ).toString();

  const raw =
    await safeRedisCommand([
      "HGET",

      minuteHashKey(
        dayKey
      ),

      field
    ]);

  if (!raw) {
    return null;
  }

  try {
    const value =
      JSON.parse(
        raw
      );

    if (
      value &&
      Number.isFinite(
        Number(
          value.transactions
        )
      )
    ) {
      return value;
    }

  } catch {
  }

  return null;
}


async function storeCompletedMinute(
  minuteStart,
  result
) {
  const dayKey =
    dayKeyFromStart(
      getUtcDayStart(
        minuteStart
      )
    );

  const field =
    minuteIndexInDay(
      minuteStart
    ).toString();

  await redisCommand([
    "HSET",

    minuteHashKey(
      dayKey
    ),

    field,

    JSON.stringify(
      result
    )
  ]);
}


async function getDayValues(
  dayStart
) {
  const dayKey =
    dayKeyFromStart(
      dayStart
    );

  const rawValues =
    await safeRedisCommand(
      [
        "HVALS",

        minuteHashKey(
          dayKey
        )
      ],
      []
    );

  if (
    !Array.isArray(
      rawValues
    )
  ) {
    return [];
  }

  const values =
    [];

  for (
    const raw of
      rawValues
  ) {
    try {
      const value =
        JSON.parse(
          raw
        );

      if (
        value &&
        Number.isFinite(
          Number(
            value.transactions
          )
        )
      ) {
        values.push(
          value
        );
      }

    } catch {
    }
  }

  return values;
}


async function getLatestStoredMinute(
  now
) {
  const nextMinuteRaw =
    await safeRedisCommand([
      "GET",
      NEXT_MINUTE_KEY
    ]);

  const currentMinute =
    getMinuteStart(
      now
    );

  let candidate =
    parseStoredNumber(
      nextMinuteRaw
    );

  if (
    candidate ===
    null
  ) {
    candidate =
      currentMinute;
  }

  candidate =
    Math.min(
      candidate,
      currentMinute
    ) -
    MINUTE_MS;

  for (
    let i = 0;
    i < 30;
    i++
  ) {
    const value =
      await readStoredMinute(
        candidate
      );

    if (value) {
      return {
        ...value,

        start:
          Number(
            value.start
          ) ||
          candidate,

        end:
          Number(
            value.end
          ) ||
          candidate +
            MINUTE_MS
      };
    }

    candidate -=
      MINUTE_MS;
  }

  return null;
}


async function getStoredFiveMinutes(
  lastMinute
) {
  if (!lastMinute) {
    return null;
  }

  const lastStart =
    Number(
      lastMinute.start
    );

  if (
    !Number.isFinite(
      lastStart
    )
  ) {
    return null;
  }

  const start =
    lastStart -
    4 *
      MINUTE_MS;

  const end =
    lastStart +
    MINUTE_MS;

  let transactions =
    0;

  let blocks =
    0;

  let found =
    0;

  for (
    let minuteStart =
      start;

    minuteStart <
      end;

    minuteStart +=
      MINUTE_MS
  ) {
    const value =
      await readStoredMinute(
        minuteStart
      );

    if (!value) {
      continue;
    }

    transactions +=
      Number(
        value.transactions ||
        0
      );

    blocks +=
      Number(
        value.blocks ||
        0
      );

    found +=
      1;
  }

  if (
    found === 0
  ) {
    return null;
  }

  return {
    transactions,
    blocks,
    start,
    end,
    minutes:
      found
  };
}


/* =========================
   LIVE FALLBACKS
========================= */

async function getLiveMinute(
  start,
  latestNumber
) {
  if (
    redisAvailable()
  ) {
    const stored =
      await safeRedisCommand([
        "GET",

        liveMinuteKey(
          start
        )
      ]);

    if (stored) {
      try {
        return JSON.parse(
          stored
        );

      } catch {
      }
    }
  }

  const calculated =
    await calculateInterval(
      start,
      start +
        MINUTE_MS,
      latestNumber
    );

  if (
    redisAvailable()
  ) {
    try {
      await redisCommand([
        "SET",

        liveMinuteKey(
          start
        ),

        JSON.stringify(
          calculated
        ),

        "EX",
        "172800"
      ]);

    } catch (error) {
      console.warn(
        "Live minute cache write error:",
        error
      );
    }
  }

  return calculated;
}


async function getLiveFiveMinutes(
  start,
  latestNumber
) {
  if (
    redisAvailable()
  ) {
    const stored =
      await safeRedisCommand([
        "GET",

        liveFiveKey(
          start
        )
      ]);

    if (stored) {
      try {
        return JSON.parse(
          stored
        );

      } catch {
      }
    }
  }

  const calculated =
    await calculateInterval(
      start,
      start +
        FIVE_MINUTES_MS,
      latestNumber
    );

  if (
    redisAvailable()
  ) {
    try {
      await redisCommand([
        "SET",

        liveFiveKey(
          start
        ),

        JSON.stringify(
          calculated
        ),

        "EX",
        "172800"
      ]);

    } catch (error) {
      console.warn(
        "Live five-minute cache write error:",
        error
      );
    }
  }

  return calculated;
}


/* =========================
   COLLECTOR
========================= */

async function initializeCollector(
  now
) {
  const nextMinuteRaw =
    await safeRedisCommand([
      "GET",
      NEXT_MINUTE_KEY
    ]);

  const parsed =
    parseStoredNumber(
      nextMinuteRaw
    );

  if (
    parsed !== null
  ) {
    return parsed;
  }

  const currentMinute =
    getMinuteStart(
      now
    );

  const collectorStartedRaw =
    await safeRedisCommand([
      "GET",
      COLLECTOR_STARTED_KEY
    ]);

  if (
    !collectorStartedRaw
  ) {
    await redisCommand([
      "SET",

      COLLECTOR_STARTED_KEY,

      now.toString()
    ]);
  }

  const firstFullDayRaw =
    await safeRedisCommand([
      "GET",
      FIRST_FULL_DAY_KEY
    ]);

  if (
    !firstFullDayRaw
  ) {
    await redisCommand([
      "SET",

      FIRST_FULL_DAY_KEY,

      (
        getUtcDayStart(
          now
        ) +
        DAY_MS
      ).toString()
    ]);
  }

  await redisCommand([
    "SET",

    NEXT_MINUTE_KEY,

    currentMinute.toString()
  ]);

  return currentMinute;
}


async function collectNewMinutes(
  now,
  latestNumber
) {
  if (
    !redisAvailable()
  ) {
    return {
      processed: 0,
      nextMinute: null
    };
  }

  const currentMinute =
    getMinuteStart(
      now
    );

  let nextMinute =
    await initializeCollector(
      now
    );

  let processed =
    0;

  while (
    nextMinute <
      currentMinute &&
    processed <
      MAX_MINUTES_PER_REFRESH
  ) {
    const result =
      await calculateInterval(
        nextMinute,

        nextMinute +
          MINUTE_MS,

        latestNumber
      );

    await storeCompletedMinute(
      nextMinute,
      result
    );

    try {
      await updateRecordBookWithMinute(
        nextMinute,
        result
      );

    } catch (error) {
      console.warn(
        "Record Book collector error:",
        error
      );
    }

    nextMinute +=
      MINUTE_MS;

    processed +=
      1;

    await redisCommand([
      "SET",

      NEXT_MINUTE_KEY,

      nextMinute.toString()
    ]);
  }

  return {
    processed,
    nextMinute
  };
}


/* =========================
   DAY SUMMARIES
========================= */

async function buildCurrentDaySummary(
  dayStart,
  currentMinuteStart
) {
  const values =
    await getDayValues(
      dayStart
    );

  if (
    values.length ===
    0
  ) {
    return null;
  }

  let transactions =
    0;

  let blocks =
    0;

  let minutes =
    0;

  for (
    const value of
      values
  ) {
    const start =
      Number(
        value.start
      );

    if (
      Number.isFinite(
        start
      ) &&
      start >=
        currentMinuteStart
    ) {
      continue;
    }

    transactions +=
      Number(
        value.transactions ||
        0
      );

    blocks +=
      Number(
        value.blocks ||
        0
      );

    minutes +=
      1;
  }

  if (
    minutes ===
    0
  ) {
    return null;
  }

  return {
    date:
      dayKeyFromStart(
        dayStart
      ),

    transactions,

    blocks,

    minutes,

    complete:
      false,

    partial:
      true
  };
}


async function buildCompletedDaySummary(
  dayStart
) {
  const dayKey =
    dayKeyFromStart(
      dayStart
    );

  const cached =
    await safeRedisCommand([
      "GET",

      daySummaryKey(
        dayKey
      )
    ]);

  if (cached) {
    try {
      const parsed =
        JSON.parse(
          cached
        );

      if (
        parsed &&
        Number.isFinite(
          Number(
            parsed.transactions
          )
        )
      ) {
        return parsed;
      }

    } catch {
    }
  }

  const firstFullDayRaw =
    await safeRedisCommand([
      "GET",
      FIRST_FULL_DAY_KEY
    ]);

  const firstFullDay =
    parseStoredNumber(
      firstFullDayRaw
    );

  if (
    firstFullDay ===
      null ||
    dayStart <
      firstFullDay
  ) {
    return null;
  }

  const nextMinuteRaw =
    await safeRedisCommand([
      "GET",
      NEXT_MINUTE_KEY
    ]);

  const nextMinute =
    parseStoredNumber(
      nextMinuteRaw
    );

  const dayEnd =
    dayStart +
    DAY_MS;

  if (
    nextMinute !==
      null &&
    nextMinute <
      dayEnd
  ) {
    return null;
  }

  const values =
    await getDayValues(
      dayStart
    );

  if (
    values.length ===
    0
  ) {
    return null;
  }

  let transactions =
    0;

  let blocks =
    0;

  for (
    const value of
      values
  ) {
    transactions +=
      Number(
        value.transactions ||
        0
      );

    blocks +=
      Number(
        value.blocks ||
        0
      );
  }

  const summary = {
    date:
      dayKey,

    transactions,

    blocks,

    minutes:
      values.length,

    complete:
      true
  };

  try {
    await redisCommand([
      "SET",

      daySummaryKey(
        dayKey
      ),

      JSON.stringify(
        summary
      )
    ]);

  } catch (error) {
    console.warn(
      "Day summary cache write error:",
      error
    );
  }

  return summary;
}


async function getSevenDays(
  now
) {
  const todayStart =
    getUtcDayStart(
      now
    );

  const days =
    [];

  for (
    let offset =
      7;

    offset >=
      1;

    offset--
  ) {
    const dayStart =
      todayStart -
      offset *
        DAY_MS;

    const summary =
      await buildCompletedDaySummary(
        dayStart
      );

    if (summary) {
      days.push({
        date:
          summary.date,

        transactions:
          Number(
            summary.transactions
          )
      });
    }
  }

  return days;
}


/* =========================
   DAILY ATH
========================= */

async function getDailyAth(
  now
) {
  if (
    !redisAvailable()
  ) {
    return null;
  }

  const firstFullDayRaw =
    await safeRedisCommand([
      "GET",
      FIRST_FULL_DAY_KEY
    ]);

  const firstFullDay =
    parseStoredNumber(
      firstFullDayRaw
    );

  if (
    firstFullDay ===
    null
  ) {
    return null;
  }

  const todayStart =
    getUtcDayStart(
      now
    );

  const yesterdayStart =
    todayStart -
    DAY_MS;

  if (
    firstFullDay >
    yesterdayStart
  ) {
    return null;
  }

  let record =
    null;

  const stored =
    await safeRedisCommand([
      "GET",
      DAILY_ATH_KEY
    ]);

  if (stored) {
    try {
      const parsed =
        JSON.parse(
          stored
        );

      if (
        parsed &&
        Number.isFinite(
          Number(
            parsed.transactions
          )
        ) &&
        Number.isFinite(
          Number(
            parsed.dayStart
          )
        )
      ) {
        record =
          parsed;
      }

    } catch {
    }
  }

  let nextDay =
    record &&
    Number.isFinite(
      Number(
        record.checkedThrough
      )
    )
      ? Number(
          record.checkedThrough
        ) +
        DAY_MS
      : firstFullDay;

  if (
    nextDay <
    firstFullDay
  ) {
    nextDay =
      firstFullDay;
  }

  let checkedThrough =
    record &&
    Number.isFinite(
      Number(
        record.checkedThrough
      )
    )
      ? Number(
          record.checkedThrough
        )
      : firstFullDay -
        DAY_MS;

  for (
    let dayStart =
      nextDay;

    dayStart <=
      yesterdayStart;

    dayStart +=
      DAY_MS
  ) {
    const summary =
      await buildCompletedDaySummary(
        dayStart
      );

    if (!summary) {
      break;
    }

    const transactions =
      Number(
        summary.transactions
      );

    if (
      Number.isFinite(
        transactions
      ) &&
      (
        !record ||
        transactions >
          Number(
            record.transactions
          )
      )
    ) {
      record = {
        date:
          summary.date,

        transactions,

        dayStart,

        checkedThrough:
          dayStart
      };
    }

    checkedThrough =
      dayStart;

    if (record) {
      record.checkedThrough =
        checkedThrough;
    }
  }

  if (!record) {
    return null;
  }

  try {
    await redisCommand([
      "SET",

      DAILY_ATH_KEY,

      JSON.stringify(
        record
      )
    ]);

  } catch (error) {
    console.warn(
      "Daily ATH cache write error:",
      error
    );
  }

  const standingDays =
    Math.max(
      0,

      Math.floor(
        (
          todayStart -
          Number(
            record.dayStart
          )
        ) /
        DAY_MS
      ) -
      1
    );

  return {
    date:
      record.date,

    transactions:
      Number(
        record.transactions
      ),

    standingDays,

    trackedSince:
      dayKeyFromStart(
        firstFullDay
      )
  };
}


/* =========================
   RECORD BOOK
========================= */

function recordStandingDays(
  timestamp,
  now
) {
  const recordDayStart =
    getUtcDayStart(
      timestamp
    );

  const todayStart =
    getUtcDayStart(
      now
    );

  return Math.max(
    0,

    Math.floor(
      (
        todayStart -
        recordDayStart
      ) /
      DAY_MS
    )
  );
}


function emptyRecordBook() {
  return {
    hourly: null,
    minute: null,
    tps: null,
    checkedThrough: null
  };
}


function validRecordBook(
  value
) {
  return Boolean(
    value &&
    typeof value ===
      "object"
  );
}


function updateMinuteRecords(
  recordBook,
  minuteStart,
  transactions
) {
  const tx =
    Number(
      transactions
    );

  if (
    !Number.isFinite(
      tx
    )
  ) {
    return;
  }

  if (
    !recordBook.minute ||
    tx >
      Number(
        recordBook.minute.value
      )
  ) {
    recordBook.minute = {
      value:
        tx,

      timestamp:
        minuteStart
    };
  }

  const tps =
    tx /
    60;

  if (
    !recordBook.tps ||
    tps >
      Number(
        recordBook.tps.value
      )
  ) {
    recordBook.tps = {
      value:
        tps,

      timestamp:
        minuteStart
    };
  }
}


function updateHourlyRecord(
  recordBook,
  hourStart,
  transactions
) {
  const tx =
    Number(
      transactions
    );

  if (
    !Number.isFinite(
      tx
    )
  ) {
    return;
  }

  if (
    !recordBook.hourly ||
    tx >
      Number(
        recordBook.hourly.value
      )
  ) {
    recordBook.hourly = {
      value:
        tx,

      timestamp:
        hourStart
    };
  }
}


async function buildRecordBookFromHistory(
  now
) {
  if (
    !redisAvailable()
  ) {
    return null;
  }

  const firstFullDayRaw =
    await safeRedisCommand([
      "GET",
      FIRST_FULL_DAY_KEY
    ]);

  const firstFullDay =
    parseStoredNumber(
      firstFullDayRaw
    );

  if (
    firstFullDay ===
    null
  ) {
    return null;
  }

  const currentMinuteStart =
    getMinuteStart(
      now
    );

  const todayStart =
    getUtcDayStart(
      now
    );

  const recordBook =
    emptyRecordBook();

  let latestStoredMinute =
    null;

  for (
    let dayStart =
      firstFullDay;

    dayStart <=
      todayStart;

    dayStart +=
      DAY_MS
  ) {
    const values =
      await getDayValues(
        dayStart
      );

    const completedMinutes =
      values
        .filter(
          item => {
            const start =
              Number(
                item &&
                item.start
              );

            return (
              Number.isFinite(
                start
              ) &&
              start >=
                firstFullDay &&
              start <
                currentMinuteStart
            );
          }
        )
        .sort(
          (
            a,
            b
          ) =>
            Number(
              a.start
            ) -
            Number(
              b.start
            )
        );

    const hours =
      new Map();

    for (
      const item of
        completedMinutes
    ) {
      const minuteStart =
        Number(
          item.start
        );

      updateMinuteRecords(
        recordBook,
        minuteStart,
        item.transactions
      );

      if (
        latestStoredMinute ===
          null ||
        minuteStart >
          latestStoredMinute
      ) {
        latestStoredMinute =
          minuteStart;
      }

      const hourStart =
        Math.floor(
          minuteStart /
          HOUR_MS
        ) *
        HOUR_MS;

      if (
        !hours.has(
          hourStart
        )
      ) {
        hours.set(
          hourStart,
          {
            minutes: 0,
            transactions: 0
          }
        );
      }

      const hour =
        hours.get(
          hourStart
        );

      hour.minutes +=
        1;

      hour.transactions +=
        Number(
          item.transactions ||
          0
        );
    }

    for (
      const [
        hourStart,
        hour
      ] of
        hours
    ) {
      if (
        hour.minutes ===
          60 &&
        hourStart +
          HOUR_MS <=
          currentMinuteStart
      ) {
        updateHourlyRecord(
          recordBook,
          hourStart,
          hour.transactions
        );
      }
    }
  }

  recordBook.checkedThrough =
    latestStoredMinute;

  try {
    await redisCommand([
      "SET",

      RECORD_BOOK_KEY,

      JSON.stringify(
        recordBook
      )
    ]);

  } catch (error) {
    console.warn(
      "Record Book cache write error:",
      error
    );
  }

  return recordBook;
}


async function getStoredRecordBook(
  now
) {
  if (
    !redisAvailable()
  ) {
    return null;
  }

  const stored =
    await safeRedisCommand([
      "GET",
      RECORD_BOOK_KEY
    ]);

  if (stored) {
    try {
      const parsed =
        JSON.parse(
          stored
        );

      if (
        validRecordBook(
          parsed
        )
      ) {
        return parsed;
      }

    } catch {
    }
  }

  return (
    buildRecordBookFromHistory(
      now
    )
  );
}


async function updateRecordBookWithMinute(
  minuteStart,
  result
) {
  if (
    !redisAvailable()
  ) {
    return;
  }

  const stored =
    await safeRedisCommand([
      "GET",
      RECORD_BOOK_KEY
    ]);

  if (!stored) {
    return;
  }

  let recordBook;

  try {
    recordBook =
      JSON.parse(
        stored
      );

  } catch {
    return;
  }

  if (
    !validRecordBook(
      recordBook
    )
  ) {
    return;
  }

  updateMinuteRecords(
    recordBook,
    minuteStart,
    result.transactions
  );

  const minuteDate =
    new Date(
      minuteStart
    );

  if (
    minuteDate
      .getUTCMinutes() ===
      59
  ) {
    const dayStart =
      getUtcDayStart(
        minuteStart
      );

    const hourStart =
      Math.floor(
        minuteStart /
        HOUR_MS
      ) *
      HOUR_MS;

    const values =
      await getDayValues(
        dayStart
      );

    const hourValues =
      values.filter(
        item => {
          const start =
            Number(
              item &&
              item.start
            );

          return (
            Number.isFinite(
              start
            ) &&
            start >=
              hourStart &&
            start <
              hourStart +
              HOUR_MS
          );
        }
      );

    if (
      hourValues.length ===
      60
    ) {
      const transactions =
        hourValues.reduce(
          (
            sum,
            item
          ) =>
            sum +
            Number(
              item.transactions ||
              0
            ),
          0
        );

      updateHourlyRecord(
        recordBook,
        hourStart,
        transactions
      );
    }
  }

  recordBook.checkedThrough =
    minuteStart;

  await redisCommand([
    "SET",

    RECORD_BOOK_KEY,

    JSON.stringify(
      recordBook
    )
  ]);
}


async function getRecordBook(
  now
) {
  const recordBook =
    await getStoredRecordBook(
      now
    );

  if (!recordBook) {
    return null;
  }

  const buildItem =
    item => {
      if (
        !item ||
        !Number.isFinite(
          Number(
            item.value
          )
        ) ||
        !Number.isFinite(
          Number(
            item.timestamp
          )
        )
      ) {
        return null;
      }

      return {
        value:
          Number(
            item.value
          ),

        timestamp:
          Number(
            item.timestamp
          ),

        standingDays:
          recordStandingDays(
            Number(
              item.timestamp
            ),
            now
          )
      };
    };

  return {
    hourly:
      buildItem(
        recordBook.hourly
      ),

    minute:
      buildItem(
        recordBook.minute
      ),

    tps:
      buildItem(
        recordBook.tps
      )
  };
}


/* =========================
   WALLET TX SENT TODAY
========================= */

function isValidAddress(
  address
) {
  return /^0x[a-fA-F0-9]{40}$/
    .test(
      address
    );
}


async function getDayStartBlock(
  dayStart,
  latestNumber
) {
  const dayKey =
    dayKeyFromStart(
      dayStart
    );

  if (
    redisAvailable()
  ) {
    const stored =
      await safeRedisCommand([
        "GET",

        dayStartBlockKey(
          dayKey
        )
      ]);

    const parsed =
      parseStoredNumber(
        stored
      );

    if (
      parsed !== null &&
      Number.isInteger(
        parsed
      ) &&
      parsed >= 0
    ) {
      return parsed;
    }
  }

  const firstBlock =
    await findFirstBlockAtOrAfter(
      dayStart,
      latestNumber
    );

  if (
    redisAvailable()
  ) {
    try {
      await redisCommand([
        "SET",

        dayStartBlockKey(
          dayKey
        ),

        firstBlock.toString(),

        "EX",
        "172800"
      ]);

    } catch (error) {
      console.warn(
        "Day-start block cache write error:",
        error
      );
    }
  }

  return firstBlock;
}


async function getWalletTxSentToday(
  address,
  now,
  latestNumber
) {
  const dayStart =
    getUtcDayStart(
      now
    );

  const firstBlockToday =
    await getDayStartBlock(
      dayStart,
      latestNumber
    );

  const baselineBlock =
    Math.max(
      0,
      firstBlockToday -
        1
    );

  const baselineTag =
    "0x" +
    baselineBlock
      .toString(
        16
      );

  const [
    startNonceHex,
    latestNonceHex
  ] =
    await Promise.all([
      rpc(
        "eth_getTransactionCount",
        [
          address,
          baselineTag
        ]
      ),

      rpc(
        "eth_getTransactionCount",
        [
          address,
          "latest"
        ]
      )
    ]);

  const startNonce =
    BigInt(
      startNonceHex
    );

  const latestNonce =
    BigInt(
      latestNonceHex
    );

  const difference =
    latestNonce >=
      startNonce
      ? latestNonce -
        startNonce
      : 0n;

  return Number(
    difference
  );
}


/* =========================
   NORMAL DASHBOARD DATA
========================= */

async function getDashboardStatsFromRedis(
  now
) {
  const currentMinuteStart =
    getMinuteStart(
      now
    );

  const todayStart =
    getUtcDayStart(
      now
    );

  const lastMinute =
    await getLatestStoredMinute(
      now
    );

  const lastFiveMinutes =
    await getStoredFiveMinutes(
      lastMinute
    );

  const today =
    await buildCurrentDaySummary(
      todayStart,
      currentMinuteStart
    );

  const yesterday =
    await buildCompletedDaySummary(
      todayStart -
      DAY_MS
    );

  const avgTxPerMinute =
    today &&
    today.minutes > 0
      ? today.transactions /
        today.minutes
      : null;

  const avgTxPerBlock =
    today &&
    today.blocks > 0
      ? today.transactions /
        today.blocks
      : null;

  const tps =
    lastMinute &&
    Number.isFinite(
      Number(
        lastMinute.transactions
      )
    )
      ? Number(
          lastMinute.transactions
        ) /
        60
      : null;

  const sevenDays =
    await getSevenDays(
      now
    );

  let dailyAth =
    null;

  let recordBook =
    null;

  try {
    dailyAth =
      await getDailyAth(
        now
      );

  } catch (error) {
    console.warn(
      "Daily ATH error:",
      error
    );
  }

  try {
    recordBook =
      await getRecordBook(
        now
      );

  } catch (error) {
    console.warn(
      "Record Book error:",
      error
    );
  }

  const collectorStartedRaw =
    await safeRedisCommand([
      "GET",
      COLLECTOR_STARTED_KEY
    ]);

  const nextMinuteRaw =
    await safeRedisCommand([
      "GET",
      NEXT_MINUTE_KEY
    ]);

  return {
    lastMinute,
    lastFiveMinutes,
    today,
    yesterday,
    avgTxPerMinute,
    avgTxPerBlock,
    tps,
    sevenDays,
    dailyAth,
    recordBook,
    collectorStartedRaw,
    nextMinuteRaw
  };
}


async function getDashboardStatsFromRpc(
  now
) {
  const currentMinuteStart =
    getMinuteStart(
      now
    );

  const latestNumber =
    await getLatestBlockNumber();

  const lastMinuteStart =
    currentMinuteStart -
    MINUTE_MS;

  const currentFiveStart =
    getFiveMinuteStart(
      now
    );

  const lastFiveStart =
    currentFiveStart -
    FIVE_MINUTES_MS;

  const lastMinute =
    await getLiveMinute(
      lastMinuteStart,
      latestNumber
    );

  const lastFiveMinutes =
    await getLiveFiveMinutes(
      lastFiveStart,
      latestNumber
    );

  return {
    lastMinute,
    lastFiveMinutes,

    today:
      null,

    yesterday:
      null,

    avgTxPerMinute:
      null,

    avgTxPerBlock:
      null,

    tps:
      Number(
        lastMinute.transactions ||
        0
      ) /
      60,

    sevenDays:
      [],

    dailyAth:
      null,

    recordBook:
      null,

    collectorStartedRaw:
      null,

    nextMinuteRaw:
      null,

    latestBlock:
      latestNumber
  };
}


/* =========================
   HANDLER
========================= */

export default async function handler(
  req,
  res
) {
  const now =
    Date.now();

  try {

    /*
      =========================
      WALLET REQUEST
      =========================
    */

    if (
      req.query &&
      typeof req.query.wallet ===
        "string"
    ) {
      const address =
        req.query.wallet
          .trim();

      if (
        !isValidAddress(
          address
        )
      ) {
        return res
          .status(
            400
          )
          .json({
            error:
              "Invalid Abstract address."
          });
      }

      const latestNumber =
        await getLatestBlockNumber();

      const txSentToday =
        await getWalletTxSentToday(
          address,
          now,
          latestNumber
        );

      res.setHeader(
        "Cache-Control",
        "private, no-store"
      );

      return res
        .status(
          200
        )
        .json({
          address,

          txSentToday,

          dayStart:
            getUtcDayStart(
              now
            ),

          dayStartIso:
            new Date(
              getUtcDayStart(
                now
              )
            ).toISOString(),

          latestBlock:
            latestNumber,

          generatedAt:
            Date.now()
        });
    }


    /*
      =========================
      QSTASH COLLECTOR
      =========================
    */

    if (
      req.query &&
      req.query.refresh ===
        "1"
    ) {
      if (
        !redisAvailable()
      ) {
        return res
          .status(
            503
          )
          .json({
            error:
              "Redis is not configured."
          });
      }

      const latestNumber =
        await getLatestBlockNumber();

      const collection =
        await collectNewMinutes(
          now,
          latestNumber
        );

      return res
        .status(
          200
        )
        .json({
          ok:
            true,

          mode:
            "collector",

          processedMinutes:
            collection.processed,

          nextMinute:
            collection.nextMinute,

          nextMinuteIso:
            collection.nextMinute
              ? new Date(
                  collection.nextMinute
                ).toISOString()
              : null,

          latestBlock:
            latestNumber,

          redis:
            "connected",

          generatedAt:
            Date.now()
        });
    }


    /*
      =========================
      NORMAL WEBSITE REQUEST

      IMPORTANT:
      Existing Redis history is
      read first.

      The dashboard therefore
      does not depend on a live
      RPC request just to show
      stored 7-day activity,
      Today, Yesterday, ATH and
      Record Book.
      =========================
    */

    let data;

    if (
      redisAvailable()
    ) {
      data =
        await getDashboardStatsFromRedis(
          now
        );

    } else {
      data =
        await getDashboardStatsFromRpc(
          now
        );
    }

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=20, stale-while-revalidate=40"
    );

    return res
      .status(
        200
      )
      .json({

        lastMinute:
          data.lastMinute
            ? {
                transactions:
                  Number(
                    data.lastMinute
                      .transactions ||
                    0
                  ),

                start:
                  Number(
                    data.lastMinute
                      .start
                  ),

                end:
                  Number(
                    data.lastMinute
                      .end
                  )
              }
            : null,


        lastFiveMinutes:
          data.lastFiveMinutes
            ? {
                transactions:
                  Number(
                    data.lastFiveMinutes
                      .transactions ||
                    0
                  ),

                start:
                  Number(
                    data.lastFiveMinutes
                      .start
                  ),

                end:
                  Number(
                    data.lastFiveMinutes
                      .end
                  )
              }
            : null,


        today:
          data.today ||
          null,

        yesterday:
          data.yesterday ||
          null,

        avgTxPerMinute:
          data.avgTxPerMinute,

        avgTxPerBlock:
          data.avgTxPerBlock,

        tps:
          data.tps,

        sevenDays:
          Array.isArray(
            data.sevenDays
          )
            ? data.sevenDays
            : [],

        dailyAth:
          data.dailyAth ||
          null,

        recordBook:
          data.recordBook ||
          null,

        latestBlock:
          data.latestBlock ||
          null,

        redis:
          redisAvailable()
            ? "connected"
            : "not-configured",


        collector: {
          version:
            3,

          startedAt:
            data.collectorStartedRaw
              ? Number(
                  data.collectorStartedRaw
                )
              : null,

          startedAtIso:
            data.collectorStartedRaw
              ? new Date(
                  Number(
                    data.collectorStartedRaw
                  )
                ).toISOString()
              : null,

          nextMinute:
            data.nextMinuteRaw
              ? Number(
                  data.nextMinuteRaw
                )
              : null,

          nextMinuteIso:
            data.nextMinuteRaw
              ? new Date(
                  Number(
                    data.nextMinuteRaw
                  )
                ).toISOString()
              : null
        },


        generatedAt:
          Date.now()
      });


  } catch (error) {
    console.error(
      "Abstract stats error:",
      error
    );

    return res
      .status(
        500
      )
      .json({
        error:
          "Could not calculate Abstract statistics.",

        detail:
          req.query &&
          req.query.debug ===
            "1"
            ? String(
                error &&
                error.message
                  ? error.message
                  : error
              )
            : undefined
      });
  }
}
