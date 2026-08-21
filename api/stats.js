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
const HOUR_MS = 3_600_000;

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

const RECORD_BOOK_KEY =
  `${PREFIX}:ath:recordBook`;


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


/* =========================
   COLLECT NEW MINUTES
========================= */

async function collectNewMinutes(
  now,
  latestNumber
) {
  if (!redisAvailable()) {
    return {
      processed: 0,
      nextMinute: null
    };
  }

  const currentMinute =
    getMinuteStart(now);

  let nextMinute =
    await initializeCollector(now);

  let processed = 0;

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
    } catch (recordBookError) {
      console.error(
        "Record Book collector error:",
        recordBookError
      );
    }

    nextMinute +=
      MINUTE_MS;

    processed += 1;

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
   READ DAY MINUTES
========================= */

async function getDayValues(
  dayStart
) {
  const dayKey =
    dayKeyFromStart(
      dayStart
    );

  const rawValues =
    await redisCommand([
      "HVALS",
      minuteHashKey(dayKey)
    ]);

  if (
    !Array.isArray(rawValues)
  ) {
    return [];
  }

  const values = [];

  for (const raw of rawValues) {
    try {
      const value =
        JSON.parse(raw);

      if (
        value &&
        Number.isFinite(
          Number(
            value.transactions
          )
        )
      ) {
        values.push(value);
      }

    } catch {
    }
  }

  return values;
}


/* =========================
   CURRENT / PARTIAL DAY
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
    values.length === 0
  ) {
    return null;
  }

  let transactions = 0;
  let blocks = 0;

  let minutes = 0;

  for (const value of values) {
    if (
      Number(value.start) >=
      currentMinuteStart
    ) {
      continue;
    }

    transactions +=
      Number(
        value.transactions || 0
      );

    blocks +=
      Number(
        value.blocks || 0
      );

    minutes += 1;
  }

  if (minutes === 0) {
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

    complete: false,
    partial: true
  };
}


/* =========================
   COMPLETED DAY
========================= */

async function buildCompletedDaySummary(
  dayStart
) {
  const firstFullDayRaw =
    await redisCommand([
      "GET",
      FIRST_FULL_DAY_KEY
    ]);

  const firstFullDay =
    Number(firstFullDayRaw);

  if (
    !Number.isFinite(firstFullDay) ||
    dayStart < firstFullDay
  ) {
    return null;
  }

  const dayKey =
    dayKeyFromStart(
      dayStart
    );

  const cached =
    await redisCommand([
      "GET",
      daySummaryKey(dayKey)
    ]);

  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
    }
  }

  const nextMinuteRaw =
    await redisCommand([
      "GET",
      NEXT_MINUTE_KEY
    ]);

  const nextMinute =
    Number(nextMinuteRaw);

  const dayEnd =
    dayStart +
    DAY_MS;

  if (
    !Number.isFinite(nextMinute) ||
    nextMinute < dayEnd
  ) {
    return null;
  }

  const values =
    await getDayValues(
      dayStart
    );

  let transactions = 0;
  let blocks = 0;

  for (const value of values) {
    transactions +=
      Number(
        value.transactions || 0
      );

    blocks +=
      Number(
        value.blocks || 0
      );
  }

  const summary = {
    date: dayKey,
    transactions,
    blocks,
    minutes: 1440,
    complete: true
  };

  await redisCommand([
    "SET",
    daySummaryKey(dayKey),
    JSON.stringify(summary)
  ]);

  return summary;
}


/* =========================
   SEVEN DAYS
========================= */

async function getSevenDays(now) {
  const todayStart =
    getUtcDayStart(now);

  const days = [];

  for (
    let offset = 7;
    offset >= 1;
    offset--
  ) {
    const dayStart =
      todayStart -
      offset * DAY_MS;

    const summary =
      await buildCompletedDaySummary(
        dayStart
      );

    if (summary) {
      days.push({
        date:
          summary.date,

        transactions:
          summary.transactions
      });
    }
  }

  return days;
}


/* =========================
   DAILY TX ATH
========================= */

