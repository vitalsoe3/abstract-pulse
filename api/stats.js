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
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const PREFIX = "abstract:v3";
const TRACKED_SINCE = "2026-08-12";

/*
  QStash will run every 5 minutes.
  Eight minutes gives the collector room to catch up
  after a delayed invocation without changing Redis cost,
  because minute writes are batched into one HSET command.
*/
const MAX_MINUTES_PER_REFRESH = 8;
const BLOCK_FETCH_CONCURRENCY = 10;

const SNAPSHOT_VERSION = 2;
const SNAPSHOT_KEY = `${PREFIX}:dashboard:snapshot:v2`;

/* Existing keys are kept for migration / recovery. */
const NEXT_MINUTE_KEY = `${PREFIX}:collector:nextMinute`;
const COLLECTOR_STARTED_KEY = `${PREFIX}:collector:startedAt`;
const FIRST_FULL_DAY_KEY = `${PREFIX}:collector:firstFullDay`;
const DAILY_ATH_KEY = `${PREFIX}:ath:daily`;
const RECORD_BOOK_KEY = `${PREFIX}:ath:recordBook`;


/* =========================
   RPC
========================= */

async function rpc(method, params = [], timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1_000_000_000),
        method,
        params
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || "RPC error");
    }

    if (typeof data.result === "undefined") {
      throw new Error("RPC returned no result");
    }

    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}


async function getLatestBlockNumber() {
  const latestHex = await rpc("eth_blockNumber");
  return Number(BigInt(latestHex));
}


async function getBlock(number) {
  const block = await rpc(
    "eth_getBlockByNumber",
    ["0x" + number.toString(16), false]
  );

  if (!block) {
    return null;
  }

  return {
    number: Number(BigInt(block.number)),
    timestamp: Number(BigInt(block.timestamp)) * 1000,
    transactions: Array.isArray(block.transactions)
      ? block.transactions.length
      : 0
  };
}


/* =========================
   REDIS
========================= */

function redisAvailable() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}


async function redisCommand(command) {
  if (!redisAvailable()) {
    return null;
  }

  const response = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) {
    let errorText = "";

    try {
      errorText = await response.text();
    } catch {
      errorText = "";
    }

    throw new Error(
      `Redis HTTP ${response.status}${
        errorText ? `: ${errorText}` : ""
      }`
    );
  }

  const data = await response.json();

  if (data && data.error) {
    throw new Error(`Redis error: ${data.error}`);
  }

  return data ? data.result : null;
}


function parseStoredNumber(value) {
  if (
    value === null ||
    typeof value === "undefined" ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}


function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}


/* =========================
   TIME + KEYS
========================= */

function getMinuteStart(time) {
  return Math.floor(time / MINUTE_MS) * MINUTE_MS;
}


function getUtcDayStart(time) {
  const date = new Date(time);

  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );
}


function dayKeyFromStart(dayStart) {
  return new Date(dayStart).toISOString().slice(0, 10);
}


function minuteIndexInDay(minuteStart) {
  const dayStart = getUtcDayStart(minuteStart);
  return Math.floor((minuteStart - dayStart) / MINUTE_MS);
}


function minuteHashKey(dayKey) {
  return `${PREFIX}:minutes:${dayKey}`;
}


function daySummaryKey(dayKey) {
  return `${PREFIX}:day:${dayKey}`;
}


function dayStartBlockKey(dayKey) {
  return `${PREFIX}:day-start-block:${dayKey}`;
}


function trackedSinceStart() {
  return Date.parse(`${TRACKED_SINCE}T00:00:00Z`);
}


/* =========================
   BLOCK SEARCH
========================= */

async function findFirstBlockAtOrAfter(targetTime, latestNumber) {
  let upperNumber = latestNumber;
  let upperBlock = await getBlock(upperNumber);

  if (!upperBlock) {
    throw new Error("Latest block unavailable");
  }

  if (upperBlock.timestamp < targetTime) {
    return latestNumber + 1;
  }

  let step = 64;
  let lowerNumber = upperNumber;
  let lowerBlock = upperBlock;

  while (
    lowerNumber > 0 &&
    lowerBlock.timestamp >= targetTime
  ) {
    upperNumber = lowerNumber;
    lowerNumber = Math.max(0, lowerNumber - step);
    lowerBlock = await getBlock(lowerNumber);

    if (!lowerBlock) {
      throw new Error("Historical block unavailable");
    }

    step *= 2;
  }

  let left = lowerNumber;
  let right = upperNumber;

  while (left + 1 < right) {
    const middle = Math.floor((left + right) / 2);
    const block = await getBlock(middle);

    if (!block) {
      throw new Error("Block unavailable during search");
    }

    if (block.timestamp < targetTime) {
      left = middle;
    } else {
      right = middle;
    }
  }

  const leftBlock = await getBlock(left);

  if (leftBlock && leftBlock.timestamp >= targetTime) {
    return left;
  }

  return right;
}


