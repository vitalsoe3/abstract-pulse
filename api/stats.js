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

/* QStash: every 5 minutes */
const MAX_MINUTES_PER_REFRESH = 8;
const MAX_BACKLOG_MINUTES = 30;
const RECOVERY_WINDOW_MINUTES = 5;
const HISTORY_SCAN_DAYS = 60;
const BLOCK_FETCH_CONCURRENCY = 10;

const SNAPSHOT_VERSION = 3;
const SNAPSHOT_KEY = `${PREFIX}:dashboard:snapshot:v3`;

/* Existing historical keys are preserved. */
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
    throw new Error("Redis is not configured.");
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
    let text = "";

    try {
      text = await response.text();
    } catch {
      text = "";
    }

    throw new Error(
      `Redis HTTP ${response.status}${text ? `: ${text}` : ""}`
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


function trackedSinceStart() {
  return Date.parse(`${TRACKED_SINCE}T00:00:00Z`);
}


/* =========================
   BLOCK SEARCH
========================= */

async function findFirstBlockAtOrAfter(
  targetTime,
  latestNumber
) {
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
    lowerNumber = Math.max(
      0,
      lowerNumber - step
    );

    lowerBlock = await getBlock(
      lowerNumber
    );

    if (!lowerBlock) {
      throw new Error(
        "Historical block unavailable"
      );
    }

    step *= 2;
  }

  let left = lowerNumber;
  let right = upperNumber;

  while (left + 1 < right) {
    const middle =
      Math.floor(
        (left + right) / 2
      );

    const block =
      await getBlock(middle);

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
   MINUTE CALCULATION
========================= */

async function calculateMinuteBatch(
  start,
  end,
  latestNumber
) {
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
      end:
        minuteStart +
        MINUTE_MS
    });
  }

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
    return results;
  }

  for (
    let batchStart = firstBlock;
    batchStart <= finalBlock;
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
      let number = batchStart;
      number <= batchEnd;
      number++
    ) {
      promises.push(
        getBlock(number)
      );
    }

    const blocks =
      await Promise.all(
        promises
      );

    for (const block of blocks) {
      if (!block) {
        continue;
      }

      if (
        block.timestamp <
          start ||
        block.timestamp >=
          end
      ) {
        continue;
      }

      const index =
        Math.floor(
          (
            block.timestamp -
            start
          ) /
            MINUTE_MS
        );

      if (
        index < 0 ||
        index >=
          results.length
      ) {
        continue;
      }

      results[
        index
      ].transactions +=
        block.transactions;

      results[
        index
      ].blocks += 1;
    }
  }

  return results;
}


/* =========================
   STORED HISTORY
========================= */

function parseMinuteValues(
  rawValues
) {
  if (
    !Array.isArray(
      rawValues
    )
  ) {
    return [];
  }

  const values = [];

  for (
    const raw of rawValues
  ) {
    const value =
      parseJson(raw);

    if (
      value &&
      Number.isFinite(
        Number(
          value.transactions
        )
      ) &&
      Number.isFinite(
        Number(
          value.start
        )
      )
    ) {
      const start =
        Number(
          value.start
        );

      values.push({
        transactions:
          Number(
            value.transactions
          ),

        blocks:
          Number(
            value.blocks || 0
          ),

        start,

        end:
          Number(
            value.end
          ) ||
          start +
            MINUTE_MS
      });
    }
  }

  values.sort(
    (a, b) =>
      a.start - b.start
  );

  return values;
}


async function readDayMinutes(
  dayStart
) {
  const rawValues =
    await redisCommand([
      "HVALS",
      minuteHashKey(
        dayKeyFromStart(
          dayStart
        )
      )
    ]);

  return parseMinuteValues(
    rawValues
  );
}


async function readDaySummary(
  dayStart
) {
  const dayKey =
    dayKeyFromStart(
      dayStart
    );

  const cachedRaw =
    await redisCommand([
      "GET",
      daySummaryKey(
        dayKey
      )
    ]);

  const cached =
    parseJson(
      cachedRaw
    );

  if (
    cached &&
    Number.isFinite(
      Number(
        cached.transactions
      )
    )
  ) {
    return {
      date:
        cached.date ||
        dayKey,

      transactions:
        Number(
          cached.transactions
        ),

      blocks:
        Number(
          cached.blocks ||
            0
        ),

      minutes:
        Number(
          cached.minutes ||
            0
        ),

      complete:
        cached.complete !==
        false
    };
  }

  const values =
    await readDayMinutes(
      dayStart
    );

  if (
    values.length ===
    0
  ) {
    return null;
  }

  return {
    date: dayKey,

    transactions:
      values.reduce(
        (
          sum,
          item
        ) =>
          sum +
          item.transactions,
        0
      ),

    blocks:
      values.reduce(
        (
          sum,
          item
        ) =>
          sum +
          item.blocks,
        0
      ),

    minutes:
      values.length,

    complete:
      values.length ===
      1440
  };
}


