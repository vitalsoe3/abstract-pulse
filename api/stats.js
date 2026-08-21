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

const SNAPSHOT_VERSION = 1;

const MAX_MINUTES_PER_REFRESH = 4;
const BLOCK_FETCH_CONCURRENCY = 8;

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

const SNAPSHOT_KEY =
  `${PREFIX}:dashboard:snapshot:v1`;


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
        BigInt(
          block.number
        )
      ),

    timestamp:
      Number(
        BigInt(
          block.timestamp
        )
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
    let errorText =
      "";

    try {
      errorText =
        await response.text();

    } catch {
      errorText =
        "";
    }

    throw new Error(
      `Redis HTTP ${response.status}${
        errorText
          ? `: ${errorText}`
          : ""
      }`
    );
  }

  const data =
    await response.json();

  if (
    data &&
    data.error
  ) {
    throw new Error(
      `Redis error: ${data.error}`
    );
  }

  return data
    ? data.result
    : null;
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
  return (
    Math.floor(
      time /
      MINUTE_MS
    ) *
    MINUTE_MS
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

    step *=
      2;
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
      transactions:
        0,

      blocks:
        0,

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

    const promises =
      [];

    for (
      let number =
        batchStart;

      number <=
        batchEnd;

      number++
    ) {
      promises.push(
        getBlock(
          number
        )
      );
    }

    const result =
      await Promise.all(
        promises
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
   LEGACY HISTORY
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

  const values =
    [];

  for (
    const raw of
      rawValues
  ) {
    const value =
      parseJson(
        raw
      );

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
      values.push({
        transactions:
          Number(
            value.transactions
          ),

        blocks:
          Number(
            value.blocks ||
            0
          ),

        start:
          Number(
            value.start
          ),

        end:
          Number(
            value.end
          ) ||
          Number(
            value.start
          ) +
          MINUTE_MS
      });
    }
  }

  values.sort(
    (
      a,
      b
    ) =>
      a.start -
      b.start
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


async function readCompletedDaySummary(
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
          1440
        ),

      complete:
        true
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
    date:
      dayKey,

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
      true
  };
}