/* =========================
   MINUTE BATCH CALCULATION
========================= */

async function calculateMinuteBatch(start, end, latestNumber) {
  if (end <= start) {
    return [];
  }

  const results = [];

  for (
    let minuteStart = start;
    minuteStart < end;
    minuteStart += MINUTE_MS
  ) {
    results.push({
      transactions: 0,
      blocks: 0,
      start: minuteStart,
      end: minuteStart + MINUTE_MS
    });
  }

  const firstBlock = await findFirstBlockAtOrAfter(
    start,
    latestNumber
  );

  const afterEnd = await findFirstBlockAtOrAfter(
    end,
    latestNumber
  );

  const finalBlock = Math.min(latestNumber, afterEnd - 1);

  if (firstBlock > finalBlock) {
    return results;
  }

  for (
    let batchStart = firstBlock;
    batchStart <= finalBlock;
    batchStart += BLOCK_FETCH_CONCURRENCY
  ) {
    const batchEnd = Math.min(
      finalBlock,
      batchStart + BLOCK_FETCH_CONCURRENCY - 1
    );

    const promises = [];

    for (
      let number = batchStart;
      number <= batchEnd;
      number++
    ) {
      promises.push(getBlock(number));
    }

    const blocks = await Promise.all(promises);

    for (const block of blocks) {
      if (!block) {
        continue;
      }

      if (
        block.timestamp < start ||
        block.timestamp >= end
      ) {
        continue;
      }

      const index = Math.floor(
        (block.timestamp - start) / MINUTE_MS
      );

      if (index < 0 || index >= results.length) {
        continue;
      }

      results[index].transactions += block.transactions;
      results[index].blocks += 1;
    }
  }

  return results;
}


/* =========================
   LEGACY HISTORY READS
   Used only while creating a
   snapshot for the first time.
========================= */

function parseMinuteValues(rawValues) {
  if (!Array.isArray(rawValues)) {
    return [];
  }

  const values = [];

  for (const raw of rawValues) {
    const value = parseJson(raw);

    if (
      value &&
      Number.isFinite(Number(value.transactions)) &&
      Number.isFinite(Number(value.start))
    ) {
      const start = Number(value.start);

      values.push({
        transactions: Number(value.transactions),
        blocks: Number(value.blocks || 0),
        start,
        end: Number(value.end) || start + MINUTE_MS
      });
    }
  }

  values.sort((a, b) => a.start - b.start);
  return values;
}


async function readDayMinutes(dayStart) {
  const rawValues = await redisCommand([
    "HVALS",
    minuteHashKey(dayKeyFromStart(dayStart))
  ]);

  return parseMinuteValues(rawValues);
}


async function readCompletedDaySummary(dayStart) {
  const dayKey = dayKeyFromStart(dayStart);

  const cachedRaw = await redisCommand([
    "GET",
    daySummaryKey(dayKey)
  ]);

  const cached = parseJson(cachedRaw);

  if (
    cached &&
    Number.isFinite(Number(cached.transactions))
  ) {
    return {
      date: cached.date || dayKey,
      transactions: Number(cached.transactions),
      blocks: Number(cached.blocks || 0),
      minutes: Number(cached.minutes || 1440),
      complete: true
    };
  }

  const values = await readDayMinutes(dayStart);

  if (values.length === 0) {
    return null;
  }

  return {
    date: dayKey,
    transactions: values.reduce(
      (sum, item) => sum + item.transactions,
      0
    ),
    blocks: values.reduce(
      (sum, item) => sum + item.blocks,
      0
    ),
    minutes: values.length,
    complete: true
  };
}