function buildCurrentDaySummary(
  dayStart,
  values
) {
  if (
    !Array.isArray(values) ||
    values.length === 0
  ) {
    return {
      date:
        dayKeyFromStart(
          dayStart
        ),

      transactions: 0,
      blocks: 0,
      minutes: 0,
      complete: false,
      partial: true
    };
  }

  return {
    date:
      dayKeyFromStart(
        dayStart
      ),

    transactions:
      values.reduce(
        (
          sum,
          item
        ) =>
          sum +
          item.transactions,
        0
      ),

    blocks:
      values.reduce(
        (
          sum,
          item
        ) =>
          sum +
          item.blocks,
        0
      ),

    minutes:
      values.length,

    complete: false,
    partial: true
  };
}


async function findRecentCompletedDays(
  todayStart,
  firstFullDay
) {
  const found = [];

  const hardFloor =
    Math.max(
      firstFullDay,
      todayStart -
        HISTORY_SCAN_DAYS *
          DAY_MS,
      trackedSinceStart()
    );

  for (
    let dayStart =
      todayStart -
      DAY_MS;

    dayStart >=
      hardFloor &&
    found.length < 7;

    dayStart -=
      DAY_MS
  ) {
    const summary =
      await readDaySummary(
        dayStart
      );

    if (!summary) {
      continue;
    }

    if (
      summary.complete ||
      Number(
        summary.minutes
      ) === 1440
    ) {
      found.push({
        ...summary,
        complete: true
      });
    }
  }

  found.reverse();

  return found;
}


/* =========================
   RECORD HELPERS
========================= */

function normalizeDailyAth(
  value
) {
  if (!value) {
    return null;
  }

  const transactions =
    Number(
      value.transactions
    );

  const dayStart =
    Number(
      value.dayStart
    );

  if (
    !Number.isFinite(
      transactions
    ) ||
    !Number.isFinite(
      dayStart
    )
  ) {
    return null;
  }

  return {
    date:
      value.date ||
      dayKeyFromStart(
        dayStart
      ),

    transactions,
    dayStart
  };
}


function normalizeRecordItem(
  item
) {
  if (!item) {
    return null;
  }

  const value =
    Number(
      item.value
    );

  const timestamp =
    Number(
      item.timestamp
    );

  if (
    !Number.isFinite(
      value
    ) ||
    !Number.isFinite(
      timestamp
    )
  ) {
    return null;
  }

  return {
    value,
    timestamp
  };
}


function normalizeRecordBook(
  value
) {
  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return {
      hourly: null,
      minute: null,
      tps: null
    };
  }

  return {
    hourly:
      normalizeRecordItem(
        value.hourly
      ),

    minute:
      normalizeRecordItem(
        value.minute
      ),

    tps:
      normalizeRecordItem(
        value.tps
      )
  };
}


function updateMinuteRecord(
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
    return false;
  }

  let changed = false;

  if (
    !recordBook.minute ||
    tx >
      Number(
        recordBook.minute
          .value
      )
  ) {
    recordBook.minute = {
      value: tx,
      timestamp:
        minuteStart
    };

    changed = true;
  }

  const tps =
    tx / 60;

  if (
    !recordBook.tps ||
    tps >
      Number(
        recordBook.tps
          .value
      )
  ) {
    recordBook.tps = {
      value: tps,
      timestamp:
        minuteStart
    };

    changed = true;
  }

  return changed;
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
    return false;
  }

  if (
    !recordBook.hourly ||
    tx >
      Number(
        recordBook.hourly
          .value
      )
  ) {
    recordBook.hourly = {
      value: tx,
      timestamp:
        hourStart
    };

    return true;
  }

  return false;
}


function updateDailyRecord(
  current,
  summary
) {
  if (
    !summary ||
    summary.complete !==
      true
  ) {
    return {
      record: current,
      changed: false
    };
  }

  const transactions =
    Number(
      summary.transactions
    );

  const dayStart =
    Date.parse(
      `${summary.date}T00:00:00Z`
    );

  if (
    !Number.isFinite(
      transactions
    ) ||
    !Number.isFinite(
      dayStart
    )
  ) {
    return {
      record: current,
      changed: false
    };
  }

  if (
    !current ||
    transactions >
      Number(
        current.transactions
      )
  ) {
    return {
      record: {
        date:
          summary.date,

        transactions,

        dayStart
      },

      changed: true
    };
  }

  return {
    record: current,
    changed: false
  };
}


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