function buildPartialDaySummary(
  dayStart,
  values
) {
  if (
    !Array.isArray(
      values
    ) ||

    values.length ===
      0
  ) {
    return null;
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

    complete:
      false,

    partial:
      true
  };
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
      hourly:
        null,

      minute:
        null,

      tps:
        null
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

  let changed =
    false;

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

    changed =
      true;
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

    changed =
      true;
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
        recordBook.hourly.value
      )
  ) {
    recordBook.hourly = {
      value:
        tx,

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
  if (!summary) {
    return {
      record:
        current,

      changed:
        false
    };
  }

  const tx =
    Number(
      summary.transactions
    );

  if (
    !Number.isFinite(
      tx
    )
  ) {
    return {
      record:
        current,

      changed:
        false
    };
  }

  const dayStart =
    Date.parse(
      `${summary.date}T00:00:00Z`
    );

  if (
    !Number.isFinite(
      dayStart
    )
  ) {
    return {
      record:
        current,

      changed:
        false
    };
  }

  if (
    !current ||

    tx >
      Number(
        current.transactions
      )
  ) {
    return {
      record: {
        date:
          summary.date,

        transactions:
          tx,

        dayStart
      },

      changed:
        true
    };
  }

  return {
    record:
      current,

    changed:
      false
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
    ) -
    1
  );
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

  let firstFullDay =
    parseStoredNumber(
      firstFullDayRaw
    );

  if (
    firstFullDay ===
    null
  ) {
    const collectorStarted =
      parseStoredNumber(
        collectorStartedRaw
      );

    firstFullDay =
      collectorStarted !==
        null
        ? getUtcDayStart(
            collectorStarted
          ) +
          DAY_MS
        : todayStart;
  }


  /* LAST 7 COMPLETED DAYS */

  const completedDays =
    [];

  const historyStart =
    Math.max(
      firstFullDay,

      todayStart -
        7 *
        DAY_MS
    );

  for (
    let dayStart =
      historyStart;

    dayStart <
      todayStart;

    dayStart +=
      DAY_MS
  ) {
    const summary =
      await readCompletedDaySummary(
        dayStart
      );

    if (summary) {
      completedDays.push(
        summary
      );
    }
  }


  /* TODAY */

  const todayMinutes =
    await readDayMinutes(
      todayStart
    );

  const today =
    buildPartialDaySummary(
      todayStart,
      todayMinutes
    ) || {
      date:
        dayKeyFromStart(
          todayStart
        ),

      transactions:
        0,

      blocks:
        0,

      minutes:
        0,

      complete:
        false,

      partial:
        true
    };


  /* DAILY ATH */

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
      let dayStart =
        firstFullDay;

      dayStart <
        todayStart;

      dayStart +=
        DAY_MS
    ) {
      let summary =
        completedDays.find(
          item =>
            item.date ===
            dayKeyFromStart(
              dayStart
            )
        );

      if (!summary) {
        summary =
          await readCompletedDaySummary(
            dayStart
          );
      }

      const result =
        updateDailyRecord(
          dailyAth,
          summary
        );

      dailyAth =
        result.record;
    }
  }


  /* RECORD BOOK */

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

  const hasRecordBook =
    Boolean(
      recordBook.hourly ||
      recordBook.minute ||
      recordBook.tps
    );

  if (!hasRecordBook) {
    recordBook = {
      hourly:
        null,

      minute:
        null,

      tps:
        null
    };

    for (
      let dayStart =
        firstFullDay;

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
              minutes:
                0,

              transactions:
                0
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
  }


  /* LAST FIVE MINUTES */

  let sourceMinutes =
    todayMinutes;

  if (
    sourceMinutes.length ===
    0
  ) {
    sourceMinutes =
      await readDayMinutes(
        todayStart -
        DAY_MS
      );
  }

  const recentMinutes =
    sourceMinutes
      .slice(-5)
      .map(
        item => ({
          transactions:
            item.transactions,

          blocks:
            item.blocks,

          start:
            item.start,

          end:
            item.end
        })
      );

  const lastMinute =
    recentMinutes.length >
      0
      ? recentMinutes[
          recentMinutes.length -
          1
        ]
      : null;

  const lastFiveMinutes =
    recentMinutes.length >
      0
      ? {
          transactions:
            recentMinutes.reduce(
              (
                sum,
                item
              ) =>
                sum +
                item.transactions,

              0
            ),

          blocks:
            recentMinutes.reduce(
              (
                sum,
                item
              ) =>
                sum +
                item.blocks,

              0
            ),

          start:
            recentMinutes[0]
              .start,

          end:
            recentMinutes[
              recentMinutes.length -
              1
            ].end,

          minutes:
            recentMinutes.length
        }
      : null;


  /* CURRENT HOUR */

  let currentHour =
    null;

  if (lastMinute) {
    const hourStart =
      Math.floor(
        lastMinute.start /
        HOUR_MS
      ) *
      HOUR_MS;

    const sameHour =
      sourceMinutes.filter(
        item =>
          item.start >=
            hourStart &&

          item.start <
            hourStart +
            HOUR_MS
      );

    currentHour = {
      start:
        hourStart,

      minutes:
        sameHour.length,

      transactions:
        sameHour.reduce(
          (
            sum,
            item
          ) =>
            sum +
            item.transactions,

          0
        )
    };
  }


  return {
    version:
      SNAPSHOT_VERSION,

    trackedSince:
      dayKeyFromStart(
        firstFullDay
      ),

    collectorStartedAt:
      parseStoredNumber(
        collectorStartedRaw
      ),

    updatedAt:
      now,

    latestBlock:
      latestNumber,

    today,

    completedDays:
      completedDays.slice(
        -7
      ),

    dailyAth,

    recordBook,

    recentMinutes,

    lastMinute,

    lastFiveMinutes,

    currentHour
  };
}


/* =========================
   SNAPSHOT UPDATE
========================= */