function buildPartialDaySummary(dayStart, values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  return {
    date: dayKeyFromStart(dayStart),
    transactions: values.reduce(
      (sum, item) => sum + item.transactions,
      0
    ),
    blocks: values.reduce(
      (sum, item) => sum + item.blocks,
      0
    ),
    minutes: values.length,
    complete: false,
    partial: true
  };
}


/* =========================
   RECORD HELPERS
========================= */

function normalizeDailyAth(value) {
  if (!value) {
    return null;
  }

  const transactions = Number(value.transactions);
  const dayStart = Number(value.dayStart);

  if (
    !Number.isFinite(transactions) ||
    !Number.isFinite(dayStart)
  ) {
    return null;
  }

  return {
    date: value.date || dayKeyFromStart(dayStart),
    transactions,
    dayStart
  };
}


function normalizeRecordItem(item) {
  if (!item) {
    return null;
  }

  const value = Number(item.value);
  const timestamp = Number(item.timestamp);

  if (
    !Number.isFinite(value) ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }

  return {
    value,
    timestamp
  };
}


function normalizeRecordBook(value) {
  if (!value || typeof value !== "object") {
    return {
      hourly: null,
      minute: null,
      tps: null
    };
  }

  return {
    hourly: normalizeRecordItem(value.hourly),
    minute: normalizeRecordItem(value.minute),
    tps: normalizeRecordItem(value.tps)
  };
}


function updateMinuteRecord(recordBook, minuteStart, transactions) {
  const tx = Number(transactions);

  if (!Number.isFinite(tx)) {
    return;
  }

  if (
    !recordBook.minute ||
    tx > Number(recordBook.minute.value)
  ) {
    recordBook.minute = {
      value: tx,
      timestamp: minuteStart
    };
  }

  const tps = tx / 60;

  if (
    !recordBook.tps ||
    tps > Number(recordBook.tps.value)
  ) {
    recordBook.tps = {
      value: tps,
      timestamp: minuteStart
    };
  }
}


function updateHourlyRecord(recordBook, hourStart, transactions) {
  const tx = Number(transactions);

  if (!Number.isFinite(tx)) {
    return;
  }

  if (
    !recordBook.hourly ||
    tx > Number(recordBook.hourly.value)
  ) {
    recordBook.hourly = {
      value: tx,
      timestamp: hourStart
    };
  }
}


function updateDailyRecord(current, summary) {
  if (!summary) {
    return current;
  }

  const transactions = Number(summary.transactions);
  const dayStart = Date.parse(`${summary.date}T00:00:00Z`);

  if (
    !Number.isFinite(transactions) ||
    !Number.isFinite(dayStart)
  ) {
    return current;
  }

  if (
    !current ||
    transactions > Number(current.transactions)
  ) {
    return {
      date: summary.date,
      transactions,
      dayStart
    };
  }

  return current;
}


function recordStandingDays(timestamp, now) {
  const recordDayStart = getUtcDayStart(timestamp);
  const todayStart = getUtcDayStart(now);

  return Math.max(
    0,
    Math.floor((todayStart - recordDayStart) / DAY_MS)
  );
}


function dailyStandingDays(dayStart, now) {
  return Math.max(
    0,
    Math.floor(
      (getUtcDayStart(now) - dayStart) / DAY_MS
    ) - 1
  );
}


/* =========================
   SNAPSHOT BOOTSTRAP
========================= */