function dailyStandingDays(
  dayStart,
  now
) {
  return Math.max(
    0,
    Math.floor(
      (
        getUtcDayStart(
          now
        ) -
        dayStart
      ) /
        DAY_MS
    ) - 1
  );
}


async function reconstructRecordBook(
  startDay,
  todayStart,
  todayMinutes
) {
  const recordBook = {
    hourly: null,
    minute: null,
    tps: null
  };

  const floor =
    Math.max(
      startDay,
      todayStart -
        HISTORY_SCAN_DAYS *
          DAY_MS,
      trackedSinceStart()
    );

  for (
    let dayStart =
      floor;

    dayStart <=
      todayStart;

    dayStart +=
      DAY_MS
  ) {
    const values =
      dayStart ===
      todayStart
        ? todayMinutes
        : await readDayMinutes(
            dayStart
          );

    const hours =
      new Map();

    for (
      const item of
      values
    ) {
      updateMinuteRecord(
        recordBook,
        item.start,
        item.transactions
      );

      const hourStart =
        Math.floor(
          item.start /
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

      hour.minutes += 1;

      hour.transactions +=
        item.transactions;
    }

    for (
      const [
        hourStart,
        hour
      ] of hours
    ) {
      if (
        hour.minutes ===
        60
      ) {
        updateHourlyRecord(
          recordBook,
          hourStart,
          hour.transactions
        );
      }
    }
  }

  return recordBook;
}


/* =========================
   SNAPSHOT HELPERS
========================= */

function recalculateLastFive(
  snapshot
) {
  snapshot.recentMinutes =
    Array.isArray(
      snapshot.recentMinutes
    )
      ? snapshot.recentMinutes
      : [];

  snapshot.recentMinutes =
    snapshot.recentMinutes
      .filter(
        item =>
          item &&
          Number.isFinite(
            Number(
              item.start
            )
          ) &&
          Number.isFinite(
            Number(
              item.transactions
            )
          )
      )
      .sort(
        (a, b) =>
          Number(
            a.start
          ) -
          Number(
            b.start
          )
      )
      .slice(-5);

  if (
    snapshot.recentMinutes
      .length === 0
  ) {
    snapshot.lastMinute =
      null;

    snapshot.lastFiveMinutes =
      null;

    return;
  }

  snapshot.lastMinute =
    snapshot.recentMinutes[
      snapshot
        .recentMinutes
        .length - 1
    ];

  snapshot.lastFiveMinutes = {
    transactions:
      snapshot.recentMinutes
        .reduce(
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
        ),

    blocks:
      snapshot.recentMinutes
        .reduce(
          (
            sum,
            item
          ) =>
            sum +
            Number(
              item.blocks ||
                0
            ),
          0
        ),

    start:
      snapshot
        .recentMinutes[0]
        .start,

    end:
      snapshot
        .recentMinutes[
          snapshot
            .recentMinutes
            .length - 1
        ].end,

    minutes:
      snapshot
        .recentMinutes
        .length
  };
}


function rebuildCurrentHour(
  snapshot,
  dayMinutes
) {
  if (
    !Array.isArray(
      dayMinutes
    ) ||
    dayMinutes.length ===
      0
  ) {
    snapshot.currentHour =
      null;

    return;
  }

  const latest =
    dayMinutes[
      dayMinutes.length - 1
    ];

  const hourStart =
    Math.floor(
      latest.start /
        HOUR_MS
    ) *
    HOUR_MS;

  const hourValues =
    dayMinutes.filter(
      item =>
        item.start >=
          hourStart &&
        item.start <
          hourStart +
            HOUR_MS
    );

  snapshot.currentHour = {
    start:
      hourStart,

    minutes:
      hourValues.length,

    transactions:
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
      )
  };
}


function resetTodayForDay(
  snapshot,
  dayStart
) {
  snapshot.today = {
    date:
      dayKeyFromStart(
        dayStart
      ),

    transactions: 0,
    blocks: 0,
    minutes: 0,
    complete: false,
    partial: true
  };

  snapshot.currentHour =
    null;
}


