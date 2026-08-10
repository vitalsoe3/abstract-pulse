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

const BACKFILL_MINUTES_PER_REFRESH = 30;
const HISTORY_DAYS = 7;
const BLOCK_FETCH_CONCURRENCY = 8;


/* =========================
   RPC
========================= */

async function rpc(
  method,
  params = []
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      10_000
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


async function getBlock(
  number
) {
  const hex =
    "0x" +
    number.toString(16);

  const block =
    await rpc(
      "eth_getBlockByNumber",
      [
        hex,
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
   REDIS REST
========================= */

function redisAvailable() {
  return Boolean(
    REDIS_URL &&
    REDIS_TOKEN
  );
}


async function redisCommand(
  command
) {
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
          JSON.stringify(
            command
          )
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
   TIME HELPERS
========================= */

function getMinuteStart(
  time
) {
  return (
    Math.floor(
      time /
      MINUTE_MS
    ) *
    MINUTE_MS
  );
}


function getFiveMinuteStart(
  time
) {
  return (
    Math.floor(
      time /
      FIVE_MINUTES_MS
    ) *
    FIVE_MINUTES_MS
  );
}


function getUtcDayStart(
  time
) {
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

    const nextNumber =
      Math.max(
        0,
        lowerNumber - step
      );

    lowerNumber =
      nextNumber;

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

  const firstBlockAfterEnd =
    await findFirstBlockAtOrAfter(
      end,
      latestNumber
    );

  const finalBlock =
    Math.min(
      latestNumber,
      firstBlockAfterEnd -
        1
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

    const numbers = [];

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
      const block of result
    ) {
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
   MINUTE STORAGE
========================= */

function minuteHashKey(
  dayKey
) {
  return (
    `abstract:minutes:${dayKey}`
  );
}


async function readStoredMinute(
  minuteStart
) {
  if (!redisAvailable()) {
    return null;
  }

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

  const value =
    await redisCommand([
      "HGET",
      minuteHashKey(
        dayKey
      ),
      field
    ]);

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(
      value
    );
  } catch {
    return null;
  }
}


async function storeMinute(
  minuteStart,
  value
) {
  if (!redisAvailable()) {
    return;
  }

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

    minuteHashKey(
      dayKey
    ),

    field,

    JSON.stringify(
      value
    )
  ]);
}


async function getOrCreateMinute(
  minuteStart,
  latestNumber
) {
  const stored =
    await readStoredMinute(
      minuteStart
    );

  if (stored) {
    return stored;
  }

  const calculated =
    await calculateInterval(
      minuteStart,

      minuteStart +
        MINUTE_MS,

      latestNumber
    );

  await storeMinute(
    minuteStart,
    calculated
  );

  return calculated;
}


/* =========================
   5-MINUTE STORAGE
========================= */

function fiveMinuteKey(
  start
) {
  return (
    `abstract:five:${start}`
  );
}


async function getOrCreateFiveMinutes(
  start,
  latestNumber
) {
  if (redisAvailable()) {
    const stored =
      await redisCommand([
        "GET",
        fiveMinuteKey(
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

  if (redisAvailable()) {
    await redisCommand([
      "SET",

      fiveMinuteKey(
        start
      ),

      JSON.stringify(
        calculated
      )
    ]);
  }

  return calculated;
}


/* =========================
   DAY SUMMARY
========================= */

async function buildDaySummary(
  dayStart,
  expectedMinutes,
  freezeWhenComplete
) {
  if (!redisAvailable()) {
    return null;
  }

  const dayKey =
    dayKeyFromStart(
      dayStart
    );

  const summaryKey =
    `abstract:day:${dayKey}`;

  if (freezeWhenComplete) {
    const storedSummary =
      await redisCommand([
        "GET",
        summaryKey
      ]);

    if (storedSummary) {
      try {
        return JSON.parse(
          storedSummary
        );
      } catch {
      }
    }
  }

  const minuteCount =
    Number(
      await redisCommand([
        "HLEN",
        minuteHashKey(
          dayKey
        )
      ]) || 0
    );

  if (
    minuteCount <
    expectedMinutes
  ) {
    return null;
  }

  const rawValues =
    await redisCommand([
      "HVALS",
      minuteHashKey(
        dayKey
      )
    ]);

  if (
    !Array.isArray(
      rawValues
    )
  ) {
    return null;
  }

  let transactions = 0;
  let blocks = 0;

  for (
    const raw of rawValues
  ) {
    try {
      const value =
        JSON.parse(
          raw
        );

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

    } catch {
    }
  }

  const summary = {
    date:
      dayKey,

    transactions,

    blocks,

    minutes:
      expectedMinutes,

    complete:
      true
  };

  if (freezeWhenComplete) {
    await redisCommand([
      "SET",

      summaryKey,

      JSON.stringify(
        summary
      )
    ]);
  }

  return summary;
}


/* =========================
   BOUNDED BACKFILL
========================= */

async function backfillHistory(
  now,
  currentMinuteStart,
  latestNumber
) {
  if (!redisAvailable()) {
    return;
  }

  let budget =
    BACKFILL_MINUTES_PER_REFRESH;

  const todayStart =
    getUtcDayStart(
      now
    );

  for (
    let dayOffset = 0;

    dayOffset <=
      HISTORY_DAYS;

    dayOffset++
  ) {
    if (budget <= 0) {
      break;
    }

    const dayStart =
      todayStart -
      dayOffset *
        DAY_MS;

    const dayKey =
      dayKeyFromStart(
        dayStart
      );

    const targetEnd =
      dayOffset === 0
        ? currentMinuteStart
        : dayStart +
          DAY_MS;

    const cursorKey =
      `abstract:backfill:${dayKey}`;

    const storedCursor =
      await redisCommand([
        "GET",
        cursorKey
      ]);

    let cursor =
      storedCursor !== null &&
      storedCursor !== undefined

        ? Number(
            storedCursor
          )

        : dayStart;

    if (
      !Number.isFinite(
        cursor
      ) ||
      cursor < dayStart ||
      cursor > targetEnd
    ) {
      cursor =
        dayStart;
    }

    while (
      budget > 0 &&
      cursor < targetEnd
    ) {
      await getOrCreateMinute(
        cursor,
        latestNumber
      );

      cursor +=
        MINUTE_MS;

      budget -= 1;
    }

    await redisCommand([
      "SET",

      cursorKey,

      cursor.toString()
    ]);
  }
}


/* =========================
   SEVEN COMPLETED DAYS
========================= */

async function getSevenDays(
  now
) {
  if (!redisAvailable()) {
    return [];
  }

  const todayStart =
    getUtcDayStart(
      now
    );

  const days = [];

  for (
    let offset = 7;

    offset >= 1;

    offset--
  ) {
    const dayStart =
      todayStart -
      offset *
        DAY_MS;

    const summary =
      await buildDaySummary(
        dayStart,
        1440,
        true
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
      getMinuteStart(
        now
      );

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


    const latestHex =
      await rpc(
        "eth_blockNumber"
      );

    const latestNumber =
      Number(
        BigInt(
          latestHex
        )
      );


    const lastMinute =
      await getOrCreateMinute(
        lastMinuteStart,
        latestNumber
      );


    const lastFiveMinutes =
      await getOrCreateFiveMinutes(
        lastFiveStart,
        latestNumber
      );


    if (
      req.query &&
      req.query.refresh ===
        "1"
    ) {
      try {
        await backfillHistory(
          now,
          currentMinuteStart,
          latestNumber
        );

      } catch (error) {
        console.warn(
          "Background backfill error:",
          error
        );
      }
    }


    const todayStart =
      getUtcDayStart(
        now
      );

    const completedMinutesToday =
      Math.floor(
        (
          currentMinuteStart -
          todayStart
        ) /
        MINUTE_MS
      );


    const today =
      completedMinutesToday > 0

        ? await buildDaySummary(
            todayStart,
            completedMinutesToday,
            false
          )

        : {
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
              true
          };


    const yesterdayStart =
      todayStart -
      DAY_MS;

    const yesterday =
      await buildDaySummary(
        yesterdayStart,
        1440,
        true
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
      await getSevenDays(
        now
      );


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
          today ||
          null,

        yesterday:
          yesterday ||
          null,

        avgTxPerMinute,

        avgTxPerBlock,

        tps,

        sevenDays,


        latestBlock:
          latestNumber,

        redis:
          redisAvailable()
            ? "connected"
            : "not-configured",

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