async function bootstrapSnapshot(now, latestNumber) {
  const todayStart = getUtcDayStart(now);
  const currentMinute = getMinuteStart(now);

  const firstFullDayRaw = await redisCommand([
    "GET",
    FIRST_FULL_DAY_KEY
  ]);

  const collectorStartedRaw = await redisCommand([
    "GET",
    COLLECTOR_STARTED_KEY
  ]);

  const legacyNextMinuteRaw = await redisCommand([
    "GET",
    NEXT_MINUTE_KEY
  ]);

  let firstFullDay = parseStoredNumber(firstFullDayRaw);

  if (firstFullDay === null) {
    const collectorStarted = parseStoredNumber(
      collectorStartedRaw
    );

    firstFullDay = collectorStarted !== null
      ? getUtcDayStart(collectorStarted) + DAY_MS
      : todayStart;
  }

  /* Last seven completed UTC days. */
  const completedDays = [];
  const historyStart = Math.max(
    firstFullDay,
    todayStart - 7 * DAY_MS
  );

  for (
    let dayStart = historyStart;
    dayStart < todayStart;
    dayStart += DAY_MS
  ) {
    const summary = await readCompletedDaySummary(dayStart);

    if (summary) {
      completedDays.push(summary);
    }
  }

  /* Current UTC day. */
  const todayMinutes = await readDayMinutes(todayStart);

  const today = buildPartialDaySummary(
    todayStart,
    todayMinutes
  ) || {
    date: dayKeyFromStart(todayStart),
    transactions: 0,
    blocks: 0,
    minutes: 0,
    complete: false,
    partial: true
  };

  /* Daily ATH: use existing record first. */
  const legacyDailyAthRaw = await redisCommand([
    "GET",
    DAILY_ATH_KEY
  ]);

  let dailyAth = normalizeDailyAth(
    parseJson(legacyDailyAthRaw)
  );

  if (!dailyAth) {
    for (
      let dayStart = firstFullDay;
      dayStart < todayStart;
      dayStart += DAY_MS
    ) {
      let summary = completedDays.find(
        item => item.date === dayKeyFromStart(dayStart)
      );

      if (!summary) {
        summary = await readCompletedDaySummary(dayStart);
      }

      dailyAth = updateDailyRecord(dailyAth, summary);
    }
  }

  /* Record Book: use existing record first. */
  const legacyRecordBookRaw = await redisCommand([
    "GET",
    RECORD_BOOK_KEY
  ]);

  let recordBook = normalizeRecordBook(
    parseJson(legacyRecordBookRaw)
  );

  const hasRecordBook = Boolean(
    recordBook.hourly ||
    recordBook.minute ||
    recordBook.tps
  );

  if (!hasRecordBook) {
    recordBook = {
      hourly: null,
      minute: null,
      tps: null
    };

    const recordStart = Math.min(
      firstFullDay,
      trackedSinceStart()
    );

    for (
      let dayStart = recordStart;
      dayStart <= todayStart;
      dayStart += DAY_MS
    ) {
      const values = dayStart === todayStart
        ? todayMinutes
        : await readDayMinutes(dayStart);

      const hours = new Map();

      for (const item of values) {
        updateMinuteRecord(
          recordBook,
          item.start,
          item.transactions
        );

        const hourStart =
          Math.floor(item.start / HOUR_MS) * HOUR_MS;

        if (!hours.has(hourStart)) {
          hours.set(hourStart, {
            minutes: 0,
            transactions: 0
          });
        }

        const hour = hours.get(hourStart);
        hour.minutes += 1;
        hour.transactions += item.transactions;
      }

      for (const [hourStart, hour] of hours) {
        if (hour.minutes === 60) {
          updateHourlyRecord(
            recordBook,
            hourStart,
            hour.transactions
          );
        }
      }
    }
  }

  /* Recent stored minutes for TX/MIN and TX/5 MIN. */
  let recentSource = todayMinutes;

  if (recentSource.length === 0) {
    recentSource = await readDayMinutes(todayStart - DAY_MS);
  }

  const recentMinutes = recentSource
    .slice(-5)
    .map(item => ({ ...item }));

  const lastMinute = recentMinutes.length > 0
    ? recentMinutes[recentMinutes.length - 1]
    : null;

  let nextMinute = null;

  if (lastMinute) {
    nextMinute = lastMinute.start + MINUTE_MS;
  } else {
    const legacyNextMinute = parseStoredNumber(
      legacyNextMinuteRaw
    );

    nextMinute = legacyNextMinute !== null
      ? Math.min(legacyNextMinute, currentMinute)
      : currentMinute;
  }

  const snapshot = {
    version: SNAPSHOT_VERSION,
    trackedSince: TRACKED_SINCE,
    collectorStartedAt: parseStoredNumber(
      collectorStartedRaw
    ),
    updatedAt: now,
    latestBlock: latestNumber,
    nextMinute,
    today,
    completedDays: completedDays.slice(-7),
    dailyAth,
    recordBook,
    recentMinutes,
    lastMinute: null,
    lastFiveMinutes: null,
    currentHour: null
  };

  recalculateLastFive(snapshot);
  rebuildCurrentHourFromRecentDay(
    snapshot,
    todayMinutes
  );

  return snapshot;
}


/* =========================
   SNAPSHOT UPDATE HELPERS
========================= */