async function getDailyAth(now) {
  if (!redisAvailable()) {
    return null;
  }

  const firstFullDayRaw =
    await redisCommand([
      "GET",
      FIRST_FULL_DAY_KEY
    ]);

  const firstFullDay =
    Number(firstFullDayRaw);

  if (
    !Number.isFinite(firstFullDay)
  ) {
    return null;
  }

  const todayStart =
    getUtcDayStart(now);

  const yesterdayStart =
    todayStart -
    DAY_MS;

  if (
    firstFullDay >
      yesterdayStart
  ) {
    return null;
  }

  let record = null;

  const stored =
    await redisCommand([
      "GET",
      DAILY_ATH_KEY
    ]);

  if (stored) {
    try {
      const parsed =
        JSON.parse(stored);

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
        record = parsed;
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
        ) + DAY_MS
      : firstFullDay;

  if (nextDay < firstFullDay) {
    nextDay = firstFullDay;
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
    let dayStart = nextDay;
    dayStart <= yesterdayStart;
    dayStart += DAY_MS
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

  await redisCommand([
    "SET",
    DAILY_ATH_KEY,
    JSON.stringify(record)
  ]);

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
      ) - 1
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
    getUtcDayStart(timestamp);

  const todayStart =
    getUtcDayStart(now);

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


function validRecordBook(value) {
  return Boolean(
    value &&
    typeof value === "object"
  );
}


function updateMinuteRecords(
  recordBook,
  minuteStart,
  transactions
) {
  const tx =
    Number(transactions);

  if (!Number.isFinite(tx)) {
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
      value: tx,
      timestamp: minuteStart
    };
  }

  const tps =
    tx / 60;

  if (
    !recordBook.tps ||
    tps >
      Number(
        recordBook.tps.value
      )
  ) {
    recordBook.tps = {
      value: tps,
      timestamp: minuteStart
    };
  }
}


function updateHourlyRecord(
  recordBook,
  hourStart,
  transactions
) {
  const tx =
    Number(transactions);

  if (!Number.isFinite(tx)) {
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
      value: tx,
      timestamp: hourStart
    };
  }
}