function finalizeCurrentDay(
  snapshot
) {
  if (!snapshot.today) {
    return {
      summary: null,
      dailyAthChanged:
        false
    };
  }

  /*
    Never turn an outage day into a complete day.
    A full UTC day must contain all 1440 minutes.
  */

  if (
    Number(
      snapshot.today
        .minutes
    ) !== 1440
  ) {
    return {
      summary: null,
      dailyAthChanged:
        false
    };
  }

  const summary = {
    date:
      snapshot.today
        .date,

    transactions:
      Number(
        snapshot.today
          .transactions ||
          0
      ),

    blocks:
      Number(
        snapshot.today
          .blocks ||
          0
      ),

    minutes: 1440,
    complete: true
  };

  snapshot.completedDays =
    Array.isArray(
      snapshot.completedDays
    )
      ? snapshot.completedDays
      : [];

  snapshot.completedDays =
    snapshot.completedDays
      .filter(
        item =>
          item &&
          item.date !==
            summary.date
      );

  snapshot.completedDays
    .push(
      summary
    );

  snapshot.completedDays =
    snapshot.completedDays
      .sort(
        (a, b) =>
          String(
            a.date
          ).localeCompare(
            String(
              b.date
            )
          )
      )
      .slice(-7);

  const dailyUpdate =
    updateDailyRecord(
      snapshot.dailyAth,
      summary
    );

  snapshot.dailyAth =
    dailyUpdate.record;

  return {
    summary,
    dailyAthChanged:
      dailyUpdate.changed
  };
}


function applyCompletedMinute(
  snapshot,
  minute
) {
  const minuteStart =
    Number(
      minute.start
    );

  const minuteDayStart =
    getUtcDayStart(
      minuteStart
    );

  const minuteDayKey =
    dayKeyFromStart(
      minuteDayStart
    );

  let finalized = {
    summary: null,
    dailyAthChanged:
      false
  };

  if (
    !snapshot.today ||
    snapshot.today.date !==
      minuteDayKey
  ) {
    finalized =
      finalizeCurrentDay(
        snapshot
      );

    resetTodayForDay(
      snapshot,
      minuteDayStart
    );
  }

  snapshot.today
    .transactions =
      Number(
        snapshot.today
          .transactions ||
          0
      ) +
      Number(
        minute.transactions ||
          0
      );

  snapshot.today.blocks =
    Number(
      snapshot.today
        .blocks ||
        0
    ) +
    Number(
      minute.blocks ||
        0
    );

  snapshot.today.minutes =
    Number(
      snapshot.today
        .minutes ||
        0
    ) + 1;

  snapshot.recordBook =
    normalizeRecordBook(
      snapshot.recordBook
    );

  let recordBookChanged =
    updateMinuteRecord(
      snapshot.recordBook,
      minuteStart,
      minute.transactions
    );

  const hourStart =
    Math.floor(
      minuteStart /
        HOUR_MS
    ) *
    HOUR_MS;

  if (
    !snapshot.currentHour ||
    Number(
      snapshot
        .currentHour
        .start
    ) !== hourStart
  ) {
    if (
      snapshot.currentHour &&
      Number(
        snapshot
          .currentHour
          .minutes
      ) === 60
    ) {
      recordBookChanged =
        updateHourlyRecord(
          snapshot.recordBook,
          Number(
            snapshot
              .currentHour
              .start
          ),
          Number(
            snapshot
              .currentHour
              .transactions
          )
        ) ||
        recordBookChanged;
    }

    snapshot.currentHour = {
      start: hourStart,
      minutes: 0,
      transactions: 0
    };
  }

  snapshot.currentHour
    .minutes += 1;

  snapshot.currentHour
    .transactions +=
      Number(
        minute.transactions ||
          0
      );

  if (
    new Date(
      minuteStart
    ).getUTCMinutes() ===
      59 &&
    snapshot.currentHour
      .minutes === 60
  ) {
    recordBookChanged =
      updateHourlyRecord(
        snapshot.recordBook,
        hourStart,
        snapshot.currentHour
          .transactions
      ) ||
      recordBookChanged;
  }

  snapshot.recentMinutes =
    Array.isArray(
      snapshot.recentMinutes
    )
      ? snapshot.recentMinutes
      : [];

  snapshot.recentMinutes =
    snapshot.recentMinutes
      .filter(
        item =>
          Number(
            item.start
          ) !==
          minuteStart
      );

  snapshot.recentMinutes
    .push({
      ...minute
    });

  recalculateLastFive(
    snapshot
  );

  return {
    finalizedSummary:
      finalized.summary,

    dailyAthChanged:
      finalized
        .dailyAthChanged,

    recordBookChanged
  };
}


/* =========================
   SNAPSHOT BOOTSTRAP
========================= */