function recalculateLastFive(snapshot) {
  snapshot.recentMinutes = Array.isArray(
    snapshot.recentMinutes
  )
    ? snapshot.recentMinutes
    : [];

  snapshot.recentMinutes = snapshot.recentMinutes
    .filter(item =>
      item &&
      Number.isFinite(Number(item.start)) &&
      Number.isFinite(Number(item.transactions))
    )
    .sort((a, b) => Number(a.start) - Number(b.start))
    .slice(-5);

  if (snapshot.recentMinutes.length === 0) {
    snapshot.lastMinute = null;
    snapshot.lastFiveMinutes = null;
    return;
  }

  snapshot.lastMinute =
    snapshot.recentMinutes[
      snapshot.recentMinutes.length - 1
    ];

  snapshot.lastFiveMinutes = {
    transactions: snapshot.recentMinutes.reduce(
      (sum, item) => sum + Number(item.transactions || 0),
      0
    ),
    blocks: snapshot.recentMinutes.reduce(
      (sum, item) => sum + Number(item.blocks || 0),
      0
    ),
    start: snapshot.recentMinutes[0].start,
    end:
      snapshot.recentMinutes[
        snapshot.recentMinutes.length - 1
      ].end,
    minutes: snapshot.recentMinutes.length
  };
}


function rebuildCurrentHourFromRecentDay(snapshot, dayMinutes) {
  if (!Array.isArray(dayMinutes) || dayMinutes.length === 0) {
    snapshot.currentHour = null;
    return;
  }

  const latest = dayMinutes[dayMinutes.length - 1];
  const hourStart =
    Math.floor(latest.start / HOUR_MS) * HOUR_MS;

  const hourValues = dayMinutes.filter(
    item =>
      item.start >= hourStart &&
      item.start < hourStart + HOUR_MS
  );

  snapshot.currentHour = {
    start: hourStart,
    minutes: hourValues.length,
    transactions: hourValues.reduce(
      (sum, item) => sum + Number(item.transactions || 0),
      0
    )
  };
}


function finalizeCurrentDay(snapshot) {
  if (
    !snapshot.today ||
    Number(snapshot.today.minutes) <= 0
  ) {
    return null;
  }

  const summary = {
    date: snapshot.today.date,
    transactions: Number(snapshot.today.transactions || 0),
    blocks: Number(snapshot.today.blocks || 0),
    minutes: Number(snapshot.today.minutes || 0),
    complete: true
  };

  snapshot.completedDays = Array.isArray(
    snapshot.completedDays
  )
    ? snapshot.completedDays
    : [];

  snapshot.completedDays = snapshot.completedDays
    .filter(item => item && item.date !== summary.date);

  snapshot.completedDays.push(summary);

  snapshot.completedDays = snapshot.completedDays
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-7);

  snapshot.dailyAth = updateDailyRecord(
    snapshot.dailyAth,
    summary
  );

  return summary;
}


function applyCompletedMinute(snapshot, minute) {
  const minuteStart = Number(minute.start);
  const minuteDayStart = getUtcDayStart(minuteStart);
  const minuteDayKey = dayKeyFromStart(minuteDayStart);

  let finalizedDay = null;

  if (
    !snapshot.today ||
    snapshot.today.date !== minuteDayKey
  ) {
    finalizedDay = finalizeCurrentDay(snapshot);

    snapshot.today = {
      date: minuteDayKey,
      transactions: 0,
      blocks: 0,
      minutes: 0,
      complete: false,
      partial: true
    };

    snapshot.currentHour = null;
  }

  snapshot.today.transactions =
    Number(snapshot.today.transactions || 0) +
    Number(minute.transactions || 0);

  snapshot.today.blocks =
    Number(snapshot.today.blocks || 0) +
    Number(minute.blocks || 0);

  snapshot.today.minutes =
    Number(snapshot.today.minutes || 0) + 1;

  snapshot.recordBook = normalizeRecordBook(
    snapshot.recordBook
  );

  updateMinuteRecord(
    snapshot.recordBook,
    minuteStart,
    minute.transactions
  );

  const hourStart =
    Math.floor(minuteStart / HOUR_MS) * HOUR_MS;

  if (
    !snapshot.currentHour ||
    Number(snapshot.currentHour.start) !== hourStart
  ) {
    if (
      snapshot.currentHour &&
      Number(snapshot.currentHour.minutes) === 60
    ) {
      updateHourlyRecord(
        snapshot.recordBook,
        Number(snapshot.currentHour.start),
        Number(snapshot.currentHour.transactions)
      );
    }

    snapshot.currentHour = {
      start: hourStart,
      minutes: 0,
      transactions: 0
    };
  }

  snapshot.currentHour.minutes += 1;
  snapshot.currentHour.transactions +=
    Number(minute.transactions || 0);

  /* Minute 59 completes the UTC hour. */
  if (
    new Date(minuteStart).getUTCMinutes() === 59 &&
    snapshot.currentHour.minutes === 60
  ) {
    updateHourlyRecord(
      snapshot.recordBook,
      hourStart,
      snapshot.currentHour.transactions
    );
  }

  snapshot.recentMinutes = Array.isArray(
    snapshot.recentMinutes
  )
    ? snapshot.recentMinutes
    : [];

  snapshot.recentMinutes = snapshot.recentMinutes.filter(
    item => Number(item.start) !== minuteStart
  );

  snapshot.recentMinutes.push({ ...minute });
  recalculateLastFive(snapshot);

  return finalizedDay;
}