async function buildRecordBookFromHistory(
  now
) {
  if (!redisAvailable()) {
    return null;
  }

  const firstFullDayRaw =
    await redisCommand([
      "GET",
      FIRST_FULL_DAY_KEY
    ]);

  const firstFullDay =
    Number(firstFullDayRaw);

  if (
    !Number.isFinite(
      firstFullDay
    )
  ) {
    return null;
  }

  const currentMinuteStart =
    getMinuteStart(now);

  const todayStart =
    getUtcDayStart(now);

  const recordBook =
    emptyRecordBook();

  let latestStoredMinute =
    null;

  for (
    let dayStart =
      firstFullDay;
    dayStart <=
      todayStart;
    dayStart += DAY_MS
  ) {
    const values =
      await getDayValues(
        dayStart
      );

    const completedMinutes =
      values
        .filter(
          item =>
            item &&
            Number.isFinite(
              Number(
                item.start
              )
            ) &&
            Number(item.start) >=
              firstFullDay &&
            Number(item.start) <
              currentMinuteStart
        )
        .sort(
          (a, b) =>
            Number(a.start) -
            Number(b.start)
        );

    for (
      const item of
        completedMinutes
    ) {
      const minuteStart =
        Number(item.start);

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
    }

    const hours =
      new Map();

    for (
      const item of
        completedMinutes
    ) {
      const minuteStart =
        Number(item.start);

      const hourStart =
        Math.floor(
          minuteStart /
          HOUR_MS
        ) *
        HOUR_MS;

      if (!hours.has(hourStart)) {
        hours.set(
          hourStart,
          {
            minutes: 0,
            transactions: 0
          }
        );
      }

      const hour =
        hours.get(hourStart);

      hour.minutes += 1;
      hour.transactions +=
        Number(
          item.transactions
        ) || 0;
    }

    for (
      const [
        hourStart,
        hour
      ] of hours
    ) {
      if (
        hour.minutes === 60 &&
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

  await redisCommand([
    "SET",
    RECORD_BOOK_KEY,
    JSON.stringify(
      recordBook
    )
  ]);

  return recordBook;
}


async function getStoredRecordBook(
  now
) {
  if (!redisAvailable()) {
    return null;
  }

  const stored =
    await redisCommand([
      "GET",
      RECORD_BOOK_KEY
    ]);

  if (stored) {
    try {
      const parsed =
        JSON.parse(stored);

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

  return await
    buildRecordBookFromHistory(
      now
    );
}


async function updateRecordBookWithMinute(
  minuteStart,
  result
) {
  if (!redisAvailable()) {
    return;
  }

  const stored =
    await redisCommand([
      "GET",
      RECORD_BOOK_KEY
    ]);

  if (!stored) {
    return;
  }

  let recordBook;

  try {
    recordBook =
      JSON.parse(stored);
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
    new Date(minuteStart);

  if (
    minuteDate.getUTCMinutes() ===
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
            Number.isFinite(start) &&
            start >= hourStart &&
            start <
              hourStart +
              HOUR_MS
          );
        }
      );

    if (
      hourValues.length === 60
    ) {
      const transactions =
        hourValues.reduce(
          (
            sum,
            item
          ) =>
            sum +
            (
              Number(
                item.transactions
              ) || 0
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


async function getRecordBook(now) {
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
          Number(item.value)
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
          Number(item.value),

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
    .test(address);
}


async function getDayStartBlock(
  dayStart,
  latestNumber
) {
  const dayKey =
    dayKeyFromStart(
      dayStart
    );

  if (redisAvailable()) {
    const stored =
      await redisCommand([
        "GET",
        dayStartBlockKey(
          dayKey
        )
      ]);

    if (
      stored !== null &&
      stored !== undefined
    ) {
      const parsed =
        Number(stored);

      if (
        Number.isInteger(parsed) &&
        parsed >= 0
      ) {
        return parsed;
      }
    }
  }

  const firstBlock =
    await findFirstBlockAtOrAfter(
      dayStart,
      latestNumber
    );

  if (redisAvailable()) {
    await redisCommand([
      "SET",
      dayStartBlockKey(
        dayKey
      ),
      firstBlock.toString(),
      "EX",
      "172800"
    ]);
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
      firstBlockToday - 1
    );

  const baselineTag =
    "0x" +
    baselineBlock.toString(16);

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
   HANDLER
========================= */

export default async function handler(
  req,
  res
) {
  try {
    const now =
      Date.now();

    const currentMinuteStart =
      getMinuteStart(now);

    const latestHex =
      await rpc(
        "eth_blockNumber"
      );

    const latestNumber =
      Number(
        BigInt(latestHex)
      );


    /*
      =========================
      WALLET TODAY REQUEST
      =========================
    */

    if (
      req.query &&
      typeof req.query.wallet ===
        "string"
    ) {
      const address =
        req.query.wallet.trim();

      if (!isValidAddress(address)) {
        return res
          .status(400)
          .json({
            error:
              "Invalid Abstract address."
          });
      }

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
        .status(200)
        .json({
          address,
          txSentToday,
          dayStart:
            getUtcDayStart(now),
          dayStartIso:
            new Date(
              getUtcDayStart(now)
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
      req.query.refresh === "1"
    ) {
      const collection =
        await collectNewMinutes(
          now,
          latestNumber
        );

      return res
        .status(200)
        .json({
          ok: true,

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
            redisAvailable()
              ? "connected"
              : "not-configured",

          generatedAt:
            Date.now()
        });
    }


    /*
      =========================
      NORMAL WEBSITE REQUEST
      =========================
    */

    const lastMinuteStart =
      currentMinuteStart -
      MINUTE_MS;

    const currentFiveStart =
      getFiveMinuteStart(now);

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


    const todayStart =
      getUtcDayStart(now);


    const today =
      await buildCurrentDaySummary(
        todayStart,
        currentMinuteStart
      );


    const yesterdayStart =
      todayStart -
      DAY_MS;


    const yesterday =
      await buildCompletedDaySummary(
        yesterdayStart
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
      lastMinute.transactions /
      60;


    const sevenDays =
      await getSevenDays(now);


    let dailyAth = null;

    try {
      dailyAth =
        await getDailyAth(now);
    } catch (dailyAthError) {
      console.error(
        "Daily ATH error:",
        dailyAthError
      );
    }


    let recordBook = null;

    try {
      recordBook =
        await getRecordBook(now);
    } catch (recordBookError) {
      console.error(
        "Record Book error:",
        recordBookError
      );
    }


    const collectorStartedRaw =
      redisAvailable()

        ? await redisCommand([
            "GET",
            COLLECTOR_STARTED_KEY
          ])

        : null;


    const nextMinuteRaw =
      redisAvailable()

        ? await redisCommand([
            "GET",
            NEXT_MINUTE_KEY
          ])

        : null;


    res.setHeader(
      "Cache-Control",
      "public, s-maxage=20, stale-while-revalidate=40"
    );


    return res
      .status(200)
      .json({

        lastMinute: {
          transactions:
            lastMinute.transactions,

          start:
            lastMinute.start,

          end:
            lastMinute.end
        },


        lastFiveMinutes: {
          transactions:
            lastFiveMinutes.transactions,

          start:
            lastFiveMinutes.start,

          end:
            lastFiveMinutes.end
        },


        today:
          today || null,

        yesterday:
          yesterday || null,

        avgTxPerMinute,

        avgTxPerBlock,

        tps,

        sevenDays,

        dailyAth,

        recordBook,


        latestBlock:
          latestNumber,


        redis:
          redisAvailable()
            ? "connected"
            : "not-configured",


        collector: {
          version: 3,

          startedAt:
            collectorStartedRaw
              ? Number(
                  collectorStartedRaw
                )
              : null,

          startedAtIso:
            collectorStartedRaw
              ? new Date(
                  Number(
                    collectorStartedRaw
                  )
                ).toISOString()
              : null,

          nextMinute:
            nextMinuteRaw
              ? Number(
                  nextMinuteRaw
                )
              : null,

          nextMinuteIso:
            nextMinuteRaw
              ? new Date(
                  Number(
                    nextMinuteRaw
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
      .status(500)
      .json({
        error:
          "Could not calculate Abstract statistics."
      });
  }
}