function finalizeCurrentDay(
  snapshot
) {
  if (
    !snapshot.today ||

    Number(
      snapshot.today.minutes
    ) <= 0
  ) {
    return null;
  }

  const summary = {
    date:
      snapshot.today.date,

    transactions:
      Number(
        snapshot.today
          .transactions ||
        0
      ),

    blocks:
      Number(
        snapshot.today.blocks ||
        0
      ),

    minutes:
      Number(
        snapshot.today.minutes ||
        0
      ),

    complete:
      true
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

  snapshot.completedDays.push(
    summary
  );

  snapshot.completedDays =
    snapshot.completedDays
      .sort(
        (
          a,
          b
        ) =>
          String(
            a.date
          ).localeCompare(
            String(
              b.date
            )
          )
      )
      .slice(
        -7
      );

  return summary;
}


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
      )
      .slice(
        -5
      );

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
      snapshot.recentMinutes
        .length -
      1
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
      snapshot.recentMinutes[
        0
      ].start,

    end:
      snapshot.recentMinutes[
        snapshot.recentMinutes
          .length -
        1
      ].end,

    minutes:
      snapshot.recentMinutes
        .length
  };
}


function applyCompletedMinute(
  snapshot,
  minuteStart,
  result
) {
  const changes = {
    dailyAth:
      false,

    recordBook:
      false,

    finalizedDay:
      null
  };

  const minute = {
    transactions:
      Number(
        result.transactions ||
        0
      ),

    blocks:
      Number(
        result.blocks ||
        0
      ),

    start:
      minuteStart,

    end:
      minuteStart +
      MINUTE_MS
  };

  const minuteDayStart =
    getUtcDayStart(
      minuteStart
    );

  const minuteDayKey =
    dayKeyFromStart(
      minuteDayStart
    );

  if (
    !snapshot.today ||

    snapshot.today.date !==
      minuteDayKey
  ) {
    const finalized =
      finalizeCurrentDay(
        snapshot
      );

    if (finalized) {
      changes.finalizedDay =
        finalized;

      const dailyResult =
        updateDailyRecord(
          snapshot.dailyAth,
          finalized
        );

      snapshot.dailyAth =
        dailyResult.record;

      if (
        dailyResult.changed
      ) {
        changes.dailyAth =
          true;
      }
    }

    snapshot.today = {
      date:
        minuteDayKey,

      transactions:
        0,

      blocks:
        0,

      minutes:
        0,

      complete:
        false,

      partial:
        true
    };
  }

  snapshot.today.transactions =
    Number(
      snapshot.today
        .transactions ||
      0
    ) +
    minute.transactions;

  snapshot.today.blocks =
    Number(
      snapshot.today.blocks ||
      0
    ) +
    minute.blocks;

  snapshot.today.minutes =
    Number(
      snapshot.today.minutes ||
      0
    ) +
    1;

  snapshot.recordBook =
    normalizeRecordBook(
      snapshot.recordBook
    );

  if (
    updateMinuteRecord(
      snapshot.recordBook,
      minuteStart,
      minute.transactions
    )
  ) {
    changes.recordBook =
      true;
  }

  const hourStart =
    Math.floor(
      minuteStart /
      HOUR_MS
    ) *
    HOUR_MS;

  if (
    !snapshot.currentHour ||

    Number(
      snapshot.currentHour
        .start
    ) !==
      hourStart
  ) {
    if (
      snapshot.currentHour &&

      Number(
        snapshot.currentHour
          .minutes
      ) ===
        60
    ) {
      if (
        updateHourlyRecord(
          snapshot.recordBook,

          Number(
            snapshot.currentHour
              .start
          ),

          Number(
            snapshot.currentHour
              .transactions
          )
        )
      ) {
        changes.recordBook =
          true;
      }
    }

    snapshot.currentHour = {
      start:
        hourStart,

      minutes:
        0,

      transactions:
        0
    };
  }

  snapshot.currentHour.minutes =
    Number(
      snapshot.currentHour
        .minutes ||
      0
    ) +
    1;

  snapshot.currentHour.transactions =
    Number(
      snapshot.currentHour
        .transactions ||
      0
    ) +
    minute.transactions;

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

  snapshot.recentMinutes.push(
    minute
  );

  recalculateLastFive(
    snapshot
  );

  return changes;
}