/* =========================
   BATCH REDIS MINUTE WRITE
   One HSET command per UTC day,
   even when 5-8 minutes are stored.
========================= */

async function storeCompletedMinutes(minutes) {
  if (!Array.isArray(minutes) || minutes.length === 0) {
    return;
  }

  const groups = new Map();

  for (const minute of minutes) {
    const minuteStart = Number(minute.start);
    const dayStart = getUtcDayStart(minuteStart);
    const dayKey = dayKeyFromStart(dayStart);

    if (!groups.has(dayKey)) {
      groups.set(dayKey, []);
    }

    groups.get(dayKey).push(minute);
  }

  for (const [dayKey, dayMinutes] of groups) {
    const command = [
      "HSET",
      minuteHashKey(dayKey)
    ];

    for (const minute of dayMinutes) {
      command.push(
        minuteIndexInDay(Number(minute.start)).toString(),
        JSON.stringify({
          transactions: Number(minute.transactions || 0),
          blocks: Number(minute.blocks || 0),
          start: Number(minute.start),
          end: Number(minute.end)
        })
      );
    }

    await redisCommand(command);
  }
}


/* =========================
   SNAPSHOT LOAD / COLLECTOR
========================= */

async function getOrBootstrapSnapshot(now, latestNumber) {
  const raw = await redisCommand([
    "GET",
    SNAPSHOT_KEY
  ]);

  const parsed = parseJson(raw);

  if (
    parsed &&
    Number(parsed.version) === SNAPSHOT_VERSION
  ) {
    return parsed;
  }

  const snapshot = await bootstrapSnapshot(
    now,
    latestNumber
  );

  await redisCommand([
    "SET",
    SNAPSHOT_KEY,
    JSON.stringify(snapshot)
  ]);

  return snapshot;
}


async function collectNewMinutes(now, latestNumber) {
  const currentMinute = getMinuteStart(now);

  const snapshot = await getOrBootstrapSnapshot(
    now,
    latestNumber
  );

  let nextMinute = parseStoredNumber(snapshot.nextMinute);

  if (nextMinute === null) {
    nextMinute = currentMinute;
  }

  if (nextMinute > currentMinute) {
    nextMinute = currentMinute;
  }

  const endMinute = Math.min(
    currentMinute,
    nextMinute + MAX_MINUTES_PER_REFRESH * MINUTE_MS
  );

  let processed = 0;
  const finalizedDays = [];

  if (nextMinute < endMinute) {
    const minutes = await calculateMinuteBatch(
      nextMinute,
      endMinute,
      latestNumber
    );

    /*
      Historical minute storage is one batched HSET
      for the normal 5-minute run.
    */
    await storeCompletedMinutes(minutes);

    for (const minute of minutes) {
      const finalized = applyCompletedMinute(
        snapshot,
        minute
      );

      if (finalized) {
        finalizedDays.push(finalized);
      }

      processed += 1;
    }

    nextMinute = endMinute;
  }

  /* One tiny day-summary write only at UTC day rollover. */
  for (const summary of finalizedDays) {
    await redisCommand([
      "SET",
      daySummaryKey(summary.date),
      JSON.stringify(summary)
    ]);
  }

  snapshot.nextMinute = nextMinute;
  snapshot.updatedAt = now;
  snapshot.latestBlock = latestNumber;
  snapshot.trackedSince = TRACKED_SINCE;

  /*
    This is the single source of truth for the website.
    No separate cursor / ATH / Record Book writes are
    needed on every collector run.
  */
  await redisCommand([
    "SET",
    SNAPSHOT_KEY,
    JSON.stringify(snapshot)
  ]);

  return {
    processed,
    nextMinute,
    snapshot
  };
}