async function bootstrapSnapshot(
  now,
  latestNumber
) {
  const todayStart =
    getUtcDayStart(
      now
    );

  const currentMinute =
    getMinuteStart(
      now
    );

  const firstFullDayRaw =
    await redisCommand([
      "GET",
      FIRST_FULL_DAY_KEY
    ]);

  const collectorStartedRaw =
    await redisCommand([
      "GET",
      COLLECTOR_STARTED_KEY
    ]);

  const legacyNextMinuteRaw =
    await redisCommand([
      "GET",
      NEXT_MINUTE_KEY
    ]);

  const collectorStarted =
    parseStoredNumber(
      collectorStartedRaw
    );

  let firstFullDay =
    parseStoredNumber(
      firstFullDayRaw
    );

  if (
    firstFullDay ===
    null
  ) {
    firstFullDay =
      collectorStarted !==
      null
        ? getUtcDayStart(
            collectorStarted
          ) +
          DAY_MS
        : trackedSinceStart();
  }

  const completedDays =
    await findRecentCompletedDays(
      todayStart,
      firstFullDay
    );

  const todayMinutes =
    await readDayMinutes(
      todayStart
    );

  const today =
    buildCurrentDaySummary(
      todayStart,
      todayMinutes
    );

  const legacyDailyAthRaw =
    await redisCommand([
      "GET",
      DAILY_ATH_KEY
    ]);

  let dailyAth =
    normalizeDailyAth(
      parseJson(
        legacyDailyAthRaw
      )
    );

  if (!dailyAth) {
    for (
      const summary of
      completedDays
    ) {
      const update =
        updateDailyRecord(
          dailyAth,
          summary
        );

      dailyAth =
        update.record;
    }
  }

  const legacyRecordBookRaw =
    await redisCommand([
      "GET",
      RECORD_BOOK_KEY
    ]);

  let recordBook =
    normalizeRecordBook(
      parseJson(
        legacyRecordBookRaw
      )
    );

  if (
    !recordBook.hourly &&
    !recordBook.minute &&
    !recordBook.tps
  ) {
    recordBook =
      await reconstructRecordBook(
        firstFullDay,
        todayStart,
        todayMinutes
      );
  }

  let recentMinutes =
    todayMinutes.slice(
      -5
    );

  if (
    recentMinutes.length ===
      0 &&
    completedDays.length >
      0
  ) {
    const lastStoredDay =
      completedDays[
        completedDays.length -
          1
      ];

    const lastStoredDayStart =
      Date.parse(
        `${lastStoredDay.date}T00:00:00Z`
      );

    const oldMinutes =
      await readDayMinutes(
        lastStoredDayStart
      );

    recentMinutes =
      oldMinutes.slice(
        -5
      );
  }

  const lastStoredMinute =
    recentMinutes.length >
    0
      ? Number(
          recentMinutes[
            recentMinutes.length -
              1
          ].start
        )
      : null;

  const legacyNextMinute =
    parseStoredNumber(
      legacyNextMinuteRaw
    );

  let candidateNextMinute =
    lastStoredMinute !==
    null
      ? lastStoredMinute +
        MINUTE_MS
      : legacyNextMinute;

  const recoveryStart =
    Math.max(
      todayStart,
      currentMinute -
        RECOVERY_WINDOW_MINUTES *
          MINUTE_MS
    );

  let gapRecovery =
    null;

  if (
    candidateNextMinute ===
      null ||
    candidateNextMinute >
      currentMinute
  ) {
    candidateNextMinute =
      recoveryStart;
  }

  const backlogMinutes =
    Math.max(
      0,
      Math.floor(
        (
          currentMinute -
          candidateNextMinute
        ) /
          MINUTE_MS
      )
    );

  if (
    backlogMinutes >
    MAX_BACKLOG_MINUTES
  ) {
    gapRecovery = {
      detectedAt:
        now,

      skippedFrom:
        candidateNextMinute,

      resumedFrom:
        recoveryStart,

      skippedMinutes:
        backlogMinutes -
        RECOVERY_WINDOW_MINUTES
    };

    candidateNextMinute =
      recoveryStart;

    recentMinutes = [];
  }

  const snapshot = {
    version:
      SNAPSHOT_VERSION,

    trackedSince:
      TRACKED_SINCE,

    collectorStartedAt:
      collectorStarted,

    updatedAt:
      now,

    latestBlock:
      latestNumber,

    nextMinute:
      candidateNextMinute,

    today,

    completedDays,

    dailyAth,

    recordBook,

    recentMinutes,

    lastMinute: null,

    lastFiveMinutes:
      null,

    currentHour: null,

    gapRecovery
  };

  recalculateLastFive(
    snapshot
  );

  rebuildCurrentHour(
    snapshot,
    todayMinutes
  );

  return snapshot;
}


/* =========================
   GAP RECOVERY
========================= */