/* =========================
   COLLECTOR
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

    JSON.stringify({
      transactions:
        Number(
          result.transactions ||
          0
        ),

      blocks:
        Number(
          result.blocks ||
          0
        ),

      start:
        minuteStart,

      end:
        minuteStart +
        MINUTE_MS
    })
  ]);
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

  const nextMinuteRaw =
    await redisCommand([
      "GET",
      NEXT_MINUTE_KEY
    ]);

  let nextMinute =
    parseStoredNumber(
      nextMinuteRaw
    );

  if (
    nextMinute ===
    null
  ) {
    const snapshotLastStart =
      snapshot.lastMinute &&

      Number.isFinite(
        Number(
          snapshot.lastMinute
            .start
        )
      )
        ? Number(
            snapshot.lastMinute
              .start
          )
        : null;

    nextMinute =
      snapshotLastStart !==
        null
        ? snapshotLastStart +
          MINUTE_MS
        : currentMinute;
  }

  if (
    nextMinute >
    currentMinute
  ) {
    nextMinute =
      currentMinute;
  }

  let processed =
    0;

  let dailyAthChanged =
    false;

  let recordBookChanged =
    false;

  const finalizedDays =
    [];

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

    const changes =
      applyCompletedMinute(
        snapshot,
        nextMinute,
        result
      );

    if (
      changes.dailyAth
    ) {
      dailyAthChanged =
        true;
    }

    if (
      changes.recordBook
    ) {
      recordBookChanged =
        true;
    }

    if (
      changes.finalizedDay
    ) {
      finalizedDays.push(
        changes.finalizedDay
      );
    }

    nextMinute +=
      MINUTE_MS;

    processed +=
      1;
  }

  snapshot.updatedAt =
    now;

  snapshot.latestBlock =
    latestNumber;


  /* DAY SUMMARY WRITE:
     only when a UTC day is finalized.
  */

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


  /* ATH WRITE:
     only when daily record changes.
  */

  if (
    dailyAthChanged &&
    snapshot.dailyAth
  ) {
    await redisCommand([
      "SET",

      DAILY_ATH_KEY,

      JSON.stringify({
        ...snapshot.dailyAth,

        checkedThrough:
          snapshot.dailyAth
            .dayStart
      })
    ]);
  }


  /* RECORD BOOK WRITE:
     only when a record changes.
  */

  if (
    recordBookChanged
  ) {
    await redisCommand([
      "SET",

      RECORD_BOOK_KEY,

      JSON.stringify({
        ...snapshot.recordBook,

        checkedThrough:
          snapshot.lastMinute
            ? snapshot.lastMinute
                .start
            : null
      })
    ]);
  }


  /*
    ONE cursor write per collector run.
    Old version could write it after
    every processed minute.
  */

  await redisCommand([
    "SET",

    NEXT_MINUTE_KEY,

    nextMinute.toString()
  ]);


  /*
    ONE dashboard snapshot write.
  */

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
      snapshot.trackedSince ||
      null
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
    ) >
      0
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
    ) >
      0
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
        .slice(
          -7
        )
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
        3,

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

      startedAtIso:
        Number.isFinite(
          Number(
            snapshot.collectorStartedAt
          )
        )
          ? new Date(
              Number(
                snapshot.collectorStartedAt
              )
            ).toISOString()
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

      snapshotUpdatedAtIso:
        Number.isFinite(
          Number(
            snapshot.updatedAt
          )
        )
          ? new Date(
              Number(
                snapshot.updatedAt
              )
            ).toISOString()
          : null
    },

    generatedAt:
      Date.now()
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
      await redisCommand([
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
      parsed !==
        null &&

      Number.isInteger(
        parsed
      ) &&

      parsed >=
        0
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

    /*
      WALLET REQUEST
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
      QSTASH COLLECTOR
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

          snapshot:
            "updated",

          generatedAt:
            Date.now()
        });
    }


    /*
      NORMAL WEBSITE REQUEST

      After the first snapshot is
      created this performs exactly
      ONE Redis GET.
    */

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
      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      return res
        .status(
          503
        )
        .json({
          error:
            "Dashboard snapshot is not ready.",

          action:
            "Run /api/stats?refresh=1 after Redis requests are available again."
        });
    }

    res.setHeader(
      "Cache-Control",

      "public, s-maxage=60, stale-while-revalidate=120"
    );

    return res
      .status(
        200
      )
      .json(
        snapshotToResponse(
          snapshot,
          now
        )
      );


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