/* =========================
   PUBLIC SNAPSHOT
========================= */

function buildPublicDailyAth(snapshot, now) {
  const record = normalizeDailyAth(snapshot.dailyAth);

  if (!record) {
    return null;
  }

  return {
    date: record.date,
    transactions: record.transactions,
    standingDays: dailyStandingDays(record.dayStart, now),
    trackedSince: TRACKED_SINCE
  };
}


function buildPublicRecordBook(snapshot, now) {
  const recordBook = normalizeRecordBook(
    snapshot.recordBook
  );

  const buildItem = item => {
    if (!item) {
      return null;
    }

    return {
      value: Number(item.value),
      timestamp: Number(item.timestamp),
      standingDays: recordStandingDays(
        Number(item.timestamp),
        now
      )
    };
  };

  return {
    hourly: buildItem(recordBook.hourly),
    minute: buildItem(recordBook.minute),
    tps: buildItem(recordBook.tps)
  };
}


function snapshotToResponse(snapshot, now) {
  const today = snapshot.today || null;

  const completedDays = Array.isArray(
    snapshot.completedDays
  )
    ? snapshot.completedDays
    : [];

  const yesterdayKey = dayKeyFromStart(
    getUtcDayStart(now) - DAY_MS
  );

  const yesterday = completedDays.find(
    item => item && item.date === yesterdayKey
  ) || null;

  const avgTxPerMinute =
    today && Number(today.minutes) > 0
      ? Number(today.transactions) / Number(today.minutes)
      : null;

  const avgTxPerBlock =
    today && Number(today.blocks) > 0
      ? Number(today.transactions) / Number(today.blocks)
      : null;

  const lastMinute = snapshot.lastMinute || null;

  const tps =
    lastMinute &&
    Number.isFinite(Number(lastMinute.transactions))
      ? Number(lastMinute.transactions) / 60
      : null;

  return {
    lastMinute,
    lastFiveMinutes: snapshot.lastFiveMinutes || null,
    today,
    yesterday,
    avgTxPerMinute,
    avgTxPerBlock,
    tps,
    sevenDays: completedDays
      .slice(-7)
      .map(item => ({
        date: item.date,
        transactions: Number(item.transactions || 0)
      })),
    dailyAth: buildPublicDailyAth(snapshot, now),
    recordBook: buildPublicRecordBook(snapshot, now),
    latestBlock: Number.isFinite(Number(snapshot.latestBlock))
      ? Number(snapshot.latestBlock)
      : null,
    redis: "connected",
    collector: {
      version: SNAPSHOT_VERSION,
      startedAt: Number.isFinite(
        Number(snapshot.collectorStartedAt)
      )
        ? Number(snapshot.collectorStartedAt)
        : null,
      startedAtIso: Number.isFinite(
        Number(snapshot.collectorStartedAt)
      )
        ? new Date(
            Number(snapshot.collectorStartedAt)
          ).toISOString()
        : null,
      nextMinute: Number.isFinite(Number(snapshot.nextMinute))
        ? Number(snapshot.nextMinute)
        : null,
      nextMinuteIso: Number.isFinite(Number(snapshot.nextMinute))
        ? new Date(Number(snapshot.nextMinute)).toISOString()
        : null,
      snapshotUpdatedAt: Number.isFinite(
        Number(snapshot.updatedAt)
      )
        ? Number(snapshot.updatedAt)
        : null,
      snapshotUpdatedAtIso: Number.isFinite(
        Number(snapshot.updatedAt)
      )
        ? new Date(Number(snapshot.updatedAt)).toISOString()
        : null
    },
    generatedAt: Date.now()
  };
}


/* =========================
   WALLET TX SENT TODAY
========================= */

function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}