function recoverFromLargeGap(
  snapshot,
  now
) {
  const currentMinute =
    getMinuteStart(
      now
    );

  const todayStart =
    getUtcDayStart(
      now
    );

  let nextMinute =
    parseStoredNumber(
      snapshot.nextMinute
    );

  if (
    nextMinute === null ||
    nextMinute >
      currentMinute
  ) {
    nextMinute =
      currentMinute;
  }

  const backlogMinutes =
    Math.max(
      0,
      Math.floor(
        (
          currentMinute -
          nextMinute
        ) /
          MINUTE_MS
      )
    );

  if (
    backlogMinutes <=
    MAX_BACKLOG_MINUTES
  ) {
    return nextMinute;
  }

  const recoveryStart =
    Math.max(
      todayStart,
      currentMinute -
        RECOVERY_WINDOW_MINUTES *
          MINUTE_MS
    );

  const currentDayKey =
    dayKeyFromStart(
      todayStart
    );

  if (
    !snapshot.today ||
    snapshot.today.date !==
      currentDayKey
  ) {
    /*
      Preserve only genuinely
      complete previous-day data.
    */

    finalizeCurrentDay(
      snapshot
    );

    resetTodayForDay(
      snapshot,
      todayStart
    );
  }

  snapshot.recentMinutes =
    [];

  snapshot.lastMinute =
    null;

  snapshot.lastFiveMinutes =
    null;

  snapshot.currentHour =
    null;

  snapshot.gapRecovery = {
    detectedAt:
      now,

    skippedFrom:
      nextMinute,

    resumedFrom:
      recoveryStart,

    skippedMinutes:
      Math.max(
        0,
        backlogMinutes -
          RECOVERY_WINDOW_MINUTES
      )
  };

  snapshot.nextMinute =
    recoveryStart;

  return recoveryStart;
}


/* =========================
   BATCH MINUTE WRITE
========================= */

async function storeCompletedMinutes(
  minutes
) {
  if (
    !Array.isArray(
      minutes
    ) ||
    minutes.length ===
      0
  ) {
    return;
  }

  const groups =
    new Map();

  for (
    const minute of
    minutes
  ) {
    const minuteStart =
      Number(
        minute.start
      );

    const dayStart =
      getUtcDayStart(
        minuteStart
      );

    const dayKey =
      dayKeyFromStart(
        dayStart
      );

    if (
      !groups.has(
        dayKey
      )
    ) {
      groups.set(
        dayKey,
        []
      );
    }

    groups
      .get(
        dayKey
      )
      .push(
        minute
      );
  }

  for (
    const [
      dayKey,
      dayMinutes
    ] of groups
  ) {
    const command = [
      "HSET",
      minuteHashKey(
        dayKey
      )
    ];

    for (
      const minute of
      dayMinutes
    ) {
      command.push(
        minuteIndexInDay(
          Number(
            minute.start
          )
        ).toString(),

        JSON.stringify({
          transactions:
            Number(
              minute.transactions ||
                0
            ),

          blocks:
            Number(
              minute.blocks ||
                0
            ),

          start:
            Number(
              minute.start
            ),

          end:
            Number(
              minute.end
            )
        })
      );
    }

    await redisCommand(
      command
    );
  }
}


/* =========================
   SNAPSHOT LOAD / COLLECTOR
========================= */

async function getOrBootstrapSnapshot(
  now,
  latestNumber
) {
  const raw =
    await redisCommand([
      "GET",
      SNAPSHOT_KEY
    ]);

  const parsed =
    parseJson(
      raw
    );

  if (
    parsed &&
    Number(
      parsed.version
    ) ===
      SNAPSHOT_VERSION
  ) {
    return parsed;
  }

  const snapshot =
    await bootstrapSnapshot(
      now,
      latestNumber
    );

  await redisCommand([
    "SET",
    SNAPSHOT_KEY,
    JSON.stringify(
      snapshot
    )
  ]);

  return snapshot;
}


async function collectNewMinutes(
  now,
  latestNumber
) {
  const currentMinute =
    getMinuteStart(
      now
    );

  const snapshot =
    await getOrBootstrapSnapshot(
      now,
      latestNumber
    );

  let nextMinute =
    recoverFromLargeGap(
      snapshot,
      now
    );

  const endMinute =
    Math.min(
      currentMinute,
      nextMinute +
        MAX_MINUTES_PER_REFRESH *
          MINUTE_MS
    );

  let processed = 0;

  const finalizedDays =
    [];

  let dailyAthChanged =
    false;

  let recordBookChanged =
    false;

  if (
    nextMinute <
    endMinute
  ) {
    const minutes =
      await calculateMinuteBatch(
        nextMinute,
        endMinute,
        latestNumber
      );

    await storeCompletedMinutes(
      minutes
    );

    for (
      const minute of
      minutes
    ) {
      const result =
        applyCompletedMinute(
          snapshot,
          minute
        );

      if (
        result.finalizedSummary
      ) {
        finalizedDays.push(
          result.finalizedSummary
        );
      }

      dailyAthChanged =
        dailyAthChanged ||
        result
          .dailyAthChanged;

      recordBookChanged =
        recordBookChanged ||
        result
          .recordBookChanged;

      processed += 1;
    }

    nextMinute =
      endMinute;
  }

  for (
    const summary of
    finalizedDays
  ) {
    await redisCommand([
      "SET",
      daySummaryKey(
        summary.date
      ),
      JSON.stringify(
        summary
      )
    ]);
  }

  if (
    dailyAthChanged &&
    snapshot.dailyAth
  ) {
    await redisCommand([
      "SET",
      DAILY_ATH_KEY,
      JSON.stringify(
        snapshot.dailyAth
      )
    ]);
  }

  if (
    recordBookChanged &&
    snapshot.recordBook
  ) {
    await redisCommand([
      "SET",
      RECORD_BOOK_KEY,
      JSON.stringify(
        snapshot.recordBook
      )
    ]);
  }

  snapshot.nextMinute =
    nextMinute;

  snapshot.updatedAt =
    now;

  snapshot.latestBlock =
    latestNumber;

  snapshot.trackedSince =
    TRACKED_SINCE;

  await redisCommand([
    "SET",
    SNAPSHOT_KEY,
    JSON.stringify(
      snapshot
    )
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

function buildPublicDailyAth(
  snapshot,
  now
) {
  const record =
    normalizeDailyAth(
      snapshot.dailyAth
    );

  if (!record) {
    return null;
  }

  return {
    date:
      record.date,

    transactions:
      record.transactions,

    standingDays:
      dailyStandingDays(
        record.dayStart,
        now
      ),

    trackedSince:
      TRACKED_SINCE
  };
}


function buildPublicRecordBook(
  snapshot,
  now
) {
  const recordBook =
    normalizeRecordBook(
      snapshot.recordBook
    );

  const buildItem =
    item => {
      if (!item) {
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


function snapshotToResponse(
  snapshot,
  now
) {
  const today =
    snapshot.today ||
    null;

  const completedDays =
    Array.isArray(
      snapshot.completedDays
    )
      ? snapshot.completedDays
      : [];

  const yesterdayKey =
    dayKeyFromStart(
      getUtcDayStart(
        now
      ) -
        DAY_MS
    );

  const yesterday =
    completedDays.find(
      item =>
        item &&
        item.date ===
          yesterdayKey
    ) ||
    null;

  const avgTxPerMinute =
    today &&
    Number(
      today.minutes
    ) > 0
      ? Number(
          today.transactions
        ) /
        Number(
          today.minutes
        )
      : null;

  const avgTxPerBlock =
    today &&
    Number(
      today.blocks
    ) > 0
      ? Number(
          today.transactions
        ) /
        Number(
          today.blocks
        )
      : null;

  const lastMinute =
    snapshot.lastMinute ||
    null;

  const tps =
    lastMinute &&
    Number.isFinite(
      Number(
        lastMinute
          .transactions
      )
    )
      ? Number(
          lastMinute
            .transactions
        ) /
        60
      : null;

  return {
    lastMinute,

    lastFiveMinutes:
      snapshot.lastFiveMinutes ||
      null,

    today,

    yesterday,

    avgTxPerMinute,

    avgTxPerBlock,

    tps,

    sevenDays:
      completedDays
        .slice(-7)
        .map(
          item => ({
            date:
              item.date,

            transactions:
              Number(
                item.transactions ||
                  0
              )
          })
        ),

    dailyAth:
      buildPublicDailyAth(
        snapshot,
        now
      ),

    recordBook:
      buildPublicRecordBook(
        snapshot,
        now
      ),

    latestBlock:
      Number.isFinite(
        Number(
          snapshot.latestBlock
        )
      )
        ? Number(
            snapshot.latestBlock
          )
        : null,

    redis:
      "connected",

    collector: {
      version:
        SNAPSHOT_VERSION,

      startedAt:
        Number.isFinite(
          Number(
            snapshot.collectorStartedAt
          )
        )
          ? Number(
              snapshot.collectorStartedAt
            )
          : null,

      nextMinute:
        Number.isFinite(
          Number(
            snapshot.nextMinute
          )
        )
          ? Number(
              snapshot.nextMinute
            )
          : null,

      snapshotUpdatedAt:
        Number.isFinite(
          Number(
            snapshot.updatedAt
          )
        )
          ? Number(
              snapshot.updatedAt
            )
          : null,

      gapRecovery:
        snapshot.gapRecovery ||
        null
    },

    generatedAt:
      Date.now()
  };
}


/* =========================
   LIVE FALLBACK
   Works even when Redis quota
   is exhausted.
========================= */

async function buildLiveFallback(
  now
) {
  const currentMinute =
    getMinuteStart(
      now
    );

  const start =
    currentMinute -
    5 *
      MINUTE_MS;

  const latestNumber =
    await getLatestBlockNumber();

  const minutes =
    await calculateMinuteBatch(
      start,
      currentMinute,
      latestNumber
    );

  const lastMinute =
    minutes.length >
    0
      ? minutes[
          minutes.length -
            1
        ]
      : null;

  const lastFiveMinutes =
    minutes.length >
    0
      ? {
          transactions:
            minutes.reduce(
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
            ),

          blocks:
            minutes.reduce(
              (
                sum,
                item
              ) =>
                sum +
                Number(
                  item.blocks ||
                    0
                ),
              0
            ),

          start:
            minutes[0]
              .start,

          end:
            minutes[
              minutes.length -
                1
            ].end,

          minutes:
            minutes.length
        }
      : null;

  return {
    lastMinute,

    lastFiveMinutes,

    today: null,

    yesterday: null,

    avgTxPerMinute:
      null,

    avgTxPerBlock:
      null,

    tps:
      lastMinute &&
      Number.isFinite(
        Number(
          lastMinute
            .transactions
        )
      )
        ? Number(
            lastMinute
              .transactions
          ) /
          60
        : null,

    sevenDays: [],

    dailyAth: null,

    recordBook: null,

    latestBlock:
      latestNumber,

    redis:
      "temporarily-unavailable",

    fallback: true,

    generatedAt:
      Date.now()
  };
}


async function sendLiveFallback(
  res,
  now,
  reason = null
) {
  const fallback =
    await buildLiveFallback(
      now
    );

  res.setHeader(
    "Cache-Control",
    "public, max-age=0, s-maxage=300, stale-while-revalidate=300"
  );

  return res
    .status(200)
    .json({
      ...fallback,

      reason:
        reason ||
        undefined
    });
}


/* =========================
   WALLET TX SENT TODAY
   No Redis usage.
========================= */

function isValidAddress(
  address
) {
  return /^0x[a-fA-F0-9]{40}$/
    .test(
      address
    );
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
    await findFirstBlockAtOrAfter(
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
    baselineBlock.toString(
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
   HANDLER
========================= */

export default async function handler(
  req,
  res
) {
  const now =
    Date.now();

  try {

    /* =====================
       WALLET REQUEST
    ===================== */

    if (
      req.query &&
      typeof req.query
        .wallet ===
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
          .status(400)
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
        .status(200)
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


    /* =====================
       QSTASH COLLECTOR
    ===================== */

    if (
      req.query &&
      req.query
        .refresh ===
        "1"
    ) {
      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      if (
        !redisAvailable()
      ) {
        return res
          .status(503)
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
            "connected",

          snapshot:
            "updated",

          gapRecovery:
            collection.snapshot
              .gapRecovery ||
            null,

          generatedAt:
            Date.now()
        });
    }


    /* =====================
       NORMAL WEBSITE
    ===================== */

    if (
      !redisAvailable()
    ) {
      return sendLiveFallback(
        res,
        now,
        "Redis is not configured."
      );
    }

    try {
      const snapshotRaw =
        await redisCommand([
          "GET",
          SNAPSHOT_KEY
        ]);

      const snapshot =
        parseJson(
          snapshotRaw
        );

      if (
        !snapshot ||
        Number(
          snapshot.version
        ) !==
          SNAPSHOT_VERSION
      ) {
        /*
          Redis may be available
          but snapshot may not exist yet.

          The public site still receives
          working TX/MIN and TX/5 MIN.
        */

        return sendLiveFallback(
          res,
          now,
          "Dashboard snapshot is not ready."
        );
      }

      res.setHeader(
        "Cache-Control",
        "public, max-age=0, s-maxage=300, stale-while-revalidate=300"
      );

      return res
        .status(200)
        .json(
          snapshotToResponse(
            snapshot,
            now
          )
        );

    } catch (
      redisError
    ) {
      /*
        Redis quota exhausted or
        temporarily unavailable.

        Do not break the visible
        live statistics.
      */

      console.warn(
        "Redis unavailable, serving live fallback:",
        redisError
      );

      return sendLiveFallback(
        res,
        now,

        req.query &&
        req.query.debug ===
          "1"
          ? String(
              redisError &&
              redisError.message
                ? redisError.message
                : redisError
            )
          : "Redis temporarily unavailable."
      );
    }

  } catch (error) {
    console.error(
      "Abstract stats error:",
      error
    );

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    return res
      .status(500)
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