async function getDayStartBlock(dayStart, latestNumber) {
  const dayKey = dayKeyFromStart(dayStart);

  if (redisAvailable()) {
    const stored = await redisCommand([
      "GET",
      dayStartBlockKey(dayKey)
    ]);

    const parsed = parseStoredNumber(stored);

    if (
      parsed !== null &&
      Number.isInteger(parsed) &&
      parsed >= 0
    ) {
      return parsed;
    }
  }

  const firstBlock = await findFirstBlockAtOrAfter(
    dayStart,
    latestNumber
  );

  if (redisAvailable()) {
    await redisCommand([
      "SET",
      dayStartBlockKey(dayKey),
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
  const dayStart = getUtcDayStart(now);

  const firstBlockToday = await getDayStartBlock(
    dayStart,
    latestNumber
  );

  const baselineBlock = Math.max(0, firstBlockToday - 1);
  const baselineTag = "0x" + baselineBlock.toString(16);

  const [startNonceHex, latestNonceHex] = await Promise.all([
    rpc(
      "eth_getTransactionCount",
      [address, baselineTag]
    ),
    rpc(
      "eth_getTransactionCount",
      [address, "latest"]
    )
  ]);

  const startNonce = BigInt(startNonceHex);
  const latestNonce = BigInt(latestNonceHex);

  const difference = latestNonce >= startNonce
    ? latestNonce - startNonce
    : 0n;

  return Number(difference);
}


/* =========================
   HANDLER
========================= */

export default async function handler(req, res) {
  const now = Date.now();

  try {
    /* WALLET REQUEST */
    if (
      req.query &&
      typeof req.query.wallet === "string"
    ) {
      const address = req.query.wallet.trim();

      if (!isValidAddress(address)) {
        return res.status(400).json({
          error: "Invalid Abstract address."
        });
      }

      const latestNumber = await getLatestBlockNumber();

      const txSentToday = await getWalletTxSentToday(
        address,
        now,
        latestNumber
      );

      res.setHeader(
        "Cache-Control",
        "private, no-store"
      );

      return res.status(200).json({
        address,
        txSentToday,
        dayStart: getUtcDayStart(now),
        dayStartIso: new Date(
          getUtcDayStart(now)
        ).toISOString(),
        latestBlock: latestNumber,
        generatedAt: Date.now()
      });
    }


    /* QSTASH COLLECTOR */
    if (
      req.query &&
      req.query.refresh === "1"
    ) {
      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      if (!redisAvailable()) {
        return res.status(503).json({
          error: "Redis is not configured."
        });
      }

      const latestNumber = await getLatestBlockNumber();

      const collection = await collectNewMinutes(
        now,
        latestNumber
      );

      return res.status(200).json({
        ok: true,
        mode: "collector",
        processedMinutes: collection.processed,
        nextMinute: collection.nextMinute,
        nextMinuteIso: collection.nextMinute
          ? new Date(collection.nextMinute).toISOString()
          : null,
        latestBlock: latestNumber,
        redis: "connected",
        snapshot: "updated",
        generatedAt: Date.now()
      });
    }


    /* NORMAL WEBSITE REQUEST */
    if (!redisAvailable()) {
      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      return res.status(503).json({
        error: "Redis is not configured."
      });
    }

    /*
      One Redis command on an origin cache miss.
      Vercel then shares this response for 5 minutes.
    */
    const snapshotRaw = await redisCommand([
      "GET",
      SNAPSHOT_KEY
    ]);

    const snapshot = parseJson(snapshotRaw);

    if (
      !snapshot ||
      Number(snapshot.version) !== SNAPSHOT_VERSION
    ) {
      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      return res.status(503).json({
        error: "Dashboard snapshot is not ready.",
        action:
          "Run /api/stats?refresh=1 after Redis requests are available again."
      });
    }

    /*
      Browser revalidates, but Vercel's shared cache keeps
      the same response for 5 minutes and may serve stale
      for another 5 minutes while refreshing in background.
    */
    res.setHeader(
      "Cache-Control",
      "public, max-age=0, s-maxage=300, stale-while-revalidate=300"
    );

    return res.status(200).json(
      snapshotToResponse(snapshot, now)
    );

  } catch (error) {
    console.error("Abstract stats error:", error);

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    return res.status(500).json({
      error: "Could not calculate Abstract statistics.",
      detail:
        req.query && req.query.debug === "1"
          ? String(
              error && error.message
                ? error.message
                : error
            )
          : undefined
    });
  }
}
